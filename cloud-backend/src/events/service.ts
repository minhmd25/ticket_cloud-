import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db';
import { Errors } from '../errors';
import { pageMeta } from '../lib/validation';
import { enqueueOrderEvent, type OrderSnapshot } from '../outbox/message';
import type { EventCreateInput, EventListQuery, EventUpdateInput, TicketTypeInput, TicketTypeUpdateInput } from './schemas';

// ---------------- DTO ----------------
export interface TicketTypeDto {
  id: string;
  eventId: string;
  name: string;
  description: string;
  price: number;
  /** GENERAL: bán theo số lượng; ASSIGNED: chọn ghế trên sơ đồ */
  seating: 'GENERAL' | 'ASSIGNED';
  totalQuantity: number;
  availableQuantity: number;
  /** số vé đang được giữ trong các đơn hợp lệ (CONFIRMED) */
  reservedQuantity: number;
  soldOut: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EventDto {
  id: string;
  title: string;
  description: string;
  category: string;
  venue: string;
  startTime: string;
  endTime: string;
  status: string;
  imageUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventSummaryDto extends EventDto {
  minPrice: number | null;
  maxPrice: number | null;
  totalAvailable: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const iso = (d: any) => (d instanceof Date ? d.toISOString() : String(d));

export function toTicketTypeDto(r: any): TicketTypeDto {
  return {
    id: r.id,
    eventId: r.event_id,
    name: r.name,
    description: r.description,
    price: Number(r.price),
    seating: r.seating,
    totalQuantity: r.total_quantity,
    availableQuantity: r.available_quantity,
    reservedQuantity: r.total_quantity - r.available_quantity,
    soldOut: r.available_quantity === 0,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toEventDto(r: any): EventDto {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    category: r.category,
    venue: r.venue,
    startTime: iso(r.start_time),
    endTime: iso(r.end_time),
    status: r.status,
    imageUrl: r.image_url,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

// ---------------- Service ----------------
export class EventService {
  constructor(private readonly db: Pool) {}

  /**
   * Danh sách sự kiện có lọc theo loại hình, từ khóa, khoảng thời gian.
   * @param publicView true => chỉ sự kiện PUBLISHED (khách); false => admin, lọc theo status tùy chọn
   */
  async list(q: EventListQuery, publicView: boolean) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };

    if (publicView) where.push(`e.status = 'PUBLISHED'`);
    else if (q.status) add('e.status = ?', q.status);
    if (q.category) add('e.category = ?', q.category);
    if (q.q) add(`(e.title ILIKE ? OR e.venue ILIKE $${params.length + 1})`, `%${q.q}%`);
    if (q.from) add('e.start_time >= ?', q.from);
    if (q.to) add('e.start_time <= ?', q.to);
    if (!q.includePast) where.push('e.end_time > now()');

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRes = await this.db.query(`SELECT count(*)::int AS n FROM events e ${whereSql}`, params);

    params.push(q.limit, (q.page - 1) * q.limit);
    const rows = await this.db.query(
      `SELECT e.*,
              (SELECT min(price) FROM ticket_types t WHERE t.event_id = e.id) AS min_price,
              (SELECT max(price) FROM ticket_types t WHERE t.event_id = e.id) AS max_price,
              COALESCE((SELECT sum(available_quantity) FROM ticket_types t WHERE t.event_id = e.id), 0)::int AS total_available
         FROM events e
         ${whereSql}
        ORDER BY e.start_time ASC, e.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const data: EventSummaryDto[] = rows.rows.map((r) => ({
      ...toEventDto(r),
      minPrice: r.min_price === null ? null : Number(r.min_price),
      maxPrice: r.max_price === null ? null : Number(r.max_price),
      totalAvailable: r.total_available,
    }));
    return { data, pagination: pageMeta(q, countRes.rows[0].n) };
  }

  async listCategories(): Promise<{ category: string; eventCount: number }[]> {
    const r = await this.db.query(
      `SELECT category, count(*)::int AS n FROM events
        WHERE status = 'PUBLISHED' AND end_time > now()
        GROUP BY category ORDER BY category`,
    );
    return r.rows.map((x) => ({ category: x.category, eventCount: x.n }));
  }

  /**
   * Chi tiết sự kiện kèm các hạng vé, giá, số lượng còn lại.
   * `seatMap` (null nếu chưa có sơ đồ) và `queue` (null nếu không dùng hàng chờ) cho frontend biết
   * cần hiện sơ đồ ghế / trang chờ hay không.
   */
  async getById(id: string, publicView: boolean, db: Queryable = this.db) {
    const ev = await db.query(
      `SELECT e.*, m.version AS seat_map_version,
              q.enabled AS queue_enabled, q.sale_start_at AS queue_sale_start_at,
              q.max_active AS queue_max_active, q.access_minutes AS queue_access_minutes
         FROM events e
         LEFT JOIN seat_maps m ON m.event_id = e.id
         LEFT JOIN event_queue_settings q ON q.event_id = e.id
        WHERE e.id = $1`,
      [id],
    );
    const row = ev.rows[0];
    if (!row || (publicView && row.status !== 'PUBLISHED')) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
    const tts = await db.query('SELECT * FROM ticket_types WHERE event_id = $1 ORDER BY price ASC, name ASC', [id]);
    return {
      ...toEventDto(row),
      ticketTypes: tts.rows.map(toTicketTypeDto),
      seatMap: row.seat_map_version === null ? null : { version: row.seat_map_version as number },
      queue:
        row.queue_enabled === null
          ? null
          : {
              enabled: row.queue_enabled as boolean,
              saleStartAt: iso(row.queue_sale_start_at),
              maxActive: row.queue_max_active as number,
              accessMinutes: row.queue_access_minutes as number,
            },
    };
  }

  async create(input: EventCreateInput, createdBy: string) {
    return withTransaction(this.db, async (tx) => {
      const r = await tx.query(
        `INSERT INTO events (title, description, category, venue, start_time, end_time, status, image_url, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [input.title, input.description, input.category, input.venue, input.startTime, input.endTime, input.status, input.imageUrl ?? null, createdBy],
      );
      const eventId: string = r.rows[0].id;
      for (const tt of input.ticketTypes) await insertTicketType(tx, eventId, tt);
      return this.getById(eventId, false, tx);
    });
  }

  /**
   * Sửa sự kiện. Khi chuyển sang CANCELLED (lần đầu), trong CÙNG giao dịch:
   * hủy mọi đơn CONFIRMED của sự kiện, hoàn vé, và ghi một ORDER_CANCELLED vào outbox cho từng đơn.
   *
   * Đồng thời: dòng sự kiện bị khóa FOR UPDATE, còn đặt vé khóa FOR SHARE cùng dòng này,
   * nên không đơn mới nào lọt vào sau khi sự kiện bị hủy. Khách hủy đơn song song khóa dòng đơn;
   * câu UPDATE ở đây chờ rồi bỏ qua đơn đã hủy, nên vé chỉ được hoàn một lần.
   * Hủy lại sự kiện đã CANCELLED không sinh thêm bản ghi nào (cancelledOrders = 0).
   */
  async update(id: string, patch: EventUpdateInput, actorId: string) {
    return withTransaction(this.db, async (tx) => {
      const cur = await tx.query('SELECT * FROM events WHERE id = $1 FOR UPDATE', [id]);
      const row = cur.rows[0];
      if (!row) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');

      const start: Date = patch.startTime ?? row.start_time;
      const end: Date = patch.endTime ?? row.end_time;
      if (end <= start) throw Errors.badRequest('Giờ kết thúc phải sau giờ bắt đầu', [{ path: 'endTime', message: 'Giờ kết thúc phải sau giờ bắt đầu' }]);
      if (row.status === 'CANCELLED' && patch.status && patch.status !== 'CANCELLED') {
        throw Errors.conflict('EVENT_CANCELLED', 'Sự kiện đã hủy, không thể mở lại');
      }

      const cols: Record<string, unknown> = {
        title: patch.title,
        description: patch.description,
        category: patch.category,
        venue: patch.venue,
        start_time: patch.startTime,
        end_time: patch.endTime,
        status: patch.status,
        image_url: patch.imageUrl,
      };
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of Object.entries(cols)) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      params.push(id);
      await tx.query(`UPDATE events SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE id = $${params.length}`, params);

      let cancelledOrders = 0;
      if (patch.status === 'CANCELLED' && row.status !== 'CANCELLED') {
        cancelledOrders = await cancelAllOrdersOfEvent(tx, id, actorId, patch.cancelReason ?? 'Sự kiện bị hủy');
      }
      return { ...(await this.getById(id, false, tx)), cancelledOrders };
    });
  }

  async addTicketType(eventId: string, input: TicketTypeInput) {
    const ev = await this.db.query('SELECT status FROM events WHERE id = $1', [eventId]);
    if (!ev.rows[0]) throw Errors.notFound('sự kiện', 'EVENT_NOT_FOUND');
    if (ev.rows[0].status === 'CANCELLED') throw Errors.conflict('EVENT_CANCELLED', 'Sự kiện đã hủy');
    try {
      const row = await insertTicketType(this.db, eventId, input);
      return toTicketTypeDto(row);
    } catch (err: any) {
      if (err?.code === '23505') throw Errors.conflict('TICKET_TYPE_NAME_TAKEN', 'Sự kiện đã có hạng vé cùng tên');
      throw err;
    }
  }

  /**
   * Sửa hạng vé. Đổi tổng số lượng được làm NGUYÊN TỬ trong một câu UPDATE:
   *   available_mới = available_cũ + (total_mới - total_cũ)
   * và chỉ áp dụng khi total_mới >= số vé đang giữ (total_cũ - available_cũ).
   * Vì điều kiện được kiểm tra trên chính dòng đang bị khóa, đơn đặt chạy song song
   * không thể làm số vé giữ vượt quá tổng mới.
   */
  async updateTicketType(ticketTypeId: string, patch: TicketTypeUpdateInput) {
    return withTransaction(this.db, async (tx) => {
      const cur = await tx.query(
        `SELECT t.*, e.status AS event_status FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE t.id = $1`,
        [ticketTypeId],
      );
      if (!cur.rows[0]) throw Errors.notFound('hạng vé', 'TICKET_TYPE_NOT_FOUND');

      // Đổi cách bán (GENERAL <-> ASSIGNED): khóa dòng sự kiện như khi lưu sơ đồ ghế,
      // để không đơn nào / không lần lưu sơ đồ nào chen vào giữa lúc kiểm tra và lúc đổi.
      if (patch.seating !== undefined && patch.seating !== cur.rows[0].seating) {
        await tx.query('SELECT 1 FROM events WHERE id = $1 FOR UPDATE', [cur.rows[0].event_id]);
        const t = (await tx.query('SELECT * FROM ticket_types WHERE id = $1 FOR UPDATE', [ticketTypeId])).rows[0];
        if (t.total_quantity - t.available_quantity > 0) {
          throw Errors.conflict('TICKET_TYPE_HAS_ORDERS', 'Hạng vé đã có đơn, không đổi được cách bán (theo số lượng / theo ghế)');
        }
        if (t.seating === 'ASSIGNED') {
          const seats = await tx.query('SELECT count(*)::int AS n FROM seats WHERE ticket_type_id = $1', [ticketTypeId]);
          if (seats.rows[0].n > 0) {
            throw Errors.conflict('TICKET_TYPE_HAS_SEATS', 'Hạng vé đang có ghế trên sơ đồ, hãy gỡ các ghế này khỏi sơ đồ trước', {
              seats: seats.rows[0].n,
            });
          }
        }
        // ASSIGNED: chưa ghế nào thuộc hạng (ghế chỉ được gán cho hạng ASSIGNED) => 0 vé.
        // GENERAL : bắt đầu từ 0, admin gửi kèm totalQuantity trong cùng request nếu muốn.
        await tx.query(
          `UPDATE ticket_types SET seating = $2, total_quantity = 0, available_quantity = 0, updated_at = now() WHERE id = $1`,
          [ticketTypeId, patch.seating],
        );
      }

      if (patch.totalQuantity !== undefined) {
        const r = await tx.query(
          `UPDATE ticket_types
              SET available_quantity = available_quantity + ($1::int - total_quantity),
                  total_quantity     = $1::int,
                  updated_at         = now()
            WHERE id = $2
              AND seating = 'GENERAL'
              AND $1::int >= total_quantity - available_quantity
            RETURNING *`,
          [patch.totalQuantity, ticketTypeId],
        );
        if (r.rowCount === 0) {
          const now = await tx.query('SELECT seating, total_quantity - available_quantity AS reserved FROM ticket_types WHERE id = $1', [
            ticketTypeId,
          ]);
          if (now.rows[0].seating === 'ASSIGNED') {
            throw Errors.conflict('SEAT_MANAGED_QUANTITY', 'Hạng vé theo ghế: số vé tính theo sơ đồ ghế, sửa sơ đồ thay vì nhập totalQuantity');
          }
          const reserved = now.rows[0].reserved;
          throw Errors.conflict(
            'QUANTITY_BELOW_RESERVED',
            `Không thể giảm tổng số vé xuống ${patch.totalQuantity} vì đang có ${reserved} vé được giữ trong đơn hợp lệ`,
            { requested: patch.totalQuantity, reserved },
          );
        }
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [col, v] of [['name', patch.name], ['description', patch.description], ['price', patch.price]] as const) {
        if (v === undefined) continue;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length) {
        params.push(ticketTypeId);
        try {
          await tx.query(`UPDATE ticket_types SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`, params);
        } catch (err: any) {
          if (err?.code === '23505') throw Errors.conflict('TICKET_TYPE_NAME_TAKEN', 'Sự kiện đã có hạng vé cùng tên');
          throw err;
        }
      }
      const out = await tx.query('SELECT * FROM ticket_types WHERE id = $1', [ticketTypeId]);
      return toTicketTypeDto(out.rows[0]);
    });
  }
}

/**
 * Hủy mọi đơn CONFIRMED của sự kiện, hoàn vé theo từng hạng, ghi ORDER_CANCELLED cho từng đơn.
 * PHẢI gọi trong giao dịch đang khóa dòng sự kiện. Trả về số đơn đã hủy.
 */
async function cancelAllOrdersOfEvent(tx: Queryable, eventId: string, actorId: string, reason: string): Promise<number> {
  const r = await tx.query(
    `WITH c AS (
       UPDATE orders
          SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
        WHERE event_id = $1 AND status = 'CONFIRMED'
        RETURNING *
     ), returned AS (
       UPDATE ticket_types t
          SET available_quantity = t.available_quantity + s.qty, updated_at = now()
         FROM (SELECT ticket_type_id, sum(quantity)::int AS qty FROM c GROUP BY ticket_type_id) s
        WHERE t.id = s.ticket_type_id
        RETURNING t.id
     ), released AS (
       -- trả ghế của các đơn vừa hủy (CTE ghi dữ liệu luôn được thực thi dù không được SELECT)
       UPDATE order_seats os SET released_at = now()
         FROM c
        WHERE os.order_id = c.id AND os.released_at IS NULL
        RETURNING os.id
     )
     SELECT c.*, e.title AS event_title, e.category AS event_category,
            e.start_time AS event_start_time, t.name AS ticket_type_name
       FROM c
       JOIN events e       ON e.id = c.event_id
       JOIN ticket_types t ON t.id = c.ticket_type_id
      ORDER BY c.created_at, c.id`,
    [eventId, actorId, reason],
  );
  for (const o of r.rows) await enqueueOrderEvent(tx, 'ORDER_CANCELLED', o as OrderSnapshot);
  return r.rows.length;
}

async function insertTicketType(db: Queryable, eventId: string, tt: TicketTypeInput) {
  const r = await db.query(
    `INSERT INTO ticket_types (event_id, name, description, price, seating, total_quantity, available_quantity)
     VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [eventId, tt.name, tt.description, tt.price, tt.seating, tt.totalQuantity],
  );
  return r.rows[0];
}
