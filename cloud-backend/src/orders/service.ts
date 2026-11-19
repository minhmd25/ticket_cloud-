import type { Pool } from 'pg';
import type { AuthUser } from '../auth/types';
import type { Config } from '../config';
import { withTransaction, type Queryable } from '../db';
import { AppError, Errors } from '../errors';
import { pageMeta } from '../lib/validation';
import { enqueueOrderEvent, type OrderSnapshot } from '../outbox/message';
import { checkQueueAdmission, completeQueueEntry } from '../queue/service';
import { checkSeatsForBooking, seatTakenError } from '../seating/service';
import type { AdminOrdersQuery, CreateOrderInput, MyOrdersQuery } from './schemas';

export interface OrderSeatDto {
  /** null nếu ghế đã bị xóa khỏi sơ đồ sau khi đơn bị hủy */
  id: string | null;
  label: string;
}

export interface OrderDto {
  id: string;
  userId: string;
  status: 'CONFIRMED' | 'CANCELLED';
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  currency: 'VND';
  event: { id: string; title: string; category: string; venue: string; startTime: string; status: string };
  ticketType: { id: string; name: string };
  /** ghế của đơn (hạng vé ASSIGNED); [] với vé thường */
  seats: OrderSeatDto[];
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  /** hạn chót khách được tự hủy */
  cancellationDeadline: string;
  canCancel: boolean;
}

/** SELECT đơn kèm thông tin sự kiện & hạng vé */
const ORDER_SELECT = `
  SELECT o.*,
         e.title AS event_title, e.category AS event_category, e.venue AS event_venue,
         e.start_time AS event_start_time, e.status AS event_status,
         t.name AS ticket_type_name
    FROM orders o
    JOIN events e       ON e.id = o.event_id
    JOIN ticket_types t ON t.id = o.ticket_type_id`;

export class OrderService {
  constructor(
    private readonly db: Pool,
    private readonly rules: Config['rules'],
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ------------------------------------------------------------------
  // ĐẶT VÉ
  // ------------------------------------------------------------------
  /**
   * Toàn bộ trong MỘT giao dịch:
   *   1. đọc hạng vé + sự kiện (khóa chia sẻ sự kiện để không bị hủy/sửa giữa chừng,
   *      và để sơ đồ ghế không bị lưu đè trong lúc đặt)
   *   2. sự kiện bật hàng chờ: người đặt phải đang ADMITTED và còn hạn
   *   3. hạng vé theo ghế: kiểm tra ghế thuộc đúng hạng, không bị khóa, chưa ai đặt
   *   4. trừ vé bằng UPDATE có điều kiện `available_quantity >= q`  (nguyên tử)
   *   5. tạo đơn với giá lấy từ DB
   *   6. giữ ghế: INSERT ... ON CONFLICT DO NOTHING theo thứ tự id; thiếu ghế nào => SEAT_TAKEN, hoàn tác cả đơn
   *   7. ghi outbox ORDER_CREATED (mẫu thông điệp Azure không đổi: một hạng vé + quantity = số ghế)
   *   8. đánh dấu lượt xếp hàng COMPLETED
   * Bất kỳ bước nào lỗi => ROLLBACK, lượng vé không đổi, không có đơn, không giữ ghế nào.
   *
   * Đồng thời: câu UPDATE ở bước 4 khóa dòng hạng vé; request thứ hai phải chờ, rồi
   * Postgres đánh giá lại điều kiện trên giá trị MỚI NHẤT => không bao giờ bán vượt
   * (thêm CHECK available_quantity >= 0 ở DB làm lớp bảo vệ cuối).
   * Với ghế, unique index `order_seats_active_uq` là lớp bảo vệ cuối: một ghế chỉ thuộc một đơn còn hiệu lực.
   */
  async create(user: AuthUser, raw: CreateOrderInput, idempotencyKey?: string): Promise<{ order: OrderDto; replayed: boolean }> {
    // chuẩn hóa cả khi được gọi trực tiếp (seed): ghế sắp theo id => mọi giao dịch khóa ghế cùng thứ tự
    const seatIds = raw.seatIds ? [...new Set(raw.seatIds)].sort() : undefined;
    const input: CreateOrderInput = { ticketTypeId: raw.ticketTypeId, quantity: seatIds ? seatIds.length : raw.quantity, seatIds };
    if (input.quantity > this.rules.maxTicketsPerOrder) {
      throw Errors.unprocessable(
        'QUANTITY_EXCEEDS_LIMIT',
        `Mỗi đơn được đặt tối đa ${this.rules.maxTicketsPerOrder} vé`,
        { requested: input.quantity, max: this.rules.maxTicketsPerOrder },
      );
    }

    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(user.userId, idempotencyKey, input);
      if (existing) return { order: existing, replayed: true };
    }

    try {
      const order = await withTransaction(this.db, async (tx) => {
        const info = await tx.query(
          `SELECT t.id, t.event_id, t.seating, e.status AS event_status, e.start_time
             FROM ticket_types t JOIN events e ON e.id = t.event_id
            WHERE t.id = $1
            FOR SHARE OF e`,
          [input.ticketTypeId],
        );
        const tt = info.rows[0];
        if (!tt) throw Errors.notFound('hạng vé', 'TICKET_TYPE_NOT_FOUND');
        if (tt.event_status === 'CANCELLED') throw Errors.conflict('EVENT_CANCELLED', 'Sự kiện đã bị hủy');
        if (tt.event_status !== 'PUBLISHED') throw Errors.conflict('EVENT_NOT_OPEN', 'Sự kiện chưa mở bán');
        if (new Date(tt.start_time) <= this.now()) throw Errors.conflict('EVENT_ALREADY_STARTED', 'Sự kiện đã diễn ra, không thể đặt vé');

        // (2) hàng chờ ảo
        const queueEntryId = await checkQueueAdmission(tx, tt.event_id, user.userId);

        // (3) ghế
        if (tt.seating === 'ASSIGNED' && !input.seatIds) {
          throw Errors.unprocessable('SEATS_REQUIRED', 'Hạng vé này bán theo ghế, hãy chọn ghế (seatIds)');
        }
        if (tt.seating === 'GENERAL' && input.seatIds) {
          throw Errors.unprocessable('SEATS_NOT_ALLOWED', 'Hạng vé này không bán theo ghế, chỉ gửi quantity');
        }
        const seats = input.seatIds ? await checkSeatsForBooking(tx, tt.event_id, input.ticketTypeId, input.seatIds) : null;

        // (4) trừ vé nguyên tử
        const dec = await tx.query(
          `UPDATE ticket_types
              SET available_quantity = available_quantity - $2, updated_at = now()
            WHERE id = $1 AND available_quantity >= $2
            RETURNING price, available_quantity`,
          [input.ticketTypeId, input.quantity],
        );
        if (dec.rowCount === 0) {
          // với ghế: chỉ xảy ra khi có ghế vừa bị người khác lấy trong lúc chờ khóa
          if (seats) throw seatTakenError(await this.takenSeats(tx, seats));
          const left = await tx.query('SELECT available_quantity FROM ticket_types WHERE id = $1', [input.ticketTypeId]);
          const available: number = left.rows[0].available_quantity;
          if (available === 0) throw Errors.conflict('SOLD_OUT', 'Hạng vé này đã hết', { requested: input.quantity, available });
          throw Errors.conflict(
            'INSUFFICIENT_TICKETS',
            `Chỉ còn ${available} vé, không đủ cho ${input.quantity} vé yêu cầu`,
            { requested: input.quantity, available },
          );
        }
        const price: string = dec.rows[0].price; // giá lấy từ DB, không tin client

        // (5) tạo đơn
        const ins = await tx.query(
          `INSERT INTO orders (user_id, event_id, ticket_type_id, quantity, unit_price, total_amount, status, idempotency_key)
           VALUES ($1, $2, $3, $4::int, $5::numeric, $5::numeric * $4::int, 'CONFIRMED', $6)
           RETURNING id`,
          [user.userId, tt.event_id, input.ticketTypeId, input.quantity, price, idempotencyKey ?? null],
        );
        const orderId: string = ins.rows[0].id;

        // (6) giữ ghế: đủ hết hoặc không ghế nào
        if (seats) {
          const got = await tx.query(
            `INSERT INTO order_seats (order_id, seat_id, seat_label)
             SELECT $1, s.id, s.label FROM seats s WHERE s.id = ANY($2::uuid[]) ORDER BY s.id
             ON CONFLICT (seat_id) WHERE released_at IS NULL DO NOTHING
             RETURNING seat_id`,
            [orderId, input.seatIds],
          );
          if (got.rowCount !== seats.length) {
            const mine = new Set(got.rows.map((r) => r.seat_id));
            throw seatTakenError(seats.filter((s) => !mine.has(s.id)));
          }
        }

        // (7) outbox - cùng giao dịch
        const snap = await this.loadSnapshot(tx, orderId);
        await enqueueOrderEvent(tx, 'ORDER_CREATED', snap);

        // (8) dùng xong lượt vào của hàng chờ
        if (queueEntryId) await completeQueueEntry(tx, queueEntryId);
        return (await this.toDtos(tx, [snap]))[0];
      });
      return { order, replayed: false };
    } catch (err: any) {
      // Gửi lại cùng Idempotency-Key trong lúc request đầu đang chạy: request sau có thể thua ở unique index,
      // hoặc nhận 409 (hết vé, ghế vừa bị lấy, lượt hàng chờ vừa dùng) vì chính request đầu đã thành công.
      // Khi đó trả lại đơn của request đầu thay vì báo lỗi.
      const raced = (err?.code === '23505' && err?.constraint === 'orders_idempotency_uq') || (err instanceof AppError && err.status === 409);
      if (idempotencyKey && raced) {
        const existing = await this.findByIdempotencyKey(user.userId, idempotencyKey, input);
        if (existing) return { order: existing, replayed: true };
      }
      throw err;
    }
  }

  /** Ghế nào trong danh sách đang thuộc đơn khác */
  private async takenSeats(tx: Queryable, seats: { id: string; label: string }[]) {
    const r = await tx.query('SELECT seat_id FROM order_seats WHERE seat_id = ANY($1::uuid[]) AND released_at IS NULL', [
      seats.map((s) => s.id),
    ]);
    const taken = new Set(r.rows.map((x) => x.seat_id));
    const list = seats.filter((s) => taken.has(s.id));
    return list.length ? list : seats;
  }

  // ------------------------------------------------------------------
  // HỦY ĐƠN
  // ------------------------------------------------------------------
  /**
   * Điều kiện (nhóm chốt): khách chỉ được hủy khi còn >= N giờ trước giờ diễn ra
   * (N = CANCELLATION_DEADLINE_HOURS). Admin được hủy bất cứ lúc nào. Nếu sự kiện đã bị hủy,
   * khách được hủy đơn không giới hạn thời gian.
   *
   * Khóa dòng đơn (FOR UPDATE) => hai lệnh hủy song song bị tuần tự hóa; lệnh sau thấy
   * status = CANCELLED và nhận 409, nên vé chỉ được hoàn ĐÚNG MỘT LẦN.
   */
  async cancel(user: AuthUser, orderId: string, reason?: string): Promise<OrderDto> {
    return withTransaction(this.db, async (tx) => {
      const r = await tx.query(`${ORDER_SELECT} WHERE o.id = $1 FOR UPDATE OF o`, [orderId]);
      const o = r.rows[0];
      this.assertCanAccess(user, o);

      if (o.status === 'CANCELLED') {
        throw Errors.conflict('ORDER_ALREADY_CANCELLED', 'Đơn đã được hủy trước đó', { cancelledAt: new Date(o.cancelled_at).toISOString() });
      }
      if (user.role !== 'admin' && o.event_status !== 'CANCELLED') {
        const deadline = this.deadlineOf(o.event_start_time);
        if (this.now() > deadline) {
          throw Errors.unprocessable(
            'CANCELLATION_WINDOW_CLOSED',
            `Chỉ được hủy đơn trước giờ diễn ra ít nhất ${this.rules.cancellationDeadlineHours} giờ`,
            { cancellationDeadline: deadline.toISOString() },
          );
        }
      }

      const upd = await tx.query(
        `UPDATE orders
            SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
          WHERE id = $1 AND status = 'CONFIRMED'`,
        [orderId, user.userId, reason ?? null],
      );
      if (upd.rowCount !== 1) throw Errors.conflict('ORDER_ALREADY_CANCELLED', 'Đơn đã được hủy trước đó');

      // hoàn vé và trả ghế trong cùng giao dịch
      await tx.query(
        `UPDATE ticket_types SET available_quantity = available_quantity + $2, updated_at = now() WHERE id = $1`,
        [o.ticket_type_id, o.quantity],
      );
      await tx.query('UPDATE order_seats SET released_at = now() WHERE order_id = $1 AND released_at IS NULL', [orderId]);

      const snap = await this.loadSnapshot(tx, orderId);
      await enqueueOrderEvent(tx, 'ORDER_CANCELLED', snap);
      return (await this.toDtos(tx, [snap]))[0];
    });
  }

  // ------------------------------------------------------------------
  // TRA CỨU
  // ------------------------------------------------------------------
  async getForUser(user: AuthUser, orderId: string): Promise<OrderDto> {
    const r = await this.db.query(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]);
    const o = r.rows[0];
    this.assertCanAccess(user, o);
    return (await this.toDtos(this.db, [o]))[0];
  }

  async listMine(user: AuthUser, q: MyOrdersQuery) {
    const params: unknown[] = [user.userId];
    let where = 'WHERE o.user_id = $1';
    if (q.status) {
      params.push(q.status);
      where += ` AND o.status = $${params.length}`;
    }
    return this.paged(where, params, q);
  }

  async adminList(q: AdminOrdersQuery) {
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const [col, v] of [['o.event_id', q.eventId], ['o.ticket_type_id', q.ticketTypeId], ['o.status', q.status], ['o.user_id', q.userId]] as const) {
      if (v === undefined) continue;
      params.push(v);
      conds.push(`${col} = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const result = await this.paged(where, params, q);

    // tổng hợp nhanh theo bộ lọc (hữu ích cho trang quản trị)
    const sum = await this.db.query(
      `SELECT o.status, count(*)::int AS orders, COALESCE(sum(o.quantity),0)::int AS tickets, COALESCE(sum(o.total_amount),0) AS amount
         FROM orders o ${where} GROUP BY o.status`,
      params,
    );
    const summary = Object.fromEntries(
      sum.rows.map((s) => [s.status, { orders: s.orders, tickets: s.tickets, amount: Number(s.amount) }]),
    );
    return { ...result, summary };
  }

  // ------------------------------------------------------------------
  private async paged(where: string, params: unknown[], q: { page: number; limit: number }) {
    const count = await this.db.query(`SELECT count(*)::int AS n FROM orders o ${where}`, params);
    const rows = await this.db.query(
      `${ORDER_SELECT} ${where} ORDER BY o.created_at DESC, o.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, q.limit, (q.page - 1) * q.limit],
    );
    return { data: await this.toDtos(this.db, rows.rows), pagination: pageMeta(q, count.rows[0].n) };
  }

  /** Chủ đơn hoặc admin. Người khác nhận 404 (không tiết lộ đơn có tồn tại hay không). */
  private assertCanAccess(user: AuthUser, o: { user_id: string } | undefined): asserts o {
    if (!o || (user.role !== 'admin' && o.user_id !== user.userId)) {
      throw Errors.notFound('đơn đặt vé', 'ORDER_NOT_FOUND');
    }
  }

  private async findByIdempotencyKey(userId: string, key: string, input: CreateOrderInput): Promise<OrderDto | null> {
    const r = await this.db.query(`${ORDER_SELECT} WHERE o.user_id = $1 AND o.idempotency_key = $2`, [userId, key]);
    const o = r.rows[0];
    if (!o) return null;
    const [dto] = await this.toDtos(this.db, [o]);
    const sameSeats = dto.seats.map((s) => s.id ?? '').sort().join(',') === (input.seatIds ?? []).join(',');
    if (o.ticket_type_id !== input.ticketTypeId || o.quantity !== input.quantity || !sameSeats) {
      throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã dùng cho một yêu cầu đặt vé khác');
    }
    return dto;
  }

  /** Chuyển dòng đơn sang DTO, kèm ghế (một query cho cả trang) */
  private async toDtos(db: Queryable, rows: any[]): Promise<OrderDto[]> {
    if (rows.length === 0) return [];
    const r = await db.query(
      'SELECT order_id, seat_id, seat_label FROM order_seats WHERE order_id = ANY($1::uuid[]) ORDER BY seat_label, id',
      [rows.map((o) => o.id)],
    );
    const seatsOf = new Map<string, OrderSeatDto[]>();
    for (const s of r.rows) {
      const list = seatsOf.get(s.order_id) ?? [];
      list.push({ id: s.seat_id, label: s.seat_label });
      seatsOf.set(s.order_id, list);
    }
    return rows.map((o) => this.toDto(o, seatsOf.get(o.id) ?? []));
  }

  private async loadSnapshot(db: Queryable, orderId: string): Promise<OrderSnapshot & Record<string, any>> {
    const r = await db.query(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]);
    return r.rows[0];
  }

  private deadlineOf(startTime: Date | string): Date {
    return new Date(new Date(startTime).getTime() - this.rules.cancellationDeadlineHours * 3600_000);
  }

  private toDto(o: any, seats: OrderSeatDto[]): OrderDto {
    const deadline = this.deadlineOf(o.event_start_time);
    return {
      id: o.id,
      userId: o.user_id,
      status: o.status,
      quantity: o.quantity,
      unitPrice: Number(o.unit_price),
      totalAmount: Number(o.total_amount),
      currency: 'VND',
      event: {
        id: o.event_id,
        title: o.event_title,
        category: o.event_category,
        venue: o.event_venue,
        startTime: new Date(o.event_start_time).toISOString(),
        status: o.event_status,
      },
      ticketType: { id: o.ticket_type_id, name: o.ticket_type_name },
      seats,
      createdAt: new Date(o.created_at).toISOString(),
      cancelledAt: o.cancelled_at ? new Date(o.cancelled_at).toISOString() : null,
      cancelledBy: o.cancelled_by ?? null,
      cancelReason: o.cancel_reason ?? null,
      cancellationDeadline: deadline.toISOString(),
      canCancel: o.status === 'CONFIRMED' && (o.event_status === 'CANCELLED' || this.now() <= deadline),
    };
  }
}
