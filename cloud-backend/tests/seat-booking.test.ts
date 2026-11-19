import { describe, expect, it } from 'vitest';
import { toAzureMessage, validateAzureMessage } from '../src/outbox/azureMessage';
import { ADMIN, ALICE, BOB, available, book, bookSeats, createSeatedEvent, customer, setupTestApp } from './helpers';

const ctx = setupTestApp();

const activeSeats = async (eventId: string) =>
  (
    await ctx.db.query(
      `SELECT s.label FROM order_seats os JOIN seats s ON s.id = os.seat_id
        WHERE s.event_id = $1 AND os.released_at IS NULL ORDER BY s.label`,
      [eventId],
    )
  ).rows.map((r) => r.label);

/** Bất biến: vé đã bán của hạng = tổng vé đơn CONFIRMED = số ghế đang giữ */
const assertInvariant = async (ticketTypeId: string) => {
  const r = await ctx.db.query(
    `SELECT t.total_quantity - t.available_quantity AS reserved,
            (SELECT COALESCE(sum(quantity), 0)::int FROM orders WHERE ticket_type_id = t.id AND status = 'CONFIRMED') AS confirmed,
            (SELECT count(*)::int FROM order_seats os JOIN seats s ON s.id = os.seat_id
              WHERE s.ticket_type_id = t.id AND os.released_at IS NULL) AS held
       FROM ticket_types t WHERE t.id = $1`,
    [ticketTypeId],
  );
  expect(r.rows[0].reserved).toBe(r.rows[0].confirmed);
  expect(r.rows[0].held).toBe(r.rows[0].confirmed);
};

describe('Đặt ghế', () => {
  it('đặt ghế: đơn kèm danh sách ghế, quantity = số ghế, thông điệp Azure giữ đúng mẫu 7 trường', async () => {
    const { ev, vip, ga, seat } = await createSeatedEvent(ctx);
    const r = await bookSeats(ctx, ALICE, vip, seat('A2', 'A1'));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ quantity: 2, unitPrice: 500000, totalAmount: 1000000, ticketType: { id: vip, name: 'VIP' } });
    expect(r.body.seats).toEqual([
      { id: seat('A1')[0], label: 'A1' },
      { id: seat('A2')[0], label: 'A2' },
    ]);
    expect(await available(ctx, vip)).toBe(3);

    const status = await ctx.api().get(`/api/events/${ev.id}/seats/status`);
    expect([...status.body.sold].sort()).toEqual(seat('A1', 'A2').sort());

    const outbox = await ctx.db.query('SELECT payload FROM outbox_events WHERE aggregate_id = $1', [r.body.id]);
    const azure = toAzureMessage(outbox.rows[0].payload);
    expect(validateAzureMessage(azure)).toEqual({ ok: true });
    expect(Object.keys(azure).sort()).toEqual(['eventId', 'messageId', 'occurredAt', 'orderId', 'quantity', 'ticketTierId', 'type']);
    expect(azure).toMatchObject({ type: 'BOOKED', ticketTierId: vip, quantity: 2 });

    // vé thường vẫn đặt theo số lượng, không có ghế
    const general = await book(ctx, ALICE, ga, 3);
    expect(general.status).toBe(201);
    expect(general.body.seats).toEqual([]);
    expect((await ctx.api().get(`/api/orders/${r.body.id}`).set('Authorization', ALICE)).body.seats).toHaveLength(2);
    await assertInvariant(vip);
  });

  it('có ghế đã bị đặt => 409 SEAT_TAKEN, đơn không lấy ghế nào (đủ hết hoặc không)', async () => {
    const { ev, vip, seat } = await createSeatedEvent(ctx);
    expect((await bookSeats(ctx, ALICE, vip, seat('A1'))).status).toBe(201);

    const r = await bookSeats(ctx, BOB, vip, seat('A1', 'A2'));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'SEAT_TAKEN', details: { seatIds: seat('A1'), labels: ['A1'] } });
    expect(await activeSeats(ev.id)).toEqual(['A1']);
    expect(await available(ctx, vip)).toBe(4);
    expect((await ctx.db.query('SELECT count(*)::int n FROM orders')).rows[0].n).toBe(1);
  });

  it('30 khách tranh các cặp ghế chồng lấn cùng lúc: mỗi ghế bán tối đa một lần, số vé khớp số ghế', async () => {
    const { ev, vip, seat } = await createSeatedEvent(ctx);
    const pairs = [['A1', 'A2'], ['A2', 'A3'], ['A3', 'A4'], ['A4', 'A5'], ['A5', 'A1']];
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => bookSeats(ctx, customer(`u${i}`), vip, seat(...pairs[i % pairs.length]))),
    );
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(2);
    const sold = ok.flatMap((r) => r.body.seats.map((s: { label: string }) => s.label));
    expect(new Set(sold).size).toBe(sold.length);
    expect(await activeSeats(ev.id)).toEqual([...sold].sort());
    expect(sold.length + (await available(ctx, vip))).toBe(5);
    await assertInvariant(vip);
  });

  it('kiểm tra dữ liệu đặt ghế', async () => {
    const { ev, vip, std, ga, seat } = await createSeatedEvent(ctx);
    const send = (body: object) => ctx.api().post('/api/orders').set('Authorization', ALICE).send(body);

    expect((await bookSeats(ctx, ALICE, ga, seat('A1'))).body.error.code).toBe('SEATS_NOT_ALLOWED');
    expect((await book(ctx, ALICE, vip, 1)).body.error.code).toBe('SEATS_REQUIRED');
    expect((await bookSeats(ctx, ALICE, vip, seat('A1', 'B1'))).body.error).toMatchObject({
      code: 'SEAT_TICKET_TYPE_MISMATCH',
      details: { labels: ['B1'] },
    });
    expect((await bookSeats(ctx, ALICE, vip, ['00000000-0000-4000-8000-000000000000'])).body.error.code).toBe('SEATS_NOT_FOUND');
    expect((await send({ ticketTypeId: vip, seatIds: seat('A1', 'A1') })).status).toBe(400);
    expect((await send({ ticketTypeId: vip, seatIds: seat('A1', 'A2'), quantity: 3 })).status).toBe(400);
    expect((await send({ ticketTypeId: vip, seatIds: [] })).status).toBe(400);
    expect((await send({ ticketTypeId: vip })).status).toBe(400);
    // quantity khớp số ghế thì được chấp nhận
    expect((await send({ ticketTypeId: std, seatIds: seat('B1'), quantity: 1 })).status).toBe(201);

    await ctx.api().patch(`/api/admin/events/${ev.id}/seats`).set('Authorization', ADMIN).send({ seatIds: seat('A5'), blocked: true });
    const blocked = await bookSeats(ctx, ALICE, vip, seat('A5'));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: 'SEAT_BLOCKED', details: { labels: ['A5'] } });
    expect(await available(ctx, vip)).toBe(4);
  });

  it('hủy đơn trả ghế: người khác đặt lại được, đơn cũ vẫn hiện ghế đã đặt', async () => {
    const { ev, vip, seat } = await createSeatedEvent(ctx);
    const a = await bookSeats(ctx, ALICE, vip, seat('A1', 'A2'));
    const c = await ctx.api().post(`/api/orders/${a.body.id}/cancel`).set('Authorization', ALICE).send({});
    expect(c.status).toBe(200);
    expect(c.body.seats.map((s: { label: string }) => s.label)).toEqual(['A1', 'A2']);
    expect(await activeSeats(ev.id)).toEqual([]);
    expect(await available(ctx, vip)).toBe(5);

    expect((await bookSeats(ctx, BOB, vip, seat('A1'))).status).toBe(201);
    expect(await activeSeats(ev.id)).toEqual(['A1']);
    await assertInvariant(vip);
  });

  it('hủy sự kiện trả mọi ghế cùng giao dịch', async () => {
    const { ev, vip, std, seat } = await createSeatedEvent(ctx);
    await bookSeats(ctx, ALICE, vip, seat('A1', 'A2'));
    await bookSeats(ctx, BOB, std, seat('B3'));
    const r = await ctx.api().patch(`/api/admin/events/${ev.id}`).set('Authorization', ADMIN).send({ status: 'CANCELLED' });
    expect(r.body.cancelledOrders).toBe(2);
    expect(await activeSeats(ev.id)).toEqual([]);
    expect(await available(ctx, vip)).toBe(5);
    expect(await available(ctx, std)).toBe(5);
    await assertInvariant(vip);
    await assertInvariant(std);
  });

  it('Idempotency-Key với ghế: gửi lại cùng ghế chỉ tạo 1 đơn; dùng lại key cho ghế khác => 422', async () => {
    const { vip, seat } = await createSeatedEvent(ctx);
    const send = () => bookSeats(ctx, ALICE, vip, seat('A3', 'A4'), 'seat-click-1');
    const [a, b, c] = await Promise.all([send(), send(), send()]);
    expect([a.status, b.status, c.status].sort()).toEqual([200, 200, 201]);
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);
    expect(await available(ctx, vip)).toBe(3);

    // thứ tự ghế khác nhưng cùng tập ghế => vẫn là cùng yêu cầu
    expect((await bookSeats(ctx, ALICE, vip, seat('A4', 'A3'), 'seat-click-1')).status).toBe(200);
    const reused = await bookSeats(ctx, ALICE, vip, seat('A5'), 'seat-click-1');
    expect(reused.status).toBe(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
