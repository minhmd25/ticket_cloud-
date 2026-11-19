import { describe, expect, it } from 'vitest';
import { ADMIN, ALICE, available, book, createEvent, customer, setupTestApp } from './helpers';

const ctx = setupTestApp();

describe('Đặt vé', () => {
  it('lấy người đặt từ phiên và giá từ DB (bỏ qua giá/userId client gửi lên)', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 150000, totalQuantity: 10 }] });
    const res = await ctx
      .api()
      .post('/api/orders')
      .set('Authorization', ALICE)
      .send({ ticketTypeId: ev.ticketTypes[0].id, quantity: 3, unitPrice: 1, totalAmount: 1, userId: 'hacker' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ userId: 'alice', status: 'CONFIRMED', quantity: 3, unitPrice: 150000, totalAmount: 450000 });
    expect(await available(ctx, ev.ticketTypes[0].id)).toBe(7);
  });

  it('chưa đăng nhập => 401; dữ liệu sai => 400', async () => {
    const ev = await createEvent(ctx);
    expect((await ctx.api().post('/api/orders').send({ ticketTypeId: ev.ticketTypes[0].id, quantity: 1 })).status).toBe(401);
    for (const q of [0, -1, 1.5, '2']) {
      expect((await book(ctx, ALICE, ev.ticketTypes[0].id, q as number)).status).toBe(400);
    }
    expect((await book(ctx, ALICE, 'khong-phai-uuid', 1)).status).toBe(400);
    expect((await book(ctx, ALICE, '00000000-0000-4000-8000-000000000000', 1)).status).toBe(404);
  });

  it('đặt vượt số lượng còn lại => 409 INSUFFICIENT_TICKETS, không thay đổi gì', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 5 }] });
    const ttId = ev.ticketTypes[0].id;
    await book(ctx, ALICE, ttId, 3);
    const r = await book(ctx, customer('carol'), ttId, 3);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'INSUFFICIENT_TICKETS', details: { requested: 3, available: 2 } });
    expect(await available(ctx, ttId)).toBe(2);
    expect((await ctx.db.query('SELECT count(*)::int n FROM orders')).rows[0].n).toBe(1);
  });

  it('hết vé => 409 SOLD_OUT', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 2 }] });
    await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    const r = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SOLD_OUT');
  });

  it('vượt giới hạn vé mỗi đơn => 422', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 100 }] });
    const r = await book(ctx, ALICE, ev.ticketTypes[0].id, 11);
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('QUANTITY_EXCEEDS_LIMIT');
  });

  it('không đặt được vé của sự kiện chưa mở bán / đã hủy / đã diễn ra', async () => {
    const draft = await createEvent(ctx, { status: 'DRAFT' });
    expect((await book(ctx, ALICE, draft.ticketTypes[0].id, 1)).body.error.code).toBe('EVENT_NOT_OPEN');

    const ev = await createEvent(ctx);
    await ctx.api().patch(`/api/admin/events/${ev.id}`).set('Authorization', ADMIN).send({ status: 'CANCELLED' });
    expect((await book(ctx, ALICE, ev.ticketTypes[0].id, 1)).body.error.code).toBe('EVENT_CANCELLED');

    const past = await createEvent(ctx, { startInHours: -1 });
    expect((await book(ctx, ALICE, past.ticketTypes[0].id, 1)).body.error.code).toBe('EVENT_ALREADY_STARTED');
  });

  it('HAI KHÁCH ĐẶT VÉ CUỐI cùng lúc: đúng 1 người thành công, vé không âm', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'Vé cuối', price: 1000, totalQuantity: 1 }] });
    const ttId = ev.ticketTypes[0].id;
    const [a, b] = await Promise.all([book(ctx, ALICE, ttId, 1), book(ctx, customer('bob'), ttId, 1)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a, b].find((r) => r.status === 409)!.body.error.code).toBe('SOLD_OUT');
    expect(await available(ctx, ttId)).toBe(0);
    expect((await ctx.db.query(`SELECT count(*)::int n FROM orders WHERE status='CONFIRMED'`)).rows[0].n).toBe(1);
  });

  it('50 yêu cầu đồng thời tranh 10 vé: bán đúng 10 vé, không âm, không bán vượt', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'Hot', price: 1000, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => book(ctx, customer(`u${i}`), ttId, 1 + (i % 3))),
    );
    const ok = results.filter((r) => r.status === 201);
    const sold = ok.reduce((s, r) => s + r.body.quantity, 0);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const left = await available(ctx, ttId);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(sold + left).toBe(10);
    const db = await ctx.db.query(`SELECT COALESCE(sum(quantity),0)::int s FROM orders WHERE ticket_type_id=$1 AND status='CONFIRMED'`, [ttId]);
    expect(db.rows[0].s).toBe(sold);
  });

  it('GIAO DỊCH: một bước lỗi (ghi outbox) => hoàn tác toàn bộ (không trừ vé, không có đơn)', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 5 }] });
    const ttId = ev.ticketTypes[0].id;
    // giả lập lỗi ở bước cuối của giao dịch đặt vé
    await ctx.db.query(`
      CREATE OR REPLACE FUNCTION test_fail_outbox() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'giả lập lỗi ghi outbox'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_outbox BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION test_fail_outbox();`);
    try {
      const r = await book(ctx, ALICE, ttId, 2);
      expect(r.status).toBe(500);
      expect(await available(ctx, ttId)).toBe(5);
      expect((await ctx.db.query('SELECT count(*)::int n FROM orders')).rows[0].n).toBe(0);
    } finally {
      await ctx.db.query('DROP TRIGGER test_fail_outbox ON outbox_events; DROP FUNCTION test_fail_outbox();');
    }
  });

  it('Idempotency-Key: gửi lại cùng yêu cầu chỉ tạo 1 đơn', async () => {
    const ev = await createEvent(ctx);
    const ttId = ev.ticketTypes[0].id;
    const send = () =>
      ctx.api().post('/api/orders').set('Authorization', ALICE).set('Idempotency-Key', 'click-123').send({ ticketTypeId: ttId, quantity: 2 });
    const [a, b, c] = await Promise.all([send(), send(), send()]);
    expect([a.status, b.status, c.status].sort()).toEqual([200, 200, 201]);
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);
    expect(await available(ctx, ttId)).toBe(8);

    const reused = await ctx.api().post('/api/orders').set('Authorization', ALICE).set('Idempotency-Key', 'click-123').send({ ticketTypeId: ttId, quantity: 1 });
    expect(reused.status).toBe(422);
  });
});
