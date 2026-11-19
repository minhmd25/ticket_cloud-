import { describe, expect, it } from 'vitest';
import { ADMIN, ALICE, book, bookSeats, createEvent, createSeatedEvent, customer, setupTestApp } from './helpers';

const ctx = setupTestApp();

const HOUR = 3600_000;
const putQueue = (eventId: string, body: Record<string, unknown>, auth = ADMIN) =>
  ctx.api().put(`/api/admin/events/${eventId}/queue`).set('Authorization', auth).send(body);
const settings = (o: Partial<{ enabled: boolean; saleStartAt: string; maxActive: number; accessMinutes: number }> = {}) => ({
  enabled: true,
  saleStartAt: new Date(Date.now() + HOUR).toISOString(),
  maxActive: 2,
  accessMinutes: 10,
  ...o,
});
const join = (eventId: string, auth: string) => ctx.api().post(`/api/events/${eventId}/queue`).set('Authorization', auth);
const me = (eventId: string, auth: string) => ctx.api().get(`/api/events/${eventId}/queue/me`).set('Authorization', auth);
const leave = (eventId: string, auth: string) => ctx.api().delete(`/api/events/${eventId}/queue/me`).set('Authorization', auth);
const tick = () => ctx.services.queueWorker.tickOnce();
/** "tua" tới giờ mở bán: mọi người đã vào hàng trước đó được tính là vào trước giờ mở bán */
const openSale = (eventId: string) => ctx.db.query('UPDATE event_queue_settings SET sale_start_at = now() WHERE event_id = $1', [eventId]);
const users = (n: number, prefix = 'q') => Array.from({ length: n }, (_, i) => customer(`${prefix}${i}`));

/** sự kiện vé thường 100 vé, hàng chờ chưa mở bán */
async function queuedEvent(o: Parameters<typeof settings>[0] = {}) {
  const ev = await createEvent(ctx, { ticketTypes: [{ name: 'Thường', price: 100000, totalQuantity: 100 }] });
  const r = await putQueue(ev.id, settings(o));
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return { ev, tt: ev.ticketTypes[0].id };
}

describe('Hàng chờ ảo', () => {
  it('admin cấu hình hàng chờ; khách không có quyền; chi tiết sự kiện cho biết có hàng chờ', async () => {
    const ev = await createEvent(ctx);
    expect((await ctx.api().get(`/api/admin/events/${ev.id}/queue`).set('Authorization', ADMIN)).body.error.code).toBe(
      'QUEUE_NOT_CONFIGURED',
    );
    expect((await putQueue(ev.id, settings(), ALICE)).status).toBe(403);
    expect((await putQueue(ev.id, settings({ maxActive: 0 }))).status).toBe(400);
    expect((await putQueue(ev.id, { ...settings(), extra: true })).status).toBe(400);

    const saleStartAt = new Date(Date.now() + HOUR).toISOString();
    const r = await putQueue(ev.id, settings({ saleStartAt, maxActive: 3 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true,
      saleStartAt,
      maxActive: 3,
      accessMinutes: 10,
      randomizedAt: null,
      counts: { WAITING: 0, ADMITTED: 0, COMPLETED: 0, EXPIRED: 0, LEFT: 0 },
    });
    const detail = await ctx.api().get(`/api/events/${ev.id}`);
    expect(detail.body.queue).toEqual({ enabled: true, saleStartAt, maxActive: 3, accessMinutes: 10 });
  });

  it('trước giờ mở bán: vào hàng chưa có vị trí, vào lại không tạo lượt mới, chưa đặt được vé', async () => {
    const { ev, tt } = await queuedEvent();
    const first = await join(ev.id, ALICE);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      status: 'WAITING',
      queueEnabled: true,
      position: null,
      aheadOfYou: null,
      waitingCount: 1,
      saleStarted: false,
      retryAfterSeconds: 30,
    });
    expect(first.headers['cache-control']).toBe('no-store');
    expect((await join(ev.id, ALICE)).status).toBe(200);
    expect((await ctx.db.query('SELECT count(*)::int n FROM queue_entries')).rows[0].n).toBe(1);

    const r = await book(ctx, ALICE, tt, 1);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SALE_NOT_STARTED');
    expect((await tick()).events).toBe(0);
    expect((await me(ev.id, ALICE)).body.status).toBe('WAITING');
  });

  it('mở bán: người vào trước được xếp ngẫu nhiên vị trí 1..N, người đến sau đứng tiếp theo thứ tự đến', async () => {
    const { ev } = await queuedEvent({ maxActive: 1 });
    const early = users(8);
    for (const u of early) expect((await join(ev.id, u)).status).toBe(201);
    await openSale(ev.id);

    // người đến sau giờ mở bán, trước khi worker chạy: chính lượt vào hàng này kích hoạt việc xếp ngẫu nhiên
    const late = await join(ev.id, customer('late'));
    expect(late.status).toBe(201);
    expect(late.body).toMatchObject({ position: 9, aheadOfYou: 8, saleStarted: true });

    const positions = [];
    for (const u of early) positions.push((await me(ev.id, u)).body.position);
    expect([...positions].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const s = await ctx.api().get(`/api/admin/events/${ev.id}/queue`).set('Authorization', ADMIN);
    expect(s.body.randomizedAt).not.toBeNull();
    expect((await join(ev.id, customer('later'))).body.position).toBe(10);
  });

  it('cho vào theo thứ tự, tối đa max_active người; aheadOfYou đếm đúng người còn chờ phía trước', async () => {
    const { ev } = await queuedEvent({ maxActive: 2, accessMinutes: 15 });
    const all = users(5);
    for (const u of all) await join(ev.id, u);
    await openSale(ev.id);
    expect(await tick()).toMatchObject({ events: 1, admitted: 2 });

    const states = await Promise.all(all.map(async (u) => (await me(ev.id, u)).body));
    const admitted = states.filter((x) => x.status === 'ADMITTED');
    expect(admitted.map((x) => x.position).sort()).toEqual([1, 2]);
    for (const a of admitted) {
      const minutes = (Date.parse(a.expiresAt) - Date.parse(a.admittedAt)) / 60_000;
      expect(minutes).toBeCloseTo(15, 5);
      expect(a.retryAfterSeconds).toBe(30);
    }
    for (const w of states.filter((x) => x.status === 'WAITING')) {
      expect(w.aheadOfYou).toBe(w.position - 3);
      expect(w.retryAfterSeconds).toBe(5);
    }
    expect((await tick()).admitted).toBe(0);
  });

  it('người đã vào đặt được vé, lượt chuyển COMPLETED và nhường chỗ cho người kế tiếp', async () => {
    const { ev, tt } = await queuedEvent({ maxActive: 1 });
    const [u1, u2] = users(2);
    await join(ev.id, u1);
    await join(ev.id, u2);
    await openSale(ev.id);
    await tick();
    const first = (await me(ev.id, u1)).body.status === 'ADMITTED' ? u1 : u2;
    const second = first === u1 ? u2 : u1;

    const denied = await book(ctx, second, tt, 1);
    expect(denied.status).toBe(409);
    expect(denied.body.error).toMatchObject({ code: 'QUEUE_ADMISSION_REQUIRED', details: { queueStatus: 'WAITING' } });

    // bấm đặt 2 lần cùng Idempotency-Key: 1 đơn, lần sau nhận lại đơn đó
    const send = () => ctx.api().post('/api/orders').set('Authorization', first).set('Idempotency-Key', 'q-1').send({ ticketTypeId: tt, quantity: 2 });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    const done = await me(ev.id, first);
    expect(done.body).toMatchObject({ status: 'COMPLETED', retryAfterSeconds: null });
    expect((await book(ctx, first, tt, 1)).body.error.details.queueStatus).toBe('COMPLETED');

    expect((await tick()).admitted).toBe(1);
    expect((await book(ctx, second, tt, 1)).status).toBe(201);
  });

  it('hết giờ mua => EXPIRED, nhả chỗ; người chờ không hỏi lại bị loại; vào lại thì đứng cuối hàng', async () => {
    const { ev, tt } = await queuedEvent({ maxActive: 1 });
    const all = users(3);
    for (const u of all) await join(ev.id, u);
    await openSale(ev.id);
    await tick();
    const states = await Promise.all(all.map(async (u) => ({ u, body: (await me(ev.id, u)).body })));
    const x = states.find((s) => s.body.status === 'ADMITTED')!;
    const waiting = states.filter((s) => s.body.status === 'WAITING').sort((p, q) => p.body.position - q.body.position);

    // lượt của x hết hạn: hỏi trạng thái thấy EXPIRED ngay, không đặt được vé
    await ctx.db.query(`UPDATE queue_entries SET expires_at = now() - interval '1 second' WHERE user_id = 'q${all.indexOf(x.u)}'`);
    expect((await me(ev.id, x.u)).body).toMatchObject({ status: 'EXPIRED', retryAfterSeconds: null });
    expect((await book(ctx, x.u, tt, 1)).body.error.code).toBe('QUEUE_ADMISSION_REQUIRED');

    // người đứng sau cùng đã đóng trang (không hỏi lại) => bị loại ở nhịp kế tiếp, người kế được vào
    const gone = waiting[1];
    await ctx.db.query(`UPDATE queue_entries SET last_seen_at = now() - interval '1 hour' WHERE user_id = 'q${all.indexOf(gone.u)}'`);
    expect(await tick()).toMatchObject({ dropped: 1, admitted: 1 });
    expect((await me(ev.id, waiting[0].u)).body.status).toBe('ADMITTED');
    expect((await me(ev.id, gone.u)).body.status).toBe('EXPIRED');

    const back = await join(ev.id, gone.u);
    expect(back.status).toBe(201);
    expect(back.body).toMatchObject({ status: 'WAITING', position: 4, aheadOfYou: 0 });
  });

  it('rời hàng; gọi lại không lỗi; chưa từng vào hàng => 404', async () => {
    const { ev } = await queuedEvent();
    expect((await me(ev.id, ALICE)).body.error.code).toBe('QUEUE_ENTRY_NOT_FOUND');
    expect((await leave(ev.id, ALICE)).status).toBe(404);
    await join(ev.id, ALICE);
    expect((await leave(ev.id, ALICE)).body.status).toBe('LEFT');
    expect((await leave(ev.id, ALICE)).body.status).toBe('LEFT');
    expect((await join(ev.id, ALICE)).status).toBe(201);
  });

  it('không bật hàng chờ: đặt vé trực tiếp, không vào hàng được; tắt giữa chừng thì frontend được báo', async () => {
    const plain = await createEvent(ctx);
    expect((await join(plain.id, ALICE)).body.error.code).toBe('QUEUE_NOT_ENABLED');
    expect((await book(ctx, ALICE, plain.ticketTypes[0].id, 1)).status).toBe(201);

    const { ev, tt } = await queuedEvent();
    await join(ev.id, ALICE);
    await putQueue(ev.id, settings({ enabled: false }));
    expect((await me(ev.id, ALICE)).body).toMatchObject({ queueEnabled: false, retryAfterSeconds: null });
    expect((await book(ctx, ALICE, tt, 1)).status).toBe(201);
    expect((await join(ev.id, customer('x'))).body.error.code).toBe('QUEUE_NOT_ENABLED');
  });

  it('đồng thời: nhiều worker cùng chạy không cho vào quá max_active; nhiều người vào hàng cùng lúc nhận vị trí khác nhau', async () => {
    const { ev } = await queuedEvent({ maxActive: 3 });
    for (const u of users(6, 'pre')) await join(ev.id, u);
    await openSale(ev.id);
    await Promise.all([tick(), tick(), tick(), tick()]);
    const n = await ctx.db.query(`SELECT count(*)::int n FROM queue_entries WHERE status = 'ADMITTED'`);
    expect(n.rows[0].n).toBe(3);

    const joined = await Promise.all(users(20, 'post').map((u) => join(ev.id, u)));
    expect(joined.every((r) => r.status === 201)).toBe(true);
    const pos = joined.map((r) => r.body.position);
    expect(new Set(pos).size).toBe(20);
    expect(Math.min(...pos)).toBe(7);
    expect(Math.max(...pos)).toBe(26);
  });

  it('sau khi mở bán không đổi được giờ mở bán, các thông số khác vẫn đổi được', async () => {
    const { ev } = await queuedEvent();
    await openSale(ev.id);
    await tick();
    const cur = (await ctx.api().get(`/api/admin/events/${ev.id}/queue`).set('Authorization', ADMIN)).body;
    const moved = await putQueue(ev.id, settings({ saleStartAt: new Date(Date.now() + 2 * HOUR).toISOString() }));
    expect(moved.status).toBe(409);
    expect(moved.body.error.code).toBe('QUEUE_ALREADY_STARTED');
    const ok = await putQueue(ev.id, settings({ saleStartAt: cur.saleStartAt, maxActive: 50 }));
    expect(ok.status).toBe(200);
    expect(ok.body.maxActive).toBe(50);
  });

  it('đặt ghế qua hàng chờ: phải tới lượt mới chọn được ghế; admin chạy một nhịp worker qua API', async () => {
    const { ev, vip, seat } = await createSeatedEvent(ctx);
    await putQueue(ev.id, settings({ maxActive: 1 }));
    expect((await bookSeats(ctx, ALICE, vip, seat('A1'))).body.error.code).toBe('SALE_NOT_STARTED');
    await join(ev.id, ALICE);
    await openSale(ev.id);
    const t = await ctx.api().post(`/api/admin/events/${ev.id}/queue/tick`).set('Authorization', ADMIN);
    expect(t.status).toBe(200);
    expect(t.body.tick).toMatchObject({ events: 1, admitted: 1 });
    expect(t.body.settings.counts.ADMITTED).toBe(1);

    const r = await bookSeats(ctx, ALICE, vip, seat('A1', 'A2'));
    expect(r.status).toBe(201);
    expect((await me(ev.id, ALICE)).body.status).toBe('COMPLETED');
  });
});
