import { describe, expect, it } from 'vitest';
import { ADMIN, ALICE, BOB, available, book, createEvent, setupTestApp } from './helpers';

const ctx = setupTestApp();

describe('Tra cứu đơn & quyền truy cập', () => {
  it('khách chỉ thấy đơn của mình', async () => {
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    await book(ctx, BOB, ev.ticketTypes[0].id, 1);

    const mine = await ctx.api().get('/api/orders').set('Authorization', ALICE);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toHaveLength(2);
    expect(mine.body.data.every((o: any) => o.userId === 'alice')).toBe(true);
    expect(mine.body.data[0]).toHaveProperty('event.title');
    expect(mine.body.data[0]).toHaveProperty('ticketType.name');
  });

  it('XEM ĐƠN CỦA NGƯỜI KHÁC => 404 (không lộ thông tin); chủ đơn và admin xem được', async () => {
    const ev = await createEvent(ctx);
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);

    const byBob = await ctx.api().get(`/api/orders/${o.body.id}`).set('Authorization', BOB);
    expect(byBob.status).toBe(404);
    expect(byBob.body.error.code).toBe('ORDER_NOT_FOUND');

    expect((await ctx.api().get(`/api/orders/${o.body.id}`).set('Authorization', ALICE)).status).toBe(200);
    expect((await ctx.api().get(`/api/admin/orders/${o.body.id}`).set('Authorization', ADMIN)).status).toBe(200);
    expect((await ctx.api().get(`/api/orders/${o.body.id}`)).status).toBe(401);
  });

  it('admin tra đơn theo sự kiện và trạng thái; khách không gọi được API admin', async () => {
    const e1 = await createEvent(ctx, { title: 'E1' });
    const e2 = await createEvent(ctx, { title: 'E2' });
    const a = await book(ctx, ALICE, e1.ticketTypes[0].id, 1);
    await book(ctx, BOB, e1.ticketTypes[0].id, 2);
    await book(ctx, BOB, e2.ticketTypes[0].id, 3);
    await ctx.api().post(`/api/orders/${a.body.id}/cancel`).set('Authorization', ALICE);

    const byEvent = await ctx.api().get(`/api/admin/orders?eventId=${e1.id}`).set('Authorization', ADMIN);
    expect(byEvent.body.data).toHaveLength(2);
    expect(byEvent.body.summary).toMatchObject({ CONFIRMED: { orders: 1, tickets: 2 }, CANCELLED: { orders: 1, tickets: 1 } });

    const confirmed = await ctx.api().get(`/api/admin/orders?eventId=${e1.id}&status=CONFIRMED`).set('Authorization', ADMIN);
    expect(confirmed.body.data).toHaveLength(1);
    expect(confirmed.body.data[0].userId).toBe('bob');

    expect((await ctx.api().get('/api/admin/orders?status=XYZ').set('Authorization', ADMIN)).status).toBe(400);
    expect((await ctx.api().get('/api/admin/orders').set('Authorization', ALICE)).status).toBe(403);
  });
});

describe('Hủy đơn', () => {
  it('hủy thành công: cập nhật trạng thái và hoàn vé', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    const o = await book(ctx, ALICE, ttId, 4);
    expect(await available(ctx, ttId)).toBe(6);

    const c = await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE).send({ reason: 'đổi lịch' });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'alice', cancelReason: 'đổi lịch', canCancel: false });
    expect(await available(ctx, ttId)).toBe(10);
  });

  it('HỦY HAI LẦN: lần 2 => 409, vé KHÔNG được hoàn lần nữa', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    const o = await book(ctx, ALICE, ttId, 3);
    await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);
    const again = await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_ALREADY_CANCELLED');
    expect(await available(ctx, ttId)).toBe(10);
  });

  it('HỦY HAI LẦN ĐỒNG THỜI (10 request song song): chỉ 1 thành công, hoàn vé đúng 1 lần', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    const o = await book(ctx, ALICE, ttId, 3);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await available(ctx, ttId)).toBe(10);
    const outbox = await ctx.db.query(`SELECT count(*)::int n FROM outbox_events WHERE event_type='ORDER_CANCELLED'`);
    expect(outbox.rows[0].n).toBe(1);
  });

  it('HỦY ĐƠN CỦA NGƯỜI KHÁC => 404, đơn và vé giữ nguyên', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    const o = await book(ctx, ALICE, ttId, 2);
    const r = await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', BOB);
    expect(r.status).toBe(404);
    expect(await available(ctx, ttId)).toBe(8);
    expect((await ctx.db.query('SELECT status FROM orders WHERE id=$1', [o.body.id])).rows[0].status).toBe('CONFIRMED');
  });

  it('quá hạn hủy (còn < 24h trước giờ diễn) => 422; admin vẫn hủy được', async () => {
    const ev = await createEvent(ctx, { startInHours: 10, ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    expect(o.body.canCancel).toBe(false);

    const r = await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CANCELLATION_WINDOW_CLOSED');
    expect(r.body.error.details).toHaveProperty('cancellationDeadline');

    const byAdmin = await ctx.api().post(`/api/admin/orders/${o.body.id}/cancel`).set('Authorization', ADMIN).send({ reason: 'hỗ trợ khách' });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.cancelledBy).toBe('admin1');
    expect(await available(ctx, ev.ticketTypes[0].id)).toBe(10);
  });

  it('sự kiện bị hủy => đơn đã quá hạn hủy cũng được hủy tự động; khách hủy lại => 409, không hoàn vé lần 2', async () => {
    const ev = await createEvent(ctx, { startInHours: 10 });
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    await ctx.api().patch(`/api/admin/events/${ev.id}`).set('Authorization', ADMIN).send({ status: 'CANCELLED' });
    const mine = await ctx.api().get(`/api/orders/${o.body.id}`).set('Authorization', ALICE);
    expect(mine.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'admin1', cancelReason: 'Sự kiện bị hủy', canCancel: false });
    const again = await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ORDER_ALREADY_CANCELLED');
    expect(await available(ctx, ev.ticketTypes[0].id)).toBe(10);
  });

  it('hủy và đặt chạy song song vẫn giữ đúng bất biến số vé', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 5 }] });
    const ttId = ev.ticketTypes[0].id;
    const first = await book(ctx, ALICE, ttId, 5);
    const ops = await Promise.all([
      ctx.api().post(`/api/orders/${first.body.id}/cancel`).set('Authorization', ALICE),
      ...Array.from({ length: 8 }, (_, i) => book(ctx, `Bearer mock:x${i}:customer`, ttId, 1)),
    ]);
    expect(ops[0].status).toBe(200);
    const r = await ctx.db.query(
      `SELECT t.total_quantity - t.available_quantity AS reserved,
              (SELECT COALESCE(sum(quantity),0)::int FROM orders WHERE ticket_type_id=t.id AND status='CONFIRMED') AS confirmed,
              t.available_quantity
         FROM ticket_types t WHERE id=$1`,
      [ttId],
    );
    expect(r.rows[0].reserved).toBe(r.rows[0].confirmed);
    expect(r.rows[0].available_quantity).toBeGreaterThanOrEqual(0);
  });
});
