import { describe, expect, it } from 'vitest';
import { buildTheaterLayout } from '../src/seating/theater';
import { validateLayout } from '../src/seating/geometry';
import {
  ADMIN,
  ALICE,
  book,
  bookSeats,
  createEvent,
  createSeatedEvent,
  putSeatMap,
  seatRow,
  setupTestApp,
  tierId,
} from './helpers';

const ctx = setupTestApp();

const getTier = async (eventId: string, name: string) =>
  (await ctx.api().get(`/api/admin/events/${eventId}`).set('Authorization', ADMIN)).body.ticketTypes.find((t: any) => t.name === name);

const baseMap = (vip: string, std: string, version = 0) => ({
  version,
  width: 600,
  height: 400,
  sections: [{ key: 'giua', name: 'Khu giữa' }],
  seats: [...seatRow(vip, 'A', 5, 40, { section: 'giua' }), ...seatRow(std, 'B', 5, 80)],
});

describe('Sơ đồ ghế - quản trị', () => {
  it('lưu sơ đồ: version 1, khách xem được, tổng vé hạng ASSIGNED = số ghế, hạng thường không đổi', async () => {
    const { ev, vip, std } = await createSeatedEvent(ctx);

    const detail = await ctx.api().get(`/api/events/${ev.id}`);
    expect(detail.body.seatMap).toEqual({ version: 1 });
    expect(detail.body.queue).toBeNull();
    const byName = Object.fromEntries(detail.body.ticketTypes.map((t: any) => [t.name, t]));
    expect(byName['VIP']).toMatchObject({ seating: 'ASSIGNED', totalQuantity: 5, availableQuantity: 5 });
    expect(byName['Thường']).toMatchObject({ seating: 'ASSIGNED', totalQuantity: 5, availableQuantity: 5 });
    expect(byName['Đứng']).toMatchObject({ seating: 'GENERAL', totalQuantity: 50, availableQuantity: 50 });

    const map = await ctx.api().get(`/api/events/${ev.id}/seat-map`);
    expect(map.status).toBe(200);
    expect(map.body).toMatchObject({ version: 1, width: 600, height: 400, seatSize: 24, sections: [{ key: 'giua', name: 'Khu giữa' }] });
    expect(map.body.decorations).toEqual([{ type: 'stage', x: 0, y: 0, width: 600, height: 20 }]);
    expect(map.body.seats).toHaveLength(10);
    const a1 = map.body.seats.find((s: any) => s.label === 'A1');
    expect(a1).toMatchObject({ row: 'A', section: 'giua', ticketTypeId: vip, x: 40, y: 40, rotation: 0, accessible: false, blocked: false });
    expect(map.body.seats.find((s: any) => s.label === 'B1')).toMatchObject({ section: null, ticketTypeId: std });

    expect((await putSeatMap(ctx, ev.id, baseMap(vip, std, 1), ALICE)).status).toBe(403);
    expect((await ctx.api().put(`/api/admin/events/${ev.id}/seat-map`).send(baseMap(vip, std, 1))).status).toBe(401);
  });

  it('kiểm tra bố cục: trùng nhãn, ngoài khung, chồng nhau, khu không tồn tại => 400 kèm chi tiết, không lưu gì', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'VIP', price: 1000, seating: 'ASSIGNED' }] });
    const vip = tierId(ev, 'VIP');
    const cases: [Record<string, unknown>[], string][] = [
      [[{ label: 'A1', ticketTypeId: vip, x: 40, y: 40 }, { label: 'A1', ticketTypeId: vip, x: 100, y: 40 }], 'trùng'],
      [[{ label: 'A1', ticketTypeId: vip, x: 595, y: 40 }], 'ngoài khung'],
      [[{ label: 'A1', ticketTypeId: vip, x: 40, y: 40 }, { label: 'A2', ticketTypeId: vip, x: 50, y: 45 }], 'chồng lên'],
      [[{ label: 'A1', ticketTypeId: vip, x: 40, y: 40, section: 'khong-co' }], 'không có trong sections'],
    ];
    for (const [seats, msg] of cases) {
      const r = await putSeatMap(ctx, ev.id, { version: 0, width: 600, height: 400, seats });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(r.body.error.details)).toContain(msg);
    }
    // ghế sát nhau đúng bằng đường kính thì hợp lệ
    const touching = await putSeatMap(ctx, ev.id, {
      version: 0, width: 600, height: 400,
      seats: [{ label: 'A1', ticketTypeId: vip, x: 40, y: 40 }, { label: 'A2', ticketTypeId: vip, x: 64, y: 40 }],
    });
    expect(touching.status).toBe(200);
    expect((await putSeatMap(ctx, ev.id, { version: 1, width: 600, height: 400, seats: [], extra: 1 })).status).toBe(400);
  });

  it('ghế phải thuộc hạng vé ASSIGNED của chính sự kiện => 422 INVALID_SEAT_TICKET_TYPE', async () => {
    const { ev, ga } = await createSeatedEvent(ctx);
    const other = await createEvent(ctx, { ticketTypes: [{ name: 'X', price: 1, seating: 'ASSIGNED' }] });
    for (const tt of [ga, tierId(other, 'X')]) {
      const r = await putSeatMap(ctx, ev.id, { version: 1, width: 600, height: 400, seats: [{ label: 'Z1', ticketTypeId: tt, x: 40, y: 40 }] });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('INVALID_SEAT_TICKET_TYPE');
    }
  });

  it('khóa lạc quan theo version: sửa trên bản cũ => 409 SEAT_MAP_VERSION_CONFLICT', async () => {
    const { ev, vip, std } = await createSeatedEvent(ctx);
    const stale = await putSeatMap(ctx, ev.id, baseMap(vip, std, 0));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'SEAT_MAP_VERSION_CONFLICT', details: { currentVersion: 1, yourVersion: 0 } });
    const ok = await putSeatMap(ctx, ev.id, baseMap(vip, std, 1));
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
  });

  it('ETag: 304 khi sơ đồ chưa đổi, ETag mới sau khi sửa', async () => {
    const { ev, vip, std } = await createSeatedEvent(ctx);
    const first = await ctx.api().get(`/api/events/${ev.id}/seat-map`);
    const etag = first.headers.etag;
    expect(etag).toBe('W/"seat-map-v1"');
    expect(first.headers['cache-control']).toBe('no-cache');

    const again = await ctx.api().get(`/api/events/${ev.id}/seat-map`).set('If-None-Match', etag);
    expect(again.status).toBe(304);

    await putSeatMap(ctx, ev.id, { ...baseMap(vip, std, 1), seats: seatRow(vip, 'A', 3, 40) });
    const changed = await ctx.api().get(`/api/events/${ev.id}/seat-map`).set('If-None-Match', etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.etag).toBe('W/"seat-map-v2"');
    expect(changed.body.seats).toHaveLength(3);
  });

  it('ghế đã bán: không xóa / đổi hạng / khóa được, nhưng dời vị trí được và giữ nguyên id', async () => {
    const { ev, vip, std, seat } = await createSeatedEvent(ctx);
    const [a1] = seat('A1');
    expect((await bookSeats(ctx, ALICE, vip, [a1])).status).toBe(201);

    const without = baseMap(vip, std, 1);
    without.seats = without.seats.filter((s) => s.label !== 'A1');
    const retier = baseMap(vip, std, 1);
    retier.seats = retier.seats.map((s) => (s.label === 'A1' ? { ...s, ticketTypeId: std } : s));
    const blocked = baseMap(vip, std, 1);
    blocked.seats = blocked.seats.map((s) => (s.label === 'A1' ? { ...s, blocked: true } : s));
    for (const body of [without, retier, blocked]) {
      const r = await putSeatMap(ctx, ev.id, body);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('SEAT_SOLD_LOCKED');
      expect(r.body.error.details.seats[0].label).toBe('A1');
    }

    const moved = baseMap(vip, std, 1);
    moved.seats = moved.seats.map((s) => (s.label === 'A1' ? { ...s, x: 300, y: 300 } : s));
    const r = await putSeatMap(ctx, ev.id, moved);
    expect(r.status).toBe(200);
    expect(r.body.seats.find((s: any) => s.label === 'A1')).toMatchObject({ id: a1, x: 300, y: 300 });
    expect(await getTier(ev.id, 'VIP')).toMatchObject({ totalQuantity: 5, availableQuantity: 4, reservedQuantity: 1 });
  });

  it('khóa / mở ghế: cập nhật số vé còn lại, trạng thái ghế và version; không khóa ghế đã bán', async () => {
    const { ev, vip, seat } = await createSeatedEvent(ctx);
    const patch = (seatIds: string[], blocked: boolean) =>
      ctx.api().patch(`/api/admin/events/${ev.id}/seats`).set('Authorization', ADMIN).send({ seatIds, blocked });

    const r = await patch(seat('A2', 'A3'), true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ version: 2, changed: 2 });
    expect(await getTier(ev.id, 'VIP')).toMatchObject({ totalQuantity: 3, availableQuantity: 3 });
    const status = await ctx.api().get(`/api/events/${ev.id}/seats/status`);
    expect(status.body).toMatchObject({ version: 2, sold: [] });
    expect([...status.body.blocked].sort()).toEqual(seat('A2', 'A3').sort());

    // khóa lại ghế đã khóa: không đổi gì, không tăng version
    expect((await patch(seat('A2'), true)).body).toEqual({ version: 2, changed: 0 });

    await bookSeats(ctx, ALICE, vip, seat('A1'));
    const sold = await patch(seat('A1'), true);
    expect(sold.status).toBe(409);
    expect(sold.body.error.code).toBe('SEAT_SOLD_LOCKED');

    expect((await patch(seat('A2', 'A3'), false)).body.changed).toBe(2);
    expect(await getTier(ev.id, 'VIP')).toMatchObject({ totalQuantity: 5, availableQuantity: 4 });
    expect((await patch(['00000000-0000-4000-8000-000000000000'], true)).body.error.code).toBe('SEATS_NOT_FOUND');
  });

  it('chép sơ đồ từ sự kiện khác, ghép hạng vé theo tên', async () => {
    const src = await createSeatedEvent(ctx);
    const dst = await createEvent(ctx, {
      ticketTypes: [
        { name: 'VIP', price: 900000, seating: 'ASSIGNED' },
        { name: 'Thường', price: 300000, seating: 'ASSIGNED' },
      ],
    });
    const r = await ctx
      .api()
      .post(`/api/admin/events/${dst.id}/seat-map/copy-from/${src.ev.id}`)
      .set('Authorization', ADMIN)
      .send({ version: 0 });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(r.body.seats).toHaveLength(10);
    expect(r.body.sections).toEqual([{ key: 'giua', name: 'Khu giữa', color: '#336699' }]);
    expect(r.body.seats.find((s: any) => s.label === 'A1').ticketTypeId).toBe(tierId(dst, 'VIP'));
    expect(r.body.seats.every((s: any) => !src.map.seats.some((o: any) => o.id === s.id))).toBe(true);
    expect(await getTier(dst.id, 'Thường')).toMatchObject({ totalQuantity: 5, availableQuantity: 5 });

    const missing = await createEvent(ctx, { ticketTypes: [{ name: 'VIP', price: 1, seating: 'ASSIGNED' }] });
    const bad = await ctx
      .api()
      .post(`/api/admin/events/${missing.id}/seat-map/copy-from/${src.ev.id}`)
      .set('Authorization', ADMIN)
      .send({ version: 0 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toMatchObject({ code: 'TICKET_TYPE_MAPPING_FAILED', details: { missing: ['Thường'] } });
  });

  it('hạng vé theo ghế: không nhập tay tổng số vé, không đổi cách bán khi đã có ghế hoặc đơn', async () => {
    const { ev, vip, ga } = await createSeatedEvent(ctx);
    const patchTier = (id: string, body: object) => ctx.api().patch(`/api/admin/ticket-types/${id}`).set('Authorization', ADMIN).send(body);

    expect((await patchTier(vip, { totalQuantity: 100 })).body.error.code).toBe('SEAT_MANAGED_QUANTITY');
    expect((await patchTier(vip, { seating: 'GENERAL' })).body.error.code).toBe('TICKET_TYPE_HAS_SEATS');
    expect((await patchTier(vip, { seating: 'ASSIGNED', totalQuantity: 5 })).status).toBe(400);

    const addBad = await ctx
      .api()
      .post(`/api/admin/events/${ev.id}/ticket-types`)
      .set('Authorization', ADMIN)
      .send({ name: 'Ban công', price: 1, seating: 'ASSIGNED', totalQuantity: 5 });
    expect(addBad.status).toBe(400);
    const add = await ctx
      .api()
      .post(`/api/admin/events/${ev.id}/ticket-types`)
      .set('Authorization', ADMIN)
      .send({ name: 'Ban công', price: 1, seating: 'ASSIGNED' });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ seating: 'ASSIGNED', totalQuantity: 0, availableQuantity: 0 });

    expect((await book(ctx, ALICE, ga, 1)).status).toBe(201);
    expect((await patchTier(ga, { seating: 'ASSIGNED' })).body.error.code).toBe('TICKET_TYPE_HAS_ORDERS');

    // hạng ASSIGNED chưa có ghế => đổi sang GENERAL kèm tổng số vé
    const toGeneral = await patchTier(add.body.id, { seating: 'GENERAL', totalQuantity: 30 });
    expect(toGeneral.status).toBe(200);
    expect(toGeneral.body).toMatchObject({ seating: 'GENERAL', totalQuantity: 30, availableQuantity: 30 });
  });

  it('sự kiện DRAFT: admin xem được, khách không; sự kiện đã hủy thì không sửa sơ đồ được', async () => {
    const { ev, vip, std } = await createSeatedEvent(ctx, { status: 'DRAFT' });
    expect((await ctx.api().get(`/api/events/${ev.id}/seat-map`)).body.error.code).toBe('EVENT_NOT_FOUND');
    expect((await ctx.api().get(`/api/events/${ev.id}/seats/status`)).status).toBe(404);
    expect((await ctx.api().get(`/api/admin/events/${ev.id}/seat-map`).set('Authorization', ADMIN)).status).toBe(200);

    const none = await createEvent(ctx);
    expect((await ctx.api().get(`/api/events/${none.id}/seat-map`)).body.error.code).toBe('SEAT_MAP_NOT_FOUND');

    await ctx.api().patch(`/api/admin/events/${ev.id}`).set('Authorization', ADMIN).send({ status: 'CANCELLED' });
    const r = await putSeatMap(ctx, ev.id, baseMap(vip, std, 1));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('EVENT_CANCELLED');
  });

  it('sơ đồ lớn: 5000 ghế lưu được (body > 100kb), 5001 ghế bị từ chối; sơ đồ nhà hát hàng cong hợp lệ', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'Ghế', price: 1000, seating: 'ASSIGNED' }] });
    const tt = tierId(ev, 'Ghế');
    const grid = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ label: `S${i + 1}`, ticketTypeId: tt, x: 20 + (i % 100) * 26, y: 20 + Math.floor(i / 100) * 26 }));
    const big = await putSeatMap(ctx, ev.id, { version: 0, width: 2700, height: 1400, seats: grid(5000) });
    expect(big.status).toBe(200);
    expect(big.body.seats).toHaveLength(5000);
    expect(await getTier(ev.id, 'Ghế')).toMatchObject({ totalQuantity: 5000, availableQuantity: 5000 });
    const tooMany = await putSeatMap(ctx, ev.id, { version: 1, width: 2700, height: 1400, seats: grid(5001) });
    expect(tooMany.status).toBe(400);

    const layout = buildTheaterLayout({ front: tt, middle: tt, back: tt });
    expect(validateLayout(layout)).toEqual([]);
    expect(layout.seats.length).toBeGreaterThan(300);
    expect(new Set(layout.seats.map((s) => s.section))).toEqual(new Set(['trai', 'giua', 'phai']));
  });
});
