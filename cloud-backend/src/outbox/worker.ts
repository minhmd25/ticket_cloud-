import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Config } from '../config';
import type { OrderEventMessage } from './message';
import { PublishError, type EventPublisher } from './publisher';

export interface DispatchResult {
  claimed: number;
  sent: number;
  failed: number;
}

/** backoff lũy thừa: 5s, 10s, 20s, ... tối đa 15 phút */
export function backoffMs(attempt: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
}

/**
 * Gửi các sự kiện PENDING trong outbox sang Azure (cơ chế "gửi lại").
 *  - Nhận lô bằng FOR UPDATE SKIP LOCKED + lease (locked_until) => nhiều instance Cloud Run chạy song song
 *    vẫn không gửi trùng cùng lúc, và không giữ giao dịch DB trong lúc gọi mạng.
 *  - Giữ thứ tự theo từng đơn: chỉ gửi sự kiện khi mọi sự kiện TRƯỚC ĐÓ của cùng đơn đã SENT
 *    (Azure không bao giờ nhận ORDER_CANCELLED trước ORDER_CREATED).
 *  - Lỗi => tăng attempts, hẹn next_attempt_at theo backoff; quá maxAttempts hoặc lỗi không thể thử lại
 *    => FAILED (admin gửi lại qua API).
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Pool,
    private readonly publisher: EventPublisher,
    private readonly cfg: Config['outbox'],
  ) {}

  async dispatchOnce(): Promise<DispatchResult> {
    // Mã nhận việc của lượt này: chỉ lượt giữ đúng token mới được chốt kết quả của dòng.
    // Nếu lease hết hạn và lượt khác đã nhận lại dòng (token mới), kết quả của lượt cũ bị bỏ qua.
    const claimToken = randomUUID();
    const claimed = await this.db.query(
      `UPDATE outbox_events o
          SET locked_until = now() + ($2::int * interval '1 millisecond'),
              claim_token = $3::uuid,
              attempts = o.attempts + 1
        WHERE o.id IN (
              SELECT c.id FROM outbox_events c
               WHERE c.status = 'PENDING'
                 AND c.next_attempt_at <= now()
                 AND (c.locked_until IS NULL OR c.locked_until < now())
                 AND NOT EXISTS (SELECT 1 FROM outbox_events p
                                  WHERE p.aggregate_id = c.aggregate_id AND p.seq < c.seq AND p.status <> 'SENT')
               ORDER BY c.seq
               LIMIT $1
               FOR UPDATE SKIP LOCKED)
        RETURNING o.id, o.seq, o.payload, o.attempts`,
      [this.cfg.batchSize, this.cfg.leaseMs, claimToken],
    );
    const rows = claimed.rows.sort((a, b) => a.seq - b.seq);
    let sent = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await this.publisher.publish(row.payload as OrderEventMessage);
        const done = await this.db.query(
          `UPDATE outbox_events
              SET status = 'SENT', sent_at = now(), sent_via = $2, locked_until = NULL, claim_token = NULL, last_error = NULL
            WHERE id = $1 AND claim_token = $3::uuid`,
          [row.id, this.publisher.name, claimToken],
        );
        if (done.rowCount !== 1) this.warnLeaseLost(row.id);
        sent++;
      } catch (err) {
        failed++;
        const retryable = !(err instanceof PublishError) || err.retryable;
        const giveUp = !retryable || row.attempts >= this.cfg.maxAttempts;
        const message = String((err as Error)?.message ?? err).slice(0, 1000);
        const done = await this.db.query(
          `UPDATE outbox_events
              SET status = $2, last_error = $3, locked_until = NULL, claim_token = NULL,
                  next_attempt_at = now() + ($4::int * interval '1 millisecond')
            WHERE id = $1 AND claim_token = $5::uuid`,
          [row.id, giveUp ? 'FAILED' : 'PENDING', message, backoffMs(row.attempts), claimToken],
        );
        if (done.rowCount !== 1) this.warnLeaseLost(row.id);
        console.warn(`[outbox] gửi ${row.id} thất bại (lần ${row.attempts})${giveUp ? ' -> FAILED' : ''}: ${message}`);
      }
    }
    return { claimed: rows.length, sent, failed };
  }

  /** Lượt này không còn giữ dòng (lease hết hạn, lượt khác đã nhận lại) => không ghi đè kết quả */
  private warnLeaseLost(id: string): void {
    console.warn(`[outbox] ${id}: lease đã hết hạn và dòng được lượt khác nhận lại, bỏ qua kết quả của lượt này`);
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        // xả hết hàng đợi: lặp tới khi không còn sự kiện gửi được
        // (sự kiện sau của cùng đơn chỉ được nhận ở lượt kế tiếp, sau khi sự kiện trước đã SENT)
        let r: DispatchResult;
        do r = await this.dispatchOnce();
        while (r.claimed > 0 && r.failed === 0);
      } catch (err) {
        const e = err as Error & { code?: string };
        console.error('[outbox] lỗi worker:', e.message || e.code || String(err));
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(tick, this.cfg.pollIntervalMs);
    this.timer.unref();
    void tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Dành cho admin: xem / gửi lại outbox */
export class OutboxAdmin {
  constructor(private readonly db: Pool) {}

  async stats() {
    const r = await this.db.query(`SELECT status, count(*)::int AS n, min(created_at) AS oldest FROM outbox_events GROUP BY status`);
    const out: Record<string, { count: number; oldest: string | null }> = {
      PENDING: { count: 0, oldest: null },
      SENT: { count: 0, oldest: null },
      FAILED: { count: 0, oldest: null },
    };
    for (const row of r.rows) out[row.status] = { count: row.n, oldest: row.oldest ? new Date(row.oldest).toISOString() : null };
    return out;
  }

  async list(status: string | undefined, limit: number) {
    const r = await this.db.query(
      `SELECT id, seq, aggregate_id, event_type, status, attempts, last_error, next_attempt_at, created_at, sent_at, sent_via
         FROM outbox_events ${status ? 'WHERE status = $2' : ''}
        ORDER BY seq DESC LIMIT $1`,
      status ? [limit, status] : [limit],
    );
    return r.rows.map((x) => ({
      id: x.id,
      seq: x.seq,
      orderId: x.aggregate_id,
      type: x.event_type,
      status: x.status,
      attempts: x.attempts,
      lastError: x.last_error,
      nextAttemptAt: x.next_attempt_at,
      createdAt: x.created_at,
      sentAt: x.sent_at,
      sentVia: x.sent_via,
    }));
  }

  /**
   * Đưa sự kiện FAILED (hoặc PENDING đang chờ backoff) về hàng đợi để gửi ngay.
   * Bỏ qua dòng worker đang gửi (lease còn hạn): xóa lease của dòng đó sẽ cho lượt khác
   * nhận lại và gửi trùng. Dòng SENT không bao giờ được gửi lại.
   */
  async requeue(ids?: string[]): Promise<number> {
    const r = await this.db.query(
      `UPDATE outbox_events
          SET status = 'PENDING', attempts = 0, next_attempt_at = now(), locked_until = NULL, claim_token = NULL
        WHERE status IN ('FAILED', 'PENDING')
          AND (locked_until IS NULL OR locked_until < now())
          ${ids ? 'AND id = ANY($1::uuid[])' : ''}`,
      ids ? [ids] : [],
    );
    return r.rowCount ?? 0;
  }
}
