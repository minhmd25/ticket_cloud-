import { describe, expect, it } from 'vitest';
import { ADMIN, ALICE, available, book, createEvent, setupTestApp } from './helpers';

const ctx = setupTestApp();

describe('API sự kiện (công khai)', () => {
  it('lọc danh sách theo loại hình, ẩn sự kiện DRAFT', async () => {
    await createEvent(ctx, { category: 'concert', title: 'A' });
    await createEvent(ctx, { category: 'sport', title: 'B' });
    await createEvent(ctx, { category: 'concert', title: 'C nháp', status: 'DRAFT' });

    const all = await ctx.api().get('/api/events');
    expect(all.status).toBe(200);
    expect(all.body.data.map((e: any) => e.title).sort()).toEqual(['A', 'B']);

    const concerts = await ctx.api().get('/api/events?category=concert');
    expect(concerts.body.data).toHaveLength(1);
    expect(concerts.body.data[0]).toMatchObject({ title: 'A', category: 'concert', minPrice: 100000, totalAvailable: 10 });
    expect(concerts.body.pagination).toMatchObject({ page: 1, total: 1 });
  });

  it('chi tiết sự kiện kèm hạng vé, giá, số lượng còn lại', async () => {
    const ev = await createEvent(ctx, {
      ticketTypes: [
        { name: 'VIP', price: 500000, totalQuantity: 5 },
        { name: 'Thường', price: 100000, totalQuantity: 10 },
      ],
    });
    await book(ctx, ALICE, ev.ticketTypes.find((t) => t.name === 'VIP')!.id, 2);

    const res = await ctx.api().get(`/api/events/${ev.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ticketTypes).toHaveLength(2);
    const vip = res.body.ticketTypes.find((t: any) => t.name === 'VIP');
    expect(vip).toMatchObject({ price: 500000, totalQuantity: 5, availableQuantity: 3, reservedQuantity: 2, soldOut: false });
  });

  it('sự kiện DRAFT hoặc không tồn tại => 404; id sai định dạng => 400', async () => {
    const draft = await createEvent(ctx, { status: 'DRAFT' });
    expect((await ctx.api().get(`/api/events/${draft.id}`)).status).toBe(404);
    expect((await ctx.api().get('/api/events/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await ctx.api().get('/api/events/abc')).status).toBe(400);
  });
});

describe('API quản trị sự kiện & hạng vé', () => {
  const validEvent = () => ({
    title: 'X',
    category: 'concert',
    venue: 'HN',
    startTime: new Date(Date.now() + 86400_000).toISOString(),
    endTime: new Date(Date.now() + 90000_000).toISOString(),
  });

  it('yêu cầu đăng nhập (401) và quyền admin (403)', async () => {
    expect((await ctx.api().post('/api/admin/events').send(validEvent())).status).toBe(401);
    const r = await ctx.api().post('/api/admin/events').set('Authorization', ALICE).send(validEvent());
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    expect((await ctx.api().post('/api/admin/events').set('Authorization', 'Bearer rác')).status).toBe(401);
  });

  it('từ chối giá âm, số lượng không hợp lệ, giờ kết thúc trước giờ bắt đầu', async () => {
    const cases = [
      { ...validEvent(), ticketTypes: [{ name: 'A', price: -1, totalQuantity: 10 }] },
      { ...validEvent(), ticketTypes: [{ name: 'A', price: 1000, totalQuantity: -5 }] },
      { ...validEvent(), ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 2.5 }] },
      { ...validEvent(), ticketTypes: [{ name: 'A', price: 'abc', totalQuantity: 1 }] },
      { ...validEvent(), endTime: new Date(Date.now()).toISOString() },
      { ...validEvent(), title: '' },
    ];
    for (const body of cases) {
      const r = await ctx.api().post('/api/admin/events').set('Authorization', ADMIN).send(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect((await ctx.db.query('SELECT count(*)::int n FROM events')).rows[0].n).toBe(0);
  });

  it('tạo, sửa sự kiện và thêm hạng vé', async () => {
    const ev = await createEvent(ctx, { status: 'DRAFT' });
    const upd = await ctx.api().patch(`/api/admin/events/${ev.id}`).set('Authorization', ADMIN).send({ status: 'PUBLISHED', title: 'Mới' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ status: 'PUBLISHED', title: 'Mới' });

    const tt = await ctx.api().post(`/api/admin/events/${ev.id}/ticket-types`).set('Authorization', ADMIN).send({ name: 'VIP', price: 250000.5, totalQuantity: 3 });
    expect(tt.status).toBe(201);
    expect(tt.body).toMatchObject({ name: 'VIP', price: 250000.5, totalQuantity: 3, availableQuantity: 3 });

    const dup = await ctx.api().post(`/api/admin/events/${ev.id}/ticket-types`).set('Authorization', ADMIN).send({ name: 'VIP', price: 1, totalQuantity: 1 });
    expect(dup.status).toBe(409);

    const badPrice = await ctx.api().patch(`/api/admin/ticket-types/${tt.body.id}`).set('Authorization', ADMIN).send({ price: -100 });
    expect(badPrice.status).toBe(400);

    const badTime = await ctx.api().patch(`/api/admin/events/${ev.id}`).set('Authorization', ADMIN).send({ endTime: new Date(0).toISOString() });
    expect(badTime.status).toBe(400);
  });

  it('KHÔNG cho giảm tổng số vé xuống dưới số vé đang được giữ trong đơn hợp lệ', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'Thường', price: 100, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    await book(ctx, ALICE, ttId, 6); // giữ 6

    const tooLow = await ctx.api().patch(`/api/admin/ticket-types/${ttId}`).set('Authorization', ADMIN).send({ totalQuantity: 5 });
    expect(tooLow.status).toBe(409);
    expect(tooLow.body.error).toMatchObject({ code: 'QUANTITY_BELOW_RESERVED', details: { requested: 5, reserved: 6 } });
    expect(await available(ctx, ttId)).toBe(4);

    const exact = await ctx.api().patch(`/api/admin/ticket-types/${ttId}`).set('Authorization', ADMIN).send({ totalQuantity: 6 });
    expect(exact.status).toBe(200);
    expect(exact.body).toMatchObject({ totalQuantity: 6, availableQuantity: 0, reservedQuantity: 6, soldOut: true });

    const up = await ctx.api().patch(`/api/admin/ticket-types/${ttId}`).set('Authorization', ADMIN).send({ totalQuantity: 20 });
    expect(up.body).toMatchObject({ totalQuantity: 20, availableQuantity: 14 });
  });

  it('đơn đã hủy không được tính là vé đang giữ', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'Thường', price: 100, totalQuantity: 10 }] });
    const ttId = ev.ticketTypes[0].id;
    const o = await book(ctx, ALICE, ttId, 6);
    await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);
    const r = await ctx.api().patch(`/api/admin/ticket-types/${ttId}`).set('Authorization', ADMIN).send({ totalQuantity: 0 });
    expect(r.status).toBe(200);
    expect(r.body.availableQuantity).toBe(0);
  });
});
