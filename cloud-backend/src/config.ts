import 'dotenv/config';

function str(name: string, def = ''): string {
  return process.env[name] ?? def;
}
function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Biến môi trường ${name} phải là số, nhận "${v}"`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export type AuthMode = 'local' | 'mock' | 'jwt' | 'http';
export type PublisherMode = 'mock' | 'azure-queue';
export type StatsMode = 'mock' | 'http';

const outboxBatchSize = int('OUTBOX_BATCH_SIZE', 20);
const azureTimeoutMs = int('AZURE_TIMEOUT_MS', 5000);

export const config = {
  port: int('PORT', 3000),
  nodeEnv: str('NODE_ENV', 'development'),
  databaseUrl: str('DATABASE_URL', 'postgres://ticketing:ticketing@localhost:5432/ticketing'),
  dbPoolMax: int('DB_POOL_MAX', 5),
  corsOrigin: str('CORS_ORIGIN', '*'),
  /** Trang test /dev - mặc định chỉ bật khi KHÔNG phải production */
  devConsole: bool('DEV_CONSOLE', str('NODE_ENV', 'development') !== 'production'),

  auth: {
    mode: str('AUTH_MODE', str('NODE_ENV', 'development') === 'production' ? 'local' : 'mock') as AuthMode,
    jwtSecret: str('AUTH_JWT_SECRET'),
    tokenTtlSeconds: int('AUTH_TOKEN_TTL_SECONDS', 3600),
    // cho phép viết PEM trên 1 dòng trong .env với "\n"
    jwtPublicKey: str('AUTH_JWT_PUBLIC_KEY').split('\\n').join('\n'),
    serviceUrl: str('AUTH_SERVICE_URL', 'http://localhost:4000'),
    verifyPath: str('AUTH_VERIFY_PATH', '/auth/me'),
    timeoutMs: int('AUTH_TIMEOUT_MS', 3000),
  },

  rules: {
    cancellationDeadlineHours: int('CANCELLATION_DEADLINE_HOURS', 24),
    maxTicketsPerOrder: int('MAX_TICKETS_PER_ORDER', 10),
  },

  publisher: {
    mode: str('PUBLISHER_MODE', 'mock') as PublisherMode,
    mockFail: bool('PUBLISHER_MOCK_FAIL', false),
    /** URL queue kèm SAS token (chỉ quyền ghi). BÍ MẬT - để trong .env / Secret Manager */
    queueSasUrl: str('AZURE_QUEUE_SAS_URL'),
    timeoutMs: azureTimeoutMs,
  },

  outbox: {
    enabled: bool('OUTBOX_ENABLED', true),
    pollIntervalMs: int('OUTBOX_POLL_INTERVAL_MS', 5000),
    batchSize: outboxBatchSize,
    maxAttempts: int('OUTBOX_MAX_ATTEMPTS', 10),
    /**
     * Thời gian một lượt worker được giữ lô đã nhận. Lô được gửi tuần tự nên lease phải đủ cho
     * cả lô: mặc định = số thông điệp × timeout gửi + 30 giây, tối thiểu 60 giây.
     */
    leaseMs: int('OUTBOX_LEASE_MS', Math.max(60_000, outboxBatchSize * azureTimeoutMs + 30_000)),
  },

  queue: {
    /** nhịp worker hàng chờ: xếp ngẫu nhiên lúc mở bán, cho người vào, xử lý hết hạn */
    tickMs: int('QUEUE_TICK_MS', 2000),
    /** người đang chờ không hỏi lại trạng thái quá chừng này giây thì bị coi là đã bỏ đi */
    staleSeconds: int('QUEUE_STALE_SECONDS', 120),
  },

  stats: {
    mode: str('STATS_MODE', 'mock') as StatsMode,
    /** vd https://func-ticket-stats-sinh.azurewebsites.net/api */
    url: str('AZURE_STATS_URL'),
    /** x-functions-key - BÍ MẬT, không đưa cho frontend */
    key: str('AZURE_STATS_KEY'),
    timeoutMs: int('STATS_TIMEOUT_MS', 60000),
    cacheTtlMs: int('STATS_CACHE_TTL_MS', 30000),
  },
};

export type Config = typeof config;
