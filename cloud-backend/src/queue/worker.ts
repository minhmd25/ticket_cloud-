import type { Pool } from 'pg';
import { withTransaction } from '../db';
import { randomizePreSale } from './service';

export interface QueueTickResult {
  events: number;
  admitted: number;
  expired: number;
  dropped: number;
}

/**
 * Tiến trình ngầm của hàng chờ (giống worker outbox). Mỗi nhịp, với từng sự kiện đã tới giờ mở bán:
 *  1. xếp ngẫu nhiên những người vào trước giờ mở bán (một lần)
 *  2. ADMITTED quá hạn => EXPIRED (nhả chỗ)
 *  3. WAITING không hỏi lại quá QUEUE_STALE_SECONDS => EXPIRED (coi như đã bỏ đi)
 *  4. cho người đứng đầu vào, tới khi đủ max_active người ADMITTED
 * Mỗi sự kiện xử lý trong một giao dịch, khóa dòng cấu hình bằng FOR UPDATE SKIP LOCKED:
 * nhiều instance Cloud Run chạy cùng lúc thì mỗi sự kiện chỉ một instance xử lý, không ai cho vào quá số chỗ.
 */
export class QueueWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Pool,
    private readonly cfg: { tickMs: number; staleSeconds: number },
  ) {}

  async tickOnce(eventId?: string): Promise<QueueTickResult> {
    const due = await this.db.query(
      `SELECT s.event_id
         FROM event_queue_settings s JOIN events e ON e.id = s.event_id
        WHERE s.enabled AND s.sale_start_at <= now() AND e.status = 'PUBLISHED' AND e.start_time > now()
          ${eventId ? 'AND s.event_id = $1' : ''}
        ORDER BY s.sale_start_at`,
      eventId ? [eventId] : [],
    );
    const total: QueueTickResult = { events: 0, admitted: 0, expired: 0, dropped: 0 };
    for (const { event_id } of due.rows) {
      const r = await withTransaction(this.db, async (tx) => {
        const s = await tx.query(
          `SELECT sale_start_at, randomized_at, max_active, access_minutes
             FROM event_queue_settings WHERE event_id = $1 AND enabled FOR UPDATE SKIP LOCKED`,
          [event_id],
        );
        const settings = s.rows[0];
        if (!settings) return null; // instance khác đang xử lý sự kiện này

        if (!settings.randomized_at) await randomizePreSale(tx, event_id, settings.sale_start_at);

        const expired = await tx.query(
          `UPDATE queue_entries SET status = 'EXPIRED', finished_at = now()
            WHERE event_id = $1 AND status = 'ADMITTED' AND expires_at <= now()`,
          [event_id],
        );
        const dropped = await tx.query(
          `UPDATE queue_entries SET status = 'EXPIRED', finished_at = now()
            WHERE event_id = $1 AND status = 'WAITING' AND last_seen_at < now() - ($2::int * interval '1 second')`,
          [event_id, this.cfg.staleSeconds],
        );
        const active = await tx.query(`SELECT count(*)::int AS n FROM queue_entries WHERE event_id = $1 AND status = 'ADMITTED'`, [
          event_id,
        ]);
        const slots = settings.max_active - active.rows[0].n;
        let admitted = 0;
        if (slots > 0) {
          const a = await tx.query(
            `UPDATE queue_entries
                SET status = 'ADMITTED', admitted_at = now(),
                    expires_at = now() + ($3::int * interval '1 minute')
              WHERE id IN (SELECT id FROM queue_entries
                            WHERE event_id = $1 AND status = 'WAITING' AND position IS NOT NULL
                            ORDER BY position
                            LIMIT $2
                            FOR UPDATE)`,
            [event_id, slots, settings.access_minutes],
          );
          admitted = a.rowCount ?? 0;
        }
        return { admitted, expired: expired.rowCount ?? 0, dropped: dropped.rowCount ?? 0 };
      });
      if (!r) continue;
      total.events++;
      total.admitted += r.admitted;
      total.expired += r.expired;
      total.dropped += r.dropped;
    }
    return total;
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.tickOnce();
      } catch (err) {
        const e = err as Error & { code?: string };
        console.error('[queue] lỗi worker:', e.message || e.code || String(err));
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(tick, this.cfg.tickMs);
    this.timer.unref();
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
