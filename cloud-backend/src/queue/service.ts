import type { Pool, PoolClient } from 'pg';
import type { AuthUser } from '../auth/types';
import { withTransaction, type Queryable } from '../db';
import { AppError, Errors } from '../errors';
import type { QueueSettingsInput } from './schemas';

export type QueueStatus = 'WAITING' | 'ADMITTED' | 'COMPLETED' | 'EXPIRED' | 'LEFT';

export interface QueueEntryDto {
  eventId: string;
  status: QueueStatus;
  /** true: hàng chờ đang bật. false: admin đã tắt, frontend chuyển thẳng sang trang mua */
  queueEnabled: boolean;
  /** vị trí trong hàng; null khi chưa tới giờ mở bán (sẽ được xếp ngẫu nhiên lúc mở bán) */
  position: number | null;
  /** số người còn đứng trước (chỉ khi WAITING và đã có vị trí) */
  aheadOfYou: number | null;
  /** tổng số người đang chờ */
  waitingCount: number;
  saleStartAt: string;
  saleStarted: boolean;
  admittedAt: string | null;
  /** hạn chót được mua (khi ADMITTED) */
  expiresAt: string | null;
  /** frontend hỏi lại GET .../queue/me sau chừng này giây; null = không cần hỏi nữa */
  retryAfterSeconds: number | null;
  serverTime: string;
}

export interface QueueSettingsDto {
  eventId: string;
  enabled: boolean;
  saleStartAt: string;
  maxActive: number;
  accessMinutes: number;
  randomizedAt: string | null;
  counts: Record<QueueStatus, number>;
  updatedAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (d: any) => (d ? new Date(d).toISOString() : null);

export class QueueService {
  constructor(
    private readonly db: Pool,
    private readonly cfg: { staleSeconds: number },
  ) {}

  // ------------------------------------------------------------------
  // ADMIN
  // ------------------------------------------------------------------
  async getSettings(eventId: string): Promise<QueueSettingsDto> {
    const ev = await this.db.query('SELECT 1 FROM events WHERE id = $1', [eventId]);
    if (!ev.rows[0]) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
    const s = await this.db.query('SELECT * FROM event_queue_settings WHERE event_id = $1', [eventId]);
    if (!s.rows[0]) throw Errors.notFound('cấu hình hàng chờ', 'QUEUE_NOT_CONFIGURED');
    const c = await this.db.query('SELECT status, count(*)::int AS n FROM queue_entries WHERE event_id = $1 GROUP BY status', [eventId]);
    const counts: Record<QueueStatus, number> = { WAITING: 0, ADMITTED: 0, COMPLETED: 0, EXPIRED: 0, LEFT: 0 };
    for (const row of c.rows) counts[row.status as QueueStatus] = row.n;
    const r = s.rows[0];
    return {
      eventId,
      enabled: r.enabled,
      saleStartAt: iso(r.sale_start_at)!,
      maxActive: r.max_active,
      accessMinutes: r.access_minutes,
      randomizedAt: iso(r.randomized_at),
      counts,
      updatedAt: iso(r.updated_at)!,
    };
  }

  /**
   * Tạo / sửa cấu hình. Sau khi đã xếp ngẫu nhiên (đã qua giờ mở bán) thì không đổi được giờ mở bán nữa;
   * các trường khác (bật/tắt, số người cùng lúc, số phút) đổi được bất cứ lúc nào.
   */
  async putSettings(eventId: string, input: QueueSettingsInput, actorId: string): Promise<QueueSettingsDto> {
    await withTransaction(this.db, async (tx) => {
      const ev = await tx.query('SELECT status FROM events WHERE id = $1 FOR UPDATE', [eventId]);
      if (!ev.rows[0]) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
      if (ev.rows[0].status === 'CANCELLED') throw Errors.conflict('EVENT_CANCELLED', 'Sự kiện đã hủy');
      const cur = await tx.query('SELECT sale_start_at, randomized_at FROM event_queue_settings WHERE event_id = $1 FOR UPDATE', [
        eventId,
      ]);
      const row = cur.rows[0];
      if (row?.randomized_at && new Date(row.sale_start_at).getTime() !== input.saleStartAt.getTime()) {
        throw Errors.conflict('QUEUE_ALREADY_STARTED', 'Hàng chờ đã mở bán, không đổi được giờ mở bán nữa', {
          saleStartAt: iso(row.sale_start_at),
        });
      }
      await tx.query(
        `INSERT INTO event_queue_settings (event_id, enabled, sale_start_at, max_active, access_minutes, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO UPDATE
            SET enabled = EXCLUDED.enabled, sale_start_at = EXCLUDED.sale_start_at, max_active = EXCLUDED.max_active,
                access_minutes = EXCLUDED.access_minutes, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [eventId, input.enabled, input.saleStartAt, input.maxActive, input.accessMinutes, actorId],
      );
    });
    return this.getSettings(eventId);
  }

  // ------------------------------------------------------------------
  // KHÁCH
  // ------------------------------------------------------------------
  /**
   * Vào hàng. Mỗi người một dòng cho mỗi sự kiện:
   *  - đang WAITING / ADMITTED còn hạn => trả lại lượt đang có (200)
   *  - chưa có, hoặc lượt cũ đã kết thúc => đứng cuối hàng (201)
   * Trước giờ mở bán: chưa có vị trí (position = null). Đã qua giờ mở bán: vị trí = last_position + 1.
   * Khóa dòng cấu hình FOR UPDATE nên việc cấp vị trí và việc xếp ngẫu nhiên không chen nhau.
   */
  async join(eventId: string, user: AuthUser): Promise<{ entry: QueueEntryDto; created: boolean }> {
    const { entryId, created } = await withTransaction(this.db, async (tx) => {
      const ev = await tx.query('SELECT status, start_time <= now() AS started FROM events WHERE id = $1', [eventId]);
      const e = ev.rows[0];
      if (!e || e.status !== 'PUBLISHED') throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
      if (e.started) throw Errors.conflict('EVENT_ALREADY_STARTED', 'Sự kiện đã diễn ra');

      const s = await lockSettings(tx, eventId);
      if (!s || !s.enabled) throw Errors.conflict('QUEUE_NOT_ENABLED', 'Sự kiện này không dùng hàng chờ, có thể đặt vé trực tiếp');
      let randomized = s.randomized_at !== null;
      if (!randomized && s.sale_started) {
        await randomizePreSale(tx, eventId, s.sale_start_at);
        randomized = true;
      }

      const cur = await tx.query(
        `SELECT id, (status = 'WAITING' OR (status = 'ADMITTED' AND expires_at > now())) AS active
           FROM queue_entries WHERE event_id = $1 AND user_id = $2 FOR UPDATE`,
        [eventId, user.userId],
      );
      if (cur.rows[0]?.active) {
        await tx.query('UPDATE queue_entries SET last_seen_at = now() WHERE id = $1', [cur.rows[0].id]);
        return { entryId: cur.rows[0].id as string, created: false };
      }

      let position: number | null = null;
      if (randomized) {
        const p = await tx.query(
          'UPDATE event_queue_settings SET last_position = last_position + 1 WHERE event_id = $1 RETURNING last_position',
          [eventId],
        );
        position = p.rows[0].last_position;
      }
      const ins = await tx.query(
        `INSERT INTO queue_entries (event_id, user_id, status, position)
         VALUES ($1, $2, 'WAITING', $3)
         ON CONFLICT (event_id, user_id) DO UPDATE
            SET status = 'WAITING', position = EXCLUDED.position, joined_at = now(), last_seen_at = now(),
                admitted_at = NULL, expires_at = NULL, finished_at = NULL
         RETURNING id`,
        [eventId, user.userId, position],
      );
      return { entryId: ins.rows[0].id as string, created: true };
    });
    return { entry: await this.entryDto(this.db, entryId), created };
  }

  /** Trạng thái lượt của tôi; mỗi lần hỏi cũng là một "nhịp tim" (cập nhật last_seen_at) */
  async me(eventId: string, user: AuthUser): Promise<QueueEntryDto> {
    const r = await this.db.query(
      `UPDATE queue_entries
          SET last_seen_at = now(),
              status      = CASE WHEN status = 'ADMITTED' AND expires_at <= now() THEN 'EXPIRED' ELSE status END,
              finished_at = CASE WHEN status = 'ADMITTED' AND expires_at <= now() THEN now() ELSE finished_at END
        WHERE event_id = $1 AND user_id = $2
        RETURNING id`,
      [eventId, user.userId],
    );
    if (!r.rows[0]) throw Errors.notFound('lượt xếp hàng', 'QUEUE_ENTRY_NOT_FOUND');
    return this.entryDto(this.db, r.rows[0].id);
  }

  /** Rời hàng. Gọi lại khi đã kết thúc thì trả trạng thái hiện tại (không lỗi). */
  async leave(eventId: string, user: AuthUser): Promise<QueueEntryDto> {
    const r = await this.db.query(
      `UPDATE queue_entries SET status = 'LEFT', finished_at = now()
        WHERE event_id = $1 AND user_id = $2 AND status IN ('WAITING', 'ADMITTED')
        RETURNING id`,
      [eventId, user.userId],
    );
    if (r.rows[0]) return this.entryDto(this.db, r.rows[0].id);
    const cur = await this.db.query('SELECT id FROM queue_entries WHERE event_id = $1 AND user_id = $2', [eventId, user.userId]);
    if (!cur.rows[0]) throw Errors.notFound('lượt xếp hàng', 'QUEUE_ENTRY_NOT_FOUND');
    return this.entryDto(this.db, cur.rows[0].id);
  }

  private async entryDto(db: Queryable, entryId: string): Promise<QueueEntryDto> {
    const r = await db.query(
      `SELECT q.*, s.enabled, s.sale_start_at, s.sale_start_at <= now() AS sale_started, now() AS server_now,
              CASE WHEN q.status = 'WAITING' AND q.position IS NOT NULL THEN
                (SELECT count(*) FROM queue_entries w
                  WHERE w.event_id = q.event_id AND w.status = 'WAITING' AND w.position < q.position)::int
              END AS ahead,
              (SELECT count(*) FROM queue_entries w WHERE w.event_id = q.event_id AND w.status = 'WAITING')::int AS waiting
         FROM queue_entries q JOIN event_queue_settings s ON s.event_id = q.event_id
        WHERE q.id = $1`,
      [entryId],
    );
    const q = r.rows[0];
    const now = new Date(q.server_now);
    return {
      eventId: q.event_id,
      status: q.status,
      queueEnabled: q.enabled,
      position: q.position === null ? null : Number(q.position),
      aheadOfYou: q.ahead ?? null,
      waitingCount: q.waiting,
      saleStartAt: iso(q.sale_start_at)!,
      saleStarted: q.sale_started,
      admittedAt: iso(q.admitted_at),
      expiresAt: iso(q.expires_at),
      retryAfterSeconds: this.retryAfter(q, now),
      serverTime: now.toISOString(),
    };
  }

  /**
   * Nhịp hỏi lại: thưa khi còn xa giờ mở bán, dày khi sắp tới lượt.
   * Luôn nhỏ hơn 1/3 QUEUE_STALE_SECONDS để người đang mở trang không bị coi là đã bỏ đi.
   */
  private retryAfter(q: any, now: Date): number | null {
    if (!q.enabled) return null;
    let s: number;
    if (q.status === 'WAITING') {
      if (!q.sale_started) {
        const untilSale = (new Date(q.sale_start_at).getTime() - now.getTime()) / 1000;
        s = untilSale > 120 ? 30 : untilSale > 15 ? 10 : 3;
      } else {
        const ahead = q.ahead ?? 0;
        s = ahead > 1000 ? 15 : ahead > 100 ? 10 : 5;
      }
    } else if (q.status === 'ADMITTED') {
      s = 30;
    } else {
      return null;
    }
    return Math.max(2, Math.min(s, Math.floor(this.cfg.staleSeconds / 3)));
  }
}

// ======================================================================
// Hàm dùng chung
// ======================================================================

/** Khóa dòng cấu hình (chờ nếu đang bị giữ). null nếu sự kiện chưa cấu hình hàng chờ. */
async function lockSettings(tx: PoolClient, eventId: string) {
  const r = await tx.query(
    `SELECT enabled, sale_start_at, randomized_at, max_active, access_minutes, sale_start_at <= now() AS sale_started
       FROM event_queue_settings WHERE event_id = $1 FOR UPDATE`,
    [eventId],
  );
  return r.rows[0] ?? null;
}

/**
 * XẾP NGẪU NHIÊN một lần lúc mở bán (gọi khi đang giữ khóa dòng cấu hình):
 *  - người vào hàng TRƯỚC giờ mở bán: vị trí 1..N theo thứ tự ngẫu nhiên
 *  - người vào SAU giờ mở bán nhưng trước khi lượt xếp chạy (lệch nhịp worker): xếp tiếp theo thứ tự đến
 * Sau đó người mới vào nhận last_position + 1 (theo thứ tự đến).
 */
export async function randomizePreSale(tx: Queryable, eventId: string, saleStartAt: Date): Promise<number> {
  const r = await tx.query(
    `WITH pre AS (
       SELECT id, row_number() OVER (ORDER BY random()) AS rn
         FROM queue_entries
        WHERE event_id = $1 AND status = 'WAITING' AND position IS NULL AND joined_at < $2
     ), post AS (
       SELECT id, (SELECT count(*) FROM pre) + row_number() OVER (ORDER BY joined_at, id) AS rn
         FROM queue_entries
        WHERE event_id = $1 AND status = 'WAITING' AND position IS NULL AND joined_at >= $2
     )
     UPDATE queue_entries q SET position = x.rn
       FROM (SELECT * FROM pre UNION ALL SELECT * FROM post) x
      WHERE q.id = x.id
     RETURNING q.id`,
    [eventId, saleStartAt],
  );
  const n = r.rowCount ?? 0;
  await tx.query('UPDATE event_queue_settings SET randomized_at = now(), last_position = $2 WHERE event_id = $1', [eventId, n]);
  return n;
}

/**
 * Dùng trong giao dịch đặt vé. Sự kiện bật hàng chờ thì người đặt phải đang ADMITTED và còn hạn.
 * Khóa dòng lượt xếp hàng: hai đơn song song của cùng người chỉ một đơn dùng được lượt vào.
 * Trả về id lượt để đánh dấu COMPLETED khi đặt xong; null nếu sự kiện không dùng hàng chờ.
 */
export async function checkQueueAdmission(tx: Queryable, eventId: string, userId: string): Promise<string | null> {
  const s = await tx.query(
    'SELECT enabled, sale_start_at, sale_start_at <= now() AS started FROM event_queue_settings WHERE event_id = $1',
    [eventId],
  );
  const settings = s.rows[0];
  if (!settings || !settings.enabled) return null;
  if (!settings.started) {
    throw Errors.conflict('SALE_NOT_STARTED', 'Chưa tới giờ mở bán', { saleStartAt: iso(settings.sale_start_at) });
  }
  const e = await tx.query(
    `SELECT id, status, (status = 'ADMITTED' AND expires_at > now()) AS admitted
       FROM queue_entries WHERE event_id = $1 AND user_id = $2 FOR UPDATE`,
    [eventId, userId],
  );
  const entry = e.rows[0];
  if (!entry?.admitted) {
    throw new AppError(409, 'QUEUE_ADMISSION_REQUIRED', 'Bạn cần xếp hàng và tới lượt mới đặt được vé', {
      queueStatus: entry ? (entry.status === 'ADMITTED' ? 'EXPIRED' : entry.status) : null,
    });
  }
  return entry.id;
}

export async function completeQueueEntry(tx: Queryable, entryId: string): Promise<void> {
  await tx.query(`UPDATE queue_entries SET status = 'COMPLETED', finished_at = now() WHERE id = $1`, [entryId]);
}
