import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { HttpStatsSource, StatsService } from '../src/stats/client';
import { ADMIN, ALICE, BOB, book, createEvent, setupTestApp } from './helpers';

const ctx = setupTestApp();

/** Server giả lập API thống kê của Azure: GET /stats, GET /history */
let mode: 'ok' | 'slow' | 'error500' | 'unauthorized' | 'badrequest' | 'badshape' = 'ok';
let lastReq: { url: string; key: string | undefined } | null = null;
let azure: Server;
let azureUrl = '';
const counts = (b: number, c: number) => ({ bookedTickets: b, cancelledTickets: c, bookedOrders: b ? 1 : 0, cancelledOrders: c ? 1 : 0, netTickets: b - c });
let fakeItems: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  azure = createServer((req, res) => {
    lastReq = { url: req.url ?? '', key: req.headers['x-functions-key'] as string | undefined };
    if (!req.headers['x-functions-key']) return void res.writeHead(401).end();
    if (mode === 'slow') return void setTimeout(() => res.end('{}'), 1000);
    if (mode === 'error500') return void res.writeHead(500).end('boom');
    if (mode === 'unauthorized') return void res.writeHead(401).end();
    if (mode === 'badrequest') return void res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'from phải <= to' } }));
    if (mode === 'badshape') return void res.writeHead(200).end(JSON.stringify({ hello: 1 }));
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/api/history') {
      return void res.writeHead(200).end(JSON.stringify({ orderId: u.searchParams.get('orderId'), items: [{ messageId: 'known-id', type: 'BOOKED' }] }));
    }
    const items = fakeItems;
    const totals = items.reduce<Record<string, number>>((t, i) => {
      for (const k of Object.keys(counts(0, 0))) t[k] = (t[k] ?? 0) + (i[k] as number);
      return t;
    }, {});
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ groupBy: u.searchParams.get('groupBy'), items, totals: { ...counts(0, 0), ...totals } }));
  });
  await new Promise<void>((r) => azure.listen(0, r));
  azureUrl = `http://127.0.0.1:${(azure.address() as AddressInfo).port}/api`;
});
afterAll(() => new Promise((r) => azure.close(r)));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof AppError ? `${e.status} ${e.code}` : String(e);
  }
};

describe('Thống kê - nguồn mock-local (giả lập API /stats của Azure từ DB)', () => {
  it('theo ngày: đủ từng ngày (fillGaps), ngày theo giờ VN, kèm doanh thu từ DB', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    await book(ctx, ALICE, ev.ticketTypes[0].id, 3);
    const b = await book(ctx, BOB, ev.ticketTypes[0].id, 2);
    await ctx.api().post(`/api/orders/${b.body.id}/cancel`).set('Authorization', BOB);

    const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
    const r = await ctx.api().get('/api/admin/stats/daily').set('Authorization', ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.source).toBe('mock-local');
    expect(r.body.items).toHaveLength(30); // mặc định 30 ngày, đủ từng ngày
    expect(r.body.items.at(-1)).toMatchObject({
      key: today, bookedTickets: 5, cancelledTickets: 2, bookedOrders: 2, cancelledOrders: 1, netTickets: 3,
      bookedRevenue: 5000, cancelledRevenue: 2000, netRevenue: 3000,
    });
    expect(r.body.items[0]).toMatchObject({ bookedTickets: 0, netTickets: 0, netRevenue: 0 });
    expect(r.body.totals).toMatchObject({ netTickets: 3, netRevenue: 3000 });
  });

  it('theo sự kiện: kèm tên sự kiện; 1 sự kiện qua /stats/events/:id', async () => {
    const e1 = await createEvent(ctx, { title: 'E1', ticketTypes: [{ name: 'A', price: 100, totalQuantity: 10 }] });
    const e2 = await createEvent(ctx, { title: 'E2', ticketTypes: [{ name: 'A', price: 500, totalQuantity: 10 }] });
    await book(ctx, ALICE, e1.ticketTypes[0].id, 1);
    await book(ctx, ALICE, e2.ticketTypes[0].id, 4);

    const all = await ctx.api().get('/api/admin/stats/events').set('Authorization', ADMIN);
    expect(all.body.items.map((i: any) => [i.eventTitle, i.netTickets, i.netRevenue])).toEqual([['E2', 4, 2000], ['E1', 1, 100]]);

    const one = await ctx.api().get(`/api/admin/stats/events/${e1.id}`).set('Authorization', ADMIN);
    expect(one.body.item).toMatchObject({ key: e1.id, eventTitle: 'E1', bookedTickets: 1, bookedRevenue: 100 });
    expect(one.body.items).toHaveLength(1);
  });

  it('kiểm tra tham số trước khi gọi Azure; khách không được gọi', async () => {
    const bad = ['from=2026-11-30&to=2026-11-01', 'from=2025-01-01&to=2026-12-31', 'from=2026-02-30', 'from=12/11/2026', 'eventId=abc'];
    for (const qs of bad) {
      expect((await ctx.api().get(`/api/admin/stats/daily?${qs}`).set('Authorization', ADMIN)).status, qs).toBe(400);
    }
    expect((await ctx.api().get('/api/admin/stats/daily?from=2026-01-01&to=2026-12-31').set('Authorization', ADMIN)).status).toBe(200); // 365 ngày
    expect((await ctx.api().get('/api/admin/stats/daily').set('Authorization', ALICE)).status).toBe(403);
  });

  it('đối soát /history: thông điệp đã SENT được đánh dấu đã xử lý', async () => {
    const ev = await createEvent(ctx);
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    let r = await ctx.api().get(`/api/admin/orders/${o.body.id}/azure-sync`).set('Authorization', ADMIN);
    expect(r.body.messages).toEqual([expect.objectContaining({ type: 'BOOKED', outboxStatus: 'PENDING', processedByAzure: false })]);
    await ctx.services.dispatcher.dispatchOnce();
    r = await ctx.api().get(`/api/admin/orders/${o.body.id}/azure-sync`).set('Authorization', ADMIN);
    expect(r.body.messages[0]).toMatchObject({ outboxStatus: 'SENT', processedByAzure: true });
  });
});

describe('Thống kê - nguồn Azure thật (server giả lập)', () => {
  const svc = (key = 'secret', timeout = 500) => new StatsService(new HttpStatsSource(azureUrl, key, timeout), ctx.db, 0);

  it('gọi đúng /stats với tham số + x-functions-key; ghép doanh thu từ DB', async () => {
    mode = 'ok';
    const ev = await createEvent(ctx, { title: 'Show', ticketTypes: [{ name: 'A', price: 1000, totalQuantity: 10 }] });
    await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    // Azure còn trễ: mới thấy 1 vé
    fakeItems = [{ key: ev.id, ...counts(1, 0) }];
    const r = await svc().get({ groupBy: 'event', eventId: ev.id });
    expect(lastReq!.url).toBe(`/api/stats?groupBy=event&eventId=${ev.id}`);
    expect(lastReq!.key).toBe('secret');
    expect(r.source).toBe('azure');
    expect(r.items[0]).toMatchObject({ key: ev.id, eventTitle: 'Show', bookedTickets: 1, bookedRevenue: 2000 });

    fakeItems = [{ key: '2026-11-12', ...counts(5, 4) }];
    const d = await svc().get({ groupBy: 'day', from: '2026-11-12', to: '2026-11-12', fillGaps: true });
    expect(lastReq!.url).toBe('/api/stats?groupBy=day&from=2026-11-12&to=2026-11-12&fillGaps=true');
    expect(d.totals).toMatchObject({ bookedTickets: 5, cancelledTickets: 4, netTickets: 1 });
  });

  it('xử lý lỗi kết nối: không kết nối / quá giờ / 5xx / sai khóa / 400 / sai định dạng', async () => {
    const q = { groupBy: 'event' as const };
    expect(await code(new HttpStatsSource('http://127.0.0.1:1/api', 'k', 500).stats(q))).toBe('503 STATS_UNAVAILABLE');
    mode = 'slow';
    expect(await code(svc('k', 200).get(q))).toBe('504 STATS_TIMEOUT');
    mode = 'error500';
    expect(await code(svc().get(q))).toBe('502 STATS_UPSTREAM_ERROR');
    mode = 'unauthorized';
    expect(await code(svc().get(q))).toBe('502 STATS_AUTH_FAILED');
    mode = 'ok';
    expect(await code(svc('').get(q))).toBe('502 STATS_AUTH_FAILED'); // thiếu khóa -> Azure 401
    mode = 'badrequest';
    expect(await code(svc().get(q))).toBe('400 STATS_BAD_REQUEST');
    mode = 'badshape';
    expect(await code(svc().get(q))).toBe('502 STATS_UPSTREAM_ERROR');
  });

  it('Azure lỗi => trả số vé cũ từ cache kèm stale=true', async () => {
    mode = 'ok';
    fakeItems = [{ key: 'x', ...counts(7, 0) }];
    const s = svc();
    await s.get({ groupBy: 'event' });
    mode = 'error500';
    const r = await s.get({ groupBy: 'event' });
    expect(r.stale).toBe(true);
    expect(r.totals.bookedTickets).toBe(7);
    expect(await code(s.get({ groupBy: 'day', from: '2026-11-01', to: '2026-11-02', fillGaps: true }))).toBe('502 STATS_UPSTREAM_ERROR');
  });

  it('log minh chứng: ghi status 200 THẬT khi Azure trả dữ liệu; không ghi khi trả cache hoặc lỗi; không lộ khóa', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const lines = () => spy.mock.calls.map((c) => JSON.parse(String(c[0])));
    try {
      mode = 'ok';
      fakeItems = [{ key: 'e1', ...counts(1, 0) }];
      const cached = new StatsService(new HttpStatsSource(azureUrl, 'very-secret-key', 500), ctx.db, 60_000);
      await cached.get({ groupBy: 'event', eventId: '7d0f6a2e-1111-4a4a-9b9b-000000000001' });
      expect(lines()).toEqual([
        { severity: 'INFO', event: 'azure_stats_request_succeeded', httpStatus: 200, path: '/stats', groupBy: 'event', eventId: '7d0f6a2e-1111-4a4a-9b9b-000000000001' },
      ]);
      await cached.get({ groupBy: 'event', eventId: '7d0f6a2e-1111-4a4a-9b9b-000000000001' }); // trúng cache => không gọi Azure, không ghi log
      expect(spy).toHaveBeenCalledTimes(1);

      await cached.get({ groupBy: 'day', from: '2026-11-01', to: '2026-11-01', fillGaps: true });
      expect(lines()[1]).toEqual({ severity: 'INFO', event: 'azure_stats_request_succeeded', httpStatus: 200, path: '/stats', groupBy: 'day' });

      const ev = await createEvent(ctx);
      const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
      await cached.orderSync(o.body.id);
      expect(lines()[2]).toEqual({ severity: 'INFO', event: 'azure_stats_request_succeeded', httpStatus: 200, path: '/history', orderId: o.body.id });

      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/very-secret-key|127\.0\.0\.1/);

      spy.mockClear();
      mode = 'badshape'; // 200 nhưng sai định dạng => không phải "thành công"
      await code(svc().get({ groupBy: 'event' }));
      mode = 'error500';
      await code(svc().get({ groupBy: 'event' }));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      mode = 'ok';
    }
  });

  it('đối soát dựa vào /history: tìm đúng messageId', async () => {
    mode = 'ok';
    const ev = await createEvent(ctx);
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    const r = await svc().orderSync(o.body.id);
    expect(lastReq!.url).toBe(`/api/history?orderId=${o.body.id}`);
    expect(r.messages[0].processedByAzure).toBe(false); // server giả chỉ biết 'known-id'
    mode = 'error500';
    const e = await svc().orderSync(o.body.id);
    expect(e.historyError).toContain('STATS_UPSTREAM_ERROR');
    expect(e.messages[0].processedByAzure).toBeNull();
  });
});
