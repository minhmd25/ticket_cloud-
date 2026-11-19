import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/app';
import { createAuthProvider, MockAuthProvider } from '../src/auth/providers';
import { config, type Config } from '../src/config';
import { createPool } from '../src/db';
import { MockPublisher } from '../src/outbox/publisher';
import type { Services } from '../src/routes';
import { LocalStatsSource, StatsService } from '../src/stats/client';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://ticketing:ticketing@localhost:5432/ticketing_test';

export const ADMIN = 'Bearer mock:admin1:admin';
export const ALICE = 'Bearer mock:alice:customer';
export const BOB = 'Bearer mock:bob:customer';
export const customer = (id: string) => `Bearer mock:${id}:customer`;

export interface TestCtx {
  db: Pool;
  server: Server;
  url: string;
  publisher: MockPublisher;
  services: Services;
  api: () => ReturnType<typeof request>;
}

/** Dựng app trên một cổng ngẫu nhiên, DB test, publisher giả. Dọn DB trước mỗi test. */
export function setupTestApp(overrides: Partial<Config['rules']> = {}, authConfig?: Config['auth']): TestCtx {
  const db = createPool(TEST_DB_URL);
  const publisher = new MockPublisher(false);
  const testConfig: Config = {
    ...config,
    databaseUrl: TEST_DB_URL,
    auth: authConfig ?? config.auth,
    rules: { cancellationDeadlineHours: 24, maxTicketsPerOrder: 10, ...overrides },
    outbox: { enabled: false, pollIntervalMs: 1000, batchSize: 50, maxAttempts: 3, leaseMs: 60_000 },
  };
  const { app, services } = createApp({
    db,
    config: testConfig,
    auth: authConfig ? createAuthProvider(authConfig, db) : new MockAuthProvider(),
    publisher,
    stats: new StatsService(new LocalStatsSource(db), db, 0),
  });
  const server = app.listen(0);
  const ctx: TestCtx = {
    db,
    server,
    publisher,
    services,
    url: '',
    api: () => request(ctx.url),
  };
  ctx.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  beforeEach(async () => {
    await db.query('TRUNCATE outbox_events, orders, ticket_types, events RESTART IDENTITY CASCADE');
    publisher.fail = false;
    publisher.sent.length = 0;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await db.end();
  });
  return ctx;
}

const HOUR = 3600_000;

/** Tạo sự kiện PUBLISHED (mặc định diễn ra sau 7 ngày) với các hạng vé, qua API admin */
export async function createEvent(
  ctx: TestCtx,
  opts: {
    category?: string;
    status?: 'DRAFT' | 'PUBLISHED';
    startInHours?: number;
    ticketTypes?: { name: string; price: number; totalQuantity?: number; seating?: 'GENERAL' | 'ASSIGNED' }[];
    title?: string;
    auth?: string;
  } = {},
) {
  const start = Date.now() + (opts.startInHours ?? 24 * 7) * HOUR;
  const res = await ctx
    .api()
    .post('/api/admin/events')
    .set('Authorization', opts.auth ?? ADMIN)
    .send({
      title: opts.title ?? 'Sự kiện thử',
      category: opts.category ?? 'concert',
      venue: 'Hà Nội',
      startTime: new Date(start).toISOString(),
      endTime: new Date(start + 3 * HOUR).toISOString(),
      status: opts.status ?? 'PUBLISHED',
      ticketTypes: opts.ticketTypes ?? [{ name: 'Thường', price: 100000, totalQuantity: 10 }],
    });
  if (res.status !== 201) throw new Error(`createEvent lỗi ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body as { id: string; ticketTypes: { id: string; name: string; availableQuantity: number; seating: string }[] };
}

/** id hạng vé theo tên */
export const tierId = (ev: { ticketTypes: { id: string; name: string }[] }, name: string) => ev.ticketTypes.find((t) => t.name === name)!.id;

/** Một hàng ghế thẳng: nhãn `${row}1..n`, cách nhau 30 (seatSize mặc định 24) */
export const seatRow = (ticketTypeId: string, row: string, count: number, y: number, extra: Record<string, unknown> = {}) =>
  Array.from({ length: count }, (_, i) => ({ label: `${row}${i + 1}`, row, ticketTypeId, x: 40 + i * 30, y, ...extra }));

export async function putSeatMap(ctx: TestCtx, eventId: string, body: unknown, auth = ADMIN) {
  return ctx.api().put(`/api/admin/events/${eventId}/seat-map`).set('Authorization', auth).send(body as object);
}

export async function bookSeats(ctx: TestCtx, auth: string, ticketTypeId: string, seatIds: string[], idempotencyKey?: string) {
  const req = ctx.api().post('/api/orders').set('Authorization', auth);
  if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
  return req.send({ ticketTypeId, seatIds });
}

/**
 * Sự kiện có sơ đồ: VIP (A1-A5) và Thường (B1-B5) bán theo ghế, Đứng (50 vé) bán theo số lượng.
 * Trả về id hạng vé và hàm tra id ghế theo nhãn.
 */
export async function createSeatedEvent(ctx: TestCtx, opts: { status?: 'DRAFT' | 'PUBLISHED' } = {}) {
  const ev = await createEvent(ctx, {
    status: opts.status,
    ticketTypes: [
      { name: 'VIP', price: 500000, seating: 'ASSIGNED' },
      { name: 'Thường', price: 200000, seating: 'ASSIGNED' },
      { name: 'Đứng', price: 100000, totalQuantity: 50 },
    ],
  });
  const vip = tierId(ev, 'VIP');
  const std = tierId(ev, 'Thường');
  const ga = tierId(ev, 'Đứng');
  const res = await putSeatMap(ctx, ev.id, {
    version: 0,
    width: 600,
    height: 400,
    sections: [{ key: 'giua', name: 'Khu giữa', color: '#336699' }],
    seats: [...seatRow(vip, 'A', 5, 40, { section: 'giua' }), ...seatRow(std, 'B', 5, 80)],
    decorations: [{ type: 'stage', x: 0, y: 0, width: 600, height: 20 }],
  });
  if (res.status !== 200) throw new Error(`putSeatMap lỗi ${res.status}: ${JSON.stringify(res.body)}`);
  const seatIdOf = new Map<string, string>(res.body.seats.map((s: { label: string; id: string }) => [s.label, s.id]));
  const seat = (...labels: string[]) => labels.map((l) => seatIdOf.get(l)!);
  return { ev, vip, std, ga, seat, map: res.body };
}

export async function available(ctx: TestCtx, ticketTypeId: string): Promise<number> {
  const r = await ctx.db.query('SELECT available_quantity FROM ticket_types WHERE id = $1', [ticketTypeId]);
  return r.rows[0].available_quantity;
}

export async function book(ctx: TestCtx, auth: string, ticketTypeId: string, quantity: number) {
  return ctx.api().post('/api/orders').set('Authorization', auth).send({ ticketTypeId, quantity });
}
