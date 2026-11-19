// Các hàm gọi API, đúng theo cloud-backend/docs/API.md.
import { ApiError, request } from './client';
import { getSession } from '../auth/session';
import type {
  AdminEventListQuery,
  AdminOrderPage,
  AdminOrdersQuery,
  CategoryCount,
  CreateOrderInput,
  EventDetail,
  EventInput,
  EventListQuery,
  EventPatch,
  EventSummary,
  LoginResponse,
  MyOrdersQuery,
  Order,
  Page,
  QueueEntry,
  QueueSettings,
  QueueSettingsInput,
  QueueTickResult,
  SeatMap,
  SeatMapInput,
  SeatStatus,
  StatsQuery,
  StatsResponse,
  TicketType,
  TicketTypeInput,
  User,
} from './types';

const enc = encodeURIComponent;

/** Backend trả `{ userId, role }`; tên đăng nhập giữ theo lúc người dùng nhập. */
function toUser(raw: unknown, username?: string): User {
  const u = (raw ?? {}) as Record<string, unknown>;
  const id = String(u.userId ?? u.id ?? '');
  const role = String(u.role ?? '').toLowerCase() === 'admin' ? 'admin' : 'customer';
  return { id, username: username || (typeof u.username === 'string' ? u.username : id), role };
}

async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await request<Record<string, unknown>>('POST', '/api/auth/login', {
    body: { username, password },
    auth: false,
  });
  const token = res?.token;
  if (typeof token !== 'string' || !token) throw new ApiError(500, 'BAD_RESPONSE', 'Máy chủ không trả về mã xác thực.');
  return {
    token,
    expiresIn: typeof res.expiresIn === 'number' ? res.expiresIn : undefined,
    user: toUser(res, username),
  };
}

async function me(): Promise<User> {
  const raw = await request<unknown>('GET', '/api/me');
  const current = getSession()?.user;
  const fresh = toUser(raw);
  return current && current.id === fresh.id ? { ...fresh, username: current.username } : fresh;
}

const page = (q: { page?: number; limit?: number }) => ({ page: q.page, limit: q.limit });

export const api = {
  // ---- Tài khoản ----
  login,
  me,

  // ---- Sự kiện (công khai: chỉ sự kiện đang mở bán, chưa kết thúc) ----
  listEvents: (q: EventListQuery = {}) =>
    request<Page<EventSummary>>('GET', '/api/events', {
      query: { ...page(q), category: q.category, q: q.q, includePast: q.includePast },
    }),
  listCategories: async () => (await request<{ data: CategoryCount[] }>('GET', '/api/events/categories')).data,
  getEvent: (id: string) => request<EventDetail>('GET', `/api/events/${enc(id)}`),
  /** Sơ đồ ghế. Có ETag nên trình duyệt tự hỏi lại bằng If-None-Match và dùng bản đệm khi chưa đổi. */
  getSeatMap: (eventId: string) => request<SeatMap>('GET', `/api/events/${enc(eventId)}/seat-map`),
  getSeatStatus: (eventId: string) => request<SeatStatus>('GET', `/api/events/${enc(eventId)}/seats/status`),

  // ---- Hàng chờ ảo ----
  joinQueue: (eventId: string) => request<QueueEntry>('POST', `/api/events/${enc(eventId)}/queue`),
  getMyQueue: (eventId: string) => request<QueueEntry>('GET', `/api/events/${enc(eventId)}/queue/me`),
  leaveQueue: (eventId: string) => request<QueueEntry>('DELETE', `/api/events/${enc(eventId)}/queue/me`),

  // ---- Đơn của khách đang đăng nhập ----
  /** `idempotencyKey`: gửi lại cùng key khi thử lại sau lỗi mạng để không tạo đơn trùng. */
  createOrder: (input: CreateOrderInput, idempotencyKey?: string) =>
    request<Order>('POST', '/api/orders', {
      body: input,
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    }),
  listMyOrders: (q: MyOrdersQuery = {}) =>
    request<Page<Order>>('GET', '/api/orders', { query: { ...page(q), status: q.status } }),
  getOrder: (id: string) => request<Order>('GET', `/api/orders/${enc(id)}`),
  cancelOrder: (id: string, reason?: string) =>
    request<Order>('POST', `/api/orders/${enc(id)}/cancel`, { body: reason ? { reason } : {} }),

  // ---- Quản trị ----
  admin: {
    listEvents: (q: AdminEventListQuery = {}) =>
      request<Page<EventSummary>>('GET', '/api/admin/events', {
        query: { ...page(q), status: q.status, category: q.category, q: q.q, includePast: q.includePast },
      }),
    getEvent: (id: string) => request<EventDetail>('GET', `/api/admin/events/${enc(id)}`),
    createEvent: (input: EventInput) => request<EventDetail>('POST', '/api/admin/events', { body: input }),
    updateEvent: (id: string, patch: EventPatch) =>
      request<EventDetail>('PATCH', `/api/admin/events/${enc(id)}`, { body: patch }),
    cancelEvent: (id: string, cancelReason?: string) =>
      request<EventDetail>('PATCH', `/api/admin/events/${enc(id)}`, {
        body: cancelReason ? { status: 'CANCELLED', cancelReason } : { status: 'CANCELLED' },
      }),
    createTicketType: (eventId: string, input: TicketTypeInput) =>
      request<TicketType>('POST', `/api/admin/events/${enc(eventId)}/ticket-types`, { body: input }),
    updateTicketType: (id: string, patch: Partial<TicketTypeInput>) =>
      request<TicketType>('PATCH', `/api/admin/ticket-types/${enc(id)}`, { body: patch }),
    getSeatMap: (eventId: string) => request<SeatMap>('GET', `/api/admin/events/${enc(eventId)}/seat-map`),
    getSeatStatus: (eventId: string) =>
      request<SeatStatus>('GET', `/api/admin/events/${enc(eventId)}/seats/status`),
    saveSeatMap: (eventId: string, input: SeatMapInput) =>
      request<SeatMap>('PUT', `/api/admin/events/${enc(eventId)}/seat-map`, { body: input }),
    setSeatsBlocked: (eventId: string, seatIds: string[], blocked: boolean) =>
      request<{ version: number; changed: number }>('PATCH', `/api/admin/events/${enc(eventId)}/seats`, {
        body: { seatIds, blocked },
      }),
    copySeatMap: (eventId: string, sourceEventId: string, version: number) =>
      request<SeatMap>('POST', `/api/admin/events/${enc(eventId)}/seat-map/copy-from/${enc(sourceEventId)}`, {
        body: { version },
      }),
    getQueue: (eventId: string) => request<QueueSettings>('GET', `/api/admin/events/${enc(eventId)}/queue`),
    saveQueue: (eventId: string, input: QueueSettingsInput) =>
      request<QueueSettings>('PUT', `/api/admin/events/${enc(eventId)}/queue`, { body: input }),
    tickQueue: (eventId: string) => request<QueueTickResult>('POST', `/api/admin/events/${enc(eventId)}/queue/tick`),
    listOrders: (q: AdminOrdersQuery = {}) =>
      request<AdminOrderPage>('GET', '/api/admin/orders', {
        query: { ...page(q), eventId: q.eventId, status: q.status },
      }),
    getOrder: (id: string) => request<Order>('GET', `/api/admin/orders/${enc(id)}`),
    cancelOrder: (id: string, reason?: string) =>
      request<Order>('POST', `/api/admin/orders/${enc(id)}/cancel`, { body: reason ? { reason } : {} }),
    statsDaily: (q: StatsQuery) =>
      request<StatsResponse>('GET', '/api/admin/stats/daily', { query: { from: q.from, to: q.to } }),
    statsByEvent: (q: StatsQuery) =>
      request<StatsResponse>('GET', '/api/admin/stats/events', { query: { from: q.from, to: q.to } }),
  },
};

/** Tạo khóa chống đặt trùng cho một lần bấm "Đặt vé". */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export { ApiError, errorMessage, isNotFound } from './client';
export type * from './types';
