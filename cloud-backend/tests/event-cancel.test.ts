import { describe, expect, it } from 'vitest';
import { ADMIN, ALICE, BOB, available, book, createEvent, customer, setupTestApp } from './helpers';

const ctx = setupTestApp();

const cancelEvent = (eventId: string, body: Record<string, unknown> = { status: 'CANCELLED' }) =>
  ctx.api().patch(`/api/admin/events/${eventId}`).set('Authorization', ADMIN).send(body);

const outboxOf = async (eventId: string) =>
  (
    await ctx.db.query(
      `SELECT x.aggregate_id AS order_id, x.event_type, x.payload
         FROM outbox_events x JOIN orders o ON o.id = x.aggregate_id
        WHERE o.event_id = $1 ORDER BY x.seq`,
      [eventId],
    )
  ).rows as Array<{ order_id: string; event_type: string; payload: any }>;

/** Bất biến: vé đang giữ = tổng vé của đơn CONFIRMED, cho mọi hạng vé của sự kiện */
const assertInvariant = async (eventId: string) => {
  const r = await ctx.db.query(
    `SELECT t.id, t.total_quantity - t.available_quantity AS reserved,
            (SELECT COALESCE(sum(quantity), 0)::int FROM orders WHERE ticket_type_id = t.id AND status = 'CONFIRMED') AS confirmed
       FROM ticket_types t WHERE t.event_id = $1`,
    [eventId],
  );
  for (const row of r.rows) expect(row.reserved).toBe(row.confirmed);
};

describe('Hủy cả sự kiện', () => {
  it('hủy mọi đơn còn hiệu lực, hoàn vé từng hạng, ghi ORDER_CANCELLED cho từng đơn - cùng giao dịch', async () => {
    const ev = await createEvent(ctx, {
      ticketTypes: [
        { name: 'VIP', price: 500000, totalQuantity: 10 },
        { name: 'Thường', price: 100000, totalQuantity: 20 },
      ],
    });
    const vip = ev.ticketTypes.find((t) => t.name === 'VIP')!;
    const std = ev.ticketTypes.find((t) => t.name === 'Thường')!;
    const a = await book(ctx, ALICE, vip.id, 2);
    const b = await book(ctx, BOB, std.id, 3);
    const c = await book(ctx, customer('carol'), std.id, 1);
    // đơn đã hủy từ trước: không được hủy lại, không hoàn vé lần 2
    await ctx.api().post(`/api/orders/${c.body.id}/cancel`).set('Authorization', customer('carol'));
    // đơn của sự kiện KHÁC không bị ảnh hưởng
    const other = await createEvent(ctx);
    const keep = await book(ctx, ALICE, other.ticketTypes[0].id, 1);

    const r = await cancelEvent(ev.id, { status: 'CANCELLED', cancelReason: 'Ca sĩ ốm' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ev.id, status: 'CANCELLED', cancelledOrders: 2 });

    const orders = await ctx.db.query('SELECT id, status, cancelled_by, cancel_reason FROM orders WHERE event_id = $1', [ev.id]);
    expect(orders.rows.every((o) => o.status === 'CANCELLED')).toBe(true);
    expect(orders.rows.find((o) => o.id === a.body.id)).toMatchObject({ cancelled_by: 'admin1', cancel_reason: 'Ca sĩ ốm' });
    expect(await available(ctx, vip.id)).toBe(10);
    expect(await available(ctx, std.id)).toBe(20);
    expect((await ctx.db.query('SELECT status FROM orders WHERE id = $1', [keep.body.id])).rows[0].status).toBe('CONFIRMED');

    const cancelled = (await outboxOf(ev.id)).filter((x) => x.event_type === 'ORDER_CANCELLED');
    expect(cancelled.map((x) => x.order_id).sort()).toEqual([a.body.id, b.body.id, c.body.id].sort());
    const ofA = cancelled.find((x) => x.order_id === a.body.id)!;
    expect(ofA.payload.data).toMatchObject({ quantity: 2, ticketTypeId: vip.id, status: 'CANCELLED', cancelReason: 'Ca sĩ ốm' });
    await assertInvariant(ev.id);
  });

  it('gọi lại không sinh thêm bản ghi hủy; không mở lại được; khách không đặt thêm được', async () => {
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    expect((await cancelEvent(ev.id)).body.cancelledOrders).toBe(1);
    const before = (await outboxOf(ev.id)).length;

    const again = await cancelEvent(ev.id, { status: 'CANCELLED', cancelReason: 'lần 2' });
    expect(again.status).toBe(200);
    expect(again.body.cancelledOrders).toBe(0);
    expect((await outboxOf(ev.id)).length).toBe(before);
    expect(await available(ctx, ev.ticketTypes[0].id)).toBe(10);

    expect((await cancelEvent(ev.id, { status: 'PUBLISHED' })).status).toBe(409);
    const late = await book(ctx, BOB, ev.ticketTypes[0].id, 1);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('EVENT_CANCELLED');
  });

  it('sửa sự kiện bình thường không hủy đơn; cancelReason chỉ đi kèm status=CANCELLED', async () => {
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    const r = await cancelEvent(ev.id, { title: 'Đổi tên' });
    expect(r.body).toMatchObject({ title: 'Đổi tên', status: 'PUBLISHED', cancelledOrders: 0 });
    expect((await cancelEvent(ev.id, { cancelReason: 'x' })).status).toBe(400);
    expect((await cancelEvent(ev.id, { title: 'y', cancelReason: 'x' })).status).toBe(400);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE status = 'CONFIRMED'`)).rows[0].n).toBe(1);
  });

  it('worker gửi sang Azure: BOOKED rồi CANCELLED cho từng đơn, quantity khớp, đúng mẫu', async () => {
    const ev = await createEvent(ctx);
    const a = await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    const b = await book(ctx, BOB, ev.ticketTypes[0].id, 3);
    await cancelEvent(ev.id);
    for (let i = 0; i < 5; i++) await ctx.services.dispatcher.dispatchOnce();

    const sent = ctx.publisher.sent;
    expect(sent).toHaveLength(4);
    for (const o of [a.body, b.body]) {
      const mine = sent.filter((m) => m.orderId === o.id);
      expect(mine.map((m) => m.type)).toEqual(['BOOKED', 'CANCELLED']);
      expect(mine.every((m) => m.quantity === o.quantity && m.eventId === ev.id)).toBe(true);
    }
    expect(new Set(sent.map((m) => m.messageId)).size).toBe(4);
  });

  it('khách đặt vé trong lúc admin hủy sự kiện: không đơn nào còn hiệu lực, vé không lệch', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 100 }] });
    const tt = ev.ticketTypes[0].id;
    for (let i = 0; i < 5; i++) await book(ctx, customer(`pre${i}`), tt, 1);

    const [cancel, ...bookings] = await Promise.all([
      cancelEvent(ev.id),
      ...Array.from({ length: 20 }, (_, i) => book(ctx, customer(`race${i}`), tt, 1)),
    ]);
    expect(cancel.status).toBe(200);
    const booked = bookings.filter((r) => r.status === 201).length;
    expect(bookings.every((r) => r.status === 201 || r.body.error.code === 'EVENT_CANCELLED')).toBe(true);
    // mọi đơn đặt được TRƯỚC khi hủy đều bị hủy theo sự kiện
    expect(cancel.body.cancelledOrders).toBe(5 + booked);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM orders WHERE event_id = $1 AND status = 'CONFIRMED'`, [ev.id])).rows[0].n).toBe(0);
    expect(await available(ctx, tt)).toBe(100);
    // mỗi đơn có đúng 1 BOOKED và 1 CANCELLED
    const rows = await outboxOf(ev.id);
    const perOrder = new Map<string, string[]>();
    for (const x of rows) perOrder.set(x.order_id, [...(perOrder.get(x.order_id) ?? []), x.event_type]);
    expect([...perOrder.values()].every((t) => t.join() === 'ORDER_CREATED,ORDER_CANCELLED')).toBe(true);
  });

  it('khách tự hủy đơn trong lúc admin hủy sự kiện: vé hoàn đúng 1 lần, đúng 1 bản ghi hủy', async () => {
    const ev = await createEvent(ctx);
    const tt = ev.ticketTypes[0].id;
    const orders = [];
    for (let i = 0; i < 6; i++) orders.push((await book(ctx, customer(`c${i}`), tt, 1)).body);

    const [cancel, ...own] = await Promise.all([
      cancelEvent(ev.id),
      ...orders.map((o, i) => ctx.api().post(`/api/orders/${o.id}/cancel`).set('Authorization', customer(`c${i}`))),
    ]);
    expect(cancel.status).toBe(200);
    const ownOk = own.filter((r) => r.status === 200).length;
    expect(own.every((r) => r.status === 200 || r.body.error.code === 'ORDER_ALREADY_CANCELLED')).toBe(true);
    expect(cancel.body.cancelledOrders + ownOk).toBe(6);
    expect(await available(ctx, tt)).toBe(10);
    const cancelledRows = (await outboxOf(ev.id)).filter((x) => x.event_type === 'ORDER_CANCELLED');
    expect(cancelledRows).toHaveLength(6);
    expect(new Set(cancelledRows.map((x) => x.order_id)).size).toBe(6);
  });
});
