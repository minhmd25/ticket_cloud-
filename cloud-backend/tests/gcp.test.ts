import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Pool } from 'pg';
import { createApp } from '../src/app';
import { MockAuthProvider } from '../src/auth/providers';
import { config } from '../src/config';
import { createPool } from '../src/db';
import { AppError } from '../src/errors';
import { MockPublisher } from '../src/outbox/publisher';
import { StatsService, type StatsSource } from '../src/stats/client';

const counts = { bookedTickets: 0, cancelledTickets: 0, bookedOrders: 0, cancelledOrders: 0, netTickets: 0 };
const db = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool;
const source = (): StatsSource => ({ name: 'azure', stats: vi.fn(async () => ({ items: [], totals: counts })), history: vi.fn(async () => ({ items: [] })) });

describe('GCP integration settings', () => {
  it('allows each configured CORS origin and omits the header for unknown origins', async () => {
    const { app } = createApp({ db, config: { ...config, corsOrigin: 'https://web.example, https://admin.example' }, auth: new MockAuthProvider(), publisher: new MockPublisher(), stats: new StatsService(source(), db, 0) });
    for (const origin of ['https://web.example', 'https://admin.example']) {
      const res = await request(app).options('/api/orders').set('Origin', origin);
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers.vary).toContain('Origin');
    }
    const denied = await request(app).get('/').set('Origin', 'https://unknown.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('retries a stats timeout once and recovers', async () => {
    const upstream = source();
    const fetch = vi.mocked(upstream.stats);
    fetch.mockRejectedValueOnce(new AppError(504, 'STATS_TIMEOUT', 'cold start'));
    const result = await new StatsService(upstream, db, 0).get({ groupBy: 'day' });
    expect(result.stale).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('stops after two timeout attempts', async () => {
    const upstream = source();
    vi.mocked(upstream.stats).mockRejectedValue(new AppError(504, 'STATS_TIMEOUT', 'cold start'));
    await expect(new StatsService(upstream, db, 0).get({ groupBy: 'day' })).rejects.toMatchObject({ code: 'STATS_TIMEOUT' });
    expect(upstream.stats).toHaveBeenCalledTimes(2);
  });

  it('does not retry an invalid Azure key', async () => {
    const upstream = source();
    vi.mocked(upstream.stats).mockRejectedValue(new AppError(502, 'STATS_AUTH_FAILED', 'invalid key'));
    await expect(new StatsService(upstream, db, 0).get({ groupBy: 'day' })).rejects.toMatchObject({ code: 'STATS_AUTH_FAILED' });
    expect(upstream.stats).toHaveBeenCalledTimes(1);
  });

  it('uses the configured DB connection limit', async () => {
    const pool = createPool();
    expect(pool.options.max).toBe(config.dbPoolMax);
    await pool.end();
  });
});
