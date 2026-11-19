import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from '../config';
import { AppError } from '../errors';
import { logInfo } from '../lib/log';

// =============================================================================
// Kiểu dữ liệu theo API thống kê của Azure (docs/azure-message-contract.md)
//   GET {AZURE_STATS_URL}/stats?groupBy=day|event&from=YYYY-MM-DD&to=YYYY-MM-DD&eventId=&fillGaps=true
// =============================================================================
export interface AzureStatsQuery {
  groupBy: 'day' | 'event';
  from?: string;
  to?: string;
  eventId?: string;
  fillGaps?: boolean;
}

const countsSchema = z.object({
  bookedTickets: z.number(),
  cancelledTickets: z.number(),
  bookedOrders: z.number(),
  cancelledOrders: z.number(),
  netTickets: z.number(),
});
const azureStatsSchema = z.object({
  groupBy: z.string().optional(),
  items: z.array(countsSchema.extend({ key: z.string() })),
  totals: countsSchema,
});
export type TicketCounts = z.infer<typeof countsSchema>;
export type AzureStatsResult = z.infer<typeof azureStatsSchema>;

export interface StatsSource {
  readonly name: string;
  stats(q: AzureStatsQuery): Promise<AzureStatsResult>;
  /** Lịch sử thông điệp Azure đã xử lý cho 1 đơn (JSON thô) */
  history(orderId: string): Promise<unknown>;
}

export function toQueryString(q: AzureStatsQuery): string {
  const p = new URLSearchParams({ groupBy: q.groupBy });
  if (q.from) p.set('from', q.from);
  if (q.to) p.set('to', q.to);
  if (q.eventId) p.set('eventId', q.eventId);
  if (q.fillGaps) p.set('fillGaps', 'true');
  return p.toString();
}

// =============================================================================
// Nguồn THẬT: Azure Function (header x-functions-key; khóa chỉ nằm ở backend)
// =============================================================================
export class HttpStatsSource implements StatsSource {
  readonly name = 'azure';
  constructor(private readonly baseUrl: string, private readonly key: string, private readonly timeoutMs: number) {
    if (!baseUrl) throw new Error('STATS_MODE=http cần AZURE_STATS_URL');
  }

  async stats(q: AzureStatsQuery): Promise<AzureStatsResult> {
    const { status, body } = await this.get('/stats', toQueryString(q));
    const parsed = azureStatsSchema.safeParse(body);
    if (!parsed.success) throw new AppError(502, 'STATS_UPSTREAM_ERROR', 'Dữ liệu thống kê từ Azure không đúng định dạng đã thống nhất');
    // chỉ ghi khi Azure thật sự trả dữ liệu hợp lệ (cache không đi qua đây => không có 200 giả)
    logInfo('azure_stats_request_succeeded', { httpStatus: status, path: '/stats', groupBy: q.groupBy, eventId: q.eventId });
    return parsed.data;
  }

  async history(orderId: string): Promise<unknown> {
    const { status, body } = await this.get('/history', new URLSearchParams({ orderId }).toString());
    logInfo('azure_stats_request_succeeded', { httpStatus: status, path: '/history', orderId });
    return body;
  }

  /**
   * Lỗi được chuyển thành mã rõ ràng cho frontend:
   *   quá thời gian -> 504 STATS_TIMEOUT | không kết nối -> 503 STATS_UNAVAILABLE | 5xx -> 502 STATS_UPSTREAM_ERROR
   *   401/403 -> 502 STATS_AUTH_FAILED (sai khóa) | 400 -> 400 STATS_BAD_REQUEST (kèm thông báo của Azure) | 404 -> 404
   */
  private async get(path: '/stats' | '/history', query: string): Promise<{ status: number; body: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}?${query}`, {
        headers: { Accept: 'application/json', ...(this.key ? { 'x-functions-key': this.key } : {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new AppError(504, 'STATS_TIMEOUT', 'Dịch vụ thống kê (Azure) phản hồi quá chậm');
      }
      throw new AppError(503, 'STATS_UNAVAILABLE', 'Không kết nối được dịch vụ thống kê (Azure)');
    }
    if (res.status === 400) {
      const b = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new AppError(400, 'STATS_BAD_REQUEST', `Azure từ chối tham số: ${b?.error?.message ?? 'không rõ'}`);
    }
    if (res.status === 404) throw new AppError(404, 'STATS_NOT_FOUND', 'Không có thống kê cho mục này');
    if (res.status === 401 || res.status === 403) throw new AppError(502, 'STATS_AUTH_FAILED', 'Xác thực với dịch vụ thống kê thất bại (kiểm tra AZURE_STATS_KEY)');
    if (!res.ok) throw new AppError(502, 'STATS_UPSTREAM_ERROR', `Dịch vụ thống kê trả lỗi ${res.status}`);
    try {
      return { status: res.status, body: await res.json() };
    } catch {
      throw new AppError(502, 'STATS_UPSTREAM_ERROR', 'Dịch vụ thống kê trả dữ liệu không phải JSON');
    }
  }
}

// =============================================================================
// Tính toán từ DB GCP: dùng cho (1) doanh thu - Azure KHÔNG tính doanh thu,
// và (2) nguồn MOCK giả lập đúng API /stats của Azure khi chưa có Azure.
// Mỗi đơn = 1 lần đặt (theo created_at) ; đơn đã hủy = thêm 1 lần hủy (theo cancelled_at).
// "Ngày" theo giờ Việt Nam (UTC+7), giống Azure.
// =============================================================================
interface AggRow extends TicketCounts {
  key: string;
  bookedRevenue: number;
  cancelledRevenue: number;
}

export async function aggregateFromDb(db: Pool, q: AzureStatsQuery): Promise<AggRow[]> {
  const keyExpr = q.groupBy === 'day' ? 'day' : 'event_id::text';
  const r = await db.query(
    `WITH ev AS (
       SELECT event_id, created_at AS at, quantity AS bt, 0 AS ct, 1 AS bo, 0 AS co, total_amount AS ba, 0::numeric AS ca FROM orders
       UNION ALL
       SELECT event_id, cancelled_at, 0, quantity, 0, 1, 0, total_amount FROM orders WHERE status = 'CANCELLED'
     ), k AS (
       SELECT *, to_char((at + interval '7 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM ev
     )
     SELECT ${keyExpr} AS key,
            sum(bt)::int AS booked_tickets, sum(ct)::int AS cancelled_tickets,
            sum(bo)::int AS booked_orders, sum(co)::int AS cancelled_orders,
            sum(ba) AS booked_revenue, sum(ca) AS cancelled_revenue
       FROM k
      WHERE ($1::text IS NULL OR day >= $1) AND ($2::text IS NULL OR day <= $2) AND ($3::uuid IS NULL OR event_id = $3)
      GROUP BY 1 ORDER BY 1`,
    [q.from ?? null, q.to ?? null, q.eventId ?? null],
  );
  return r.rows.map((x) => ({
    key: x.key,
    bookedTickets: x.booked_tickets,
    cancelledTickets: x.cancelled_tickets,
    bookedOrders: x.booked_orders,
    cancelledOrders: x.cancelled_orders,
    netTickets: x.booked_tickets - x.cancelled_tickets,
    bookedRevenue: Number(x.booked_revenue),
    cancelledRevenue: Number(x.cancelled_revenue),
  }));
}

const ZERO: TicketCounts = { bookedTickets: 0, cancelledTickets: 0, bookedOrders: 0, cancelledOrders: 0, netTickets: 0 };

export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** MOCK: trả đúng định dạng API /stats của Azure, tính từ DB cục bộ (coi như Azure đã nhận mọi thông điệp). */
export class LocalStatsSource implements StatsSource {
  readonly name = 'mock-local';
  constructor(private readonly db: Pool) {}

  async stats(q: AzureStatsQuery): Promise<AzureStatsResult> {
    const rows = await aggregateFromDb(this.db, q);
    let items = rows.map(({ bookedRevenue: _b, cancelledRevenue: _c, ...counts }) => counts);
    if (q.groupBy === 'day' && q.fillGaps && q.from && q.to) {
      const byKey = new Map(items.map((i) => [i.key, i]));
      items = daysBetween(q.from, q.to).map((day) => byKey.get(day) ?? { key: day, ...ZERO });
    }
    return { groupBy: q.groupBy, items, totals: sumCounts(items) };
  }

  /** mock: thông điệp đã SENT coi như Azure đã xử lý */
  async history(orderId: string): Promise<unknown> {
    const r = await this.db.query(
      `SELECT id, event_type, sent_at FROM outbox_events WHERE aggregate_id = $1 AND status = 'SENT' ORDER BY seq`,
      [orderId],
    );
    return { orderId, items: r.rows.map((x) => ({ messageId: x.id, type: x.event_type === 'ORDER_CREATED' ? 'BOOKED' : 'CANCELLED' })) };
  }
}

function sumCounts(items: TicketCounts[]): TicketCounts {
  return items.reduce(
    (t, i) => ({
      bookedTickets: t.bookedTickets + i.bookedTickets,
      cancelledTickets: t.cancelledTickets + i.cancelledTickets,
      bookedOrders: t.bookedOrders + i.bookedOrders,
      cancelledOrders: t.cancelledOrders + i.cancelledOrders,
      netTickets: t.netTickets + i.netTickets,
    }),
    { ...ZERO },
  );
}

// =============================================================================
// StatsService: số vé từ Azure + doanh thu từ DB GCP
// =============================================================================
export interface RevenueFields {
  bookedRevenue: number;
  cancelledRevenue: number;
  netRevenue: number;
}
export type StatsItem = TicketCounts & RevenueFields & { key: string; eventTitle?: string | null };

export interface StatsResponse {
  /** nguồn số vé: azure | azure(cache) | mock-local */
  source: string;
  /** true nếu Azure đang lỗi và số vé là dữ liệu cũ từ cache */
  stale: boolean;
  fetchedAt: string;
  query: AzureStatsQuery;
  items: StatsItem[];
  totals: TicketCounts & RevenueFields;
  notes: { tickets: string; revenue: string };
}

export class StatsService {
  private cache = new Map<string, { at: number; data: AzureStatsResult }>();
  private static readonly STALE_MAX_MS = 10 * 60_000;

  constructor(
    private readonly source: StatsSource,
    private readonly db: Pool,
    private readonly ttlMs: number,
  ) {}

  get sourceName() {
    return this.source.name;
  }

  async get(q: AzureStatsQuery): Promise<StatsResponse> {
    const { data, source, stale, at } = await this.fetchCounts(q);
    const revenue = await aggregateFromDb(this.db, q);
    const revByKey = new Map(revenue.map((r) => [r.key, r]));

    // hợp các key: Azure chậm 1-2 phút nên có thể DB đã có doanh thu mà Azure chưa có số vé
    const keys = new Set([...data.items.map((i) => i.key), ...(q.groupBy === 'event' ? revenue.map((r) => r.key) : [])]);
    const azureByKey = new Map(data.items.map((i) => [i.key, i]));
    const titles = q.groupBy === 'event' ? await this.eventTitles([...keys]) : new Map<string, string>();

    const items: StatsItem[] = [...keys].map((key) => {
      const c = azureByKey.get(key) ?? { key, ...ZERO };
      const rv = revByKey.get(key);
      const bookedRevenue = rv?.bookedRevenue ?? 0;
      const cancelledRevenue = rv?.cancelledRevenue ?? 0;
      return {
        ...c,
        key,
        ...(q.groupBy === 'event' ? { eventTitle: titles.get(key) ?? null } : {}),
        bookedRevenue,
        cancelledRevenue,
        netRevenue: bookedRevenue - cancelledRevenue,
      };
    });
    if (q.groupBy === 'day') items.sort((a, b) => a.key.localeCompare(b.key));
    else items.sort((a, b) => b.netTickets - a.netTickets || a.key.localeCompare(b.key));

    const bookedRevenue = revenue.reduce((s, r) => s + r.bookedRevenue, 0);
    const cancelledRevenue = revenue.reduce((s, r) => s + r.cancelledRevenue, 0);
    return {
      source,
      stale,
      fetchedAt: new Date(at).toISOString(),
      query: q,
      items,
      totals: { ...data.totals, bookedRevenue, cancelledRevenue, netRevenue: bookedRevenue - cancelledRevenue },
      notes: {
        tickets: 'Số vé từ Azure, cập nhật chậm khoảng 1-2 phút sau khi đặt/hủy',
        revenue: 'Doanh thu từ DB GCP (dữ liệu đơn chính thức), thời gian thực',
      },
    };
  }

  /** Cache ngắn hạn; Azure lỗi tạm thời => thử lại 1 lần, rồi dùng dữ liệu cũ (<10 phút) với stale=true */
  private async fetchCounts(q: AzureStatsQuery) {
    const cacheKey = toQueryString(q);
    const hit = this.cache.get(cacheKey);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return { data: hit.data, source: `${this.source.name}(cache)`, stale: false, at: hit.at };
    }
    try {
      const data = await this.withRetry(() => this.source.stats(q));
      const at = Date.now();
      this.cache.set(cacheKey, { at, data });
      return { data, source: this.source.name, stale: false, at };
    } catch (err) {
      const transient = err instanceof AppError && [502, 503, 504].includes(err.status);
      if (transient && hit && Date.now() - hit.at < StatsService.STALE_MAX_MS) {
        return { data: hit.data, source: `${this.source.name}(cache)`, stale: true, at: hit.at };
      }
      throw err;
    }
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof AppError && [502, 503, 504].includes(err.status) && err.code !== 'STATS_AUTH_FAILED') {
        await new Promise((r) => setTimeout(r, 300));
        return fn();
      }
      throw err;
    }
  }

  private async eventTitles(ids: string[]): Promise<Map<string, string>> {
    const uuids = ids.filter((k) => /^[0-9a-f-]{36}$/i.test(k));
    if (!uuids.length) return new Map();
    const r = await this.db.query('SELECT id::text, title FROM events WHERE id = ANY($1::uuid[])', [uuids]);
    return new Map(r.rows.map((x) => [x.id, x.title]));
  }

  // ---------------------------------------------------------------------------
  // Đối soát: Queue trả 201 chỉ nghĩa là Azure NHẬN được chữ. Kiểm tra Azure đã XỬ LÝ chưa
  // bằng /history?orderId=..., tìm đúng messageId đã gửi.
  // ---------------------------------------------------------------------------
  async orderSync(orderId: string) {
    const rows = await this.db.query(
      `SELECT id, event_type, status, attempts, last_error, sent_at FROM outbox_events WHERE aggregate_id = $1 ORDER BY seq`,
      [orderId],
    );
    if (!rows.rows.length) throw new AppError(404, 'ORDER_NOT_FOUND', 'Không có sự kiện outbox nào cho đơn này');
    let historyText = '';
    let historyError: string | null = null;
    try {
      historyText = JSON.stringify(await this.withRetry(() => this.source.history(orderId)));
    } catch (err) {
      historyError = err instanceof AppError ? `${err.code}: ${err.message}` : String(err);
    }
    return {
      orderId,
      source: this.source.name,
      historyError,
      messages: rows.rows.map((r) => ({
        messageId: r.id,
        type: r.event_type === 'ORDER_CREATED' ? 'BOOKED' : 'CANCELLED',
        outboxStatus: r.status,
        attempts: r.attempts,
        lastError: r.last_error,
        sentAt: r.sent_at,
        // tìm messageId trong phản hồi /history (không phụ thuộc cấu trúc JSON cụ thể)
        processedByAzure: historyError ? null : historyText.includes(r.id),
      })),
    };
  }
}

export function createStatsService(cfg: Config['stats'], db: Pool): StatsService {
  const source = cfg.mode === 'http' ? new HttpStatsSource(cfg.url, cfg.key, cfg.timeoutMs) : new LocalStatsSource(db);
  return new StatsService(source, db, cfg.cacheTtlMs);
}
