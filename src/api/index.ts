import { ApiError, request } from './client';
import type {
  AdminOrderFilter,
  CreateOrderInput,
  EventCategory,
  EventDetail,
  EventInput,
  EventSummary,
  LoginResponse,
  Order,
  StatsQuery,
  StatsResponse,
  TicketType,
  TicketTypeInput,
  User,
} from './types';

const enc = encodeURIComponent;

// Chuẩn hóa thông tin tài khoản để chịu được vài khác biệt nhỏ của backend
// (id dạng số, role viết hoa như "ADMIN", ...).
function normalizeUser(raw: unknown): User {
  const u = (raw ?? {}) as Record<string, unknown>;
  const role = String(u.role ?? '').toLowerCase() === 'admin' ? 'admin' : 'customer';
  return {
    id: String(u.id ?? u.userId ?? ''),
    username: String(u.username ?? ''),
    role,
    fullName: typeof u.fullName === 'string' ? u.fullName : undefined,
  };
}

async function login(username: string, password: string): Promise<LoginResponse> {
  const res = await request<Record<string, unknown>>('POST', '/api/auth/login', {
    body: { username, password },
    auth: false,
  });
  const token = (res?.token ?? res?.accessToken ?? res?.access_token) as string | undefined;
  if (!token) throw new ApiError(500, 'BAD_RESPONSE', 'Máy chủ không trả về mã xác thực.');
  if (res.user) return { token, user: normalizeUser(res.user) };
  // Backend chỉ trả token: hỏi lại thông tin tài khoản.
  const me = await request<unknown>('GET', '/api/auth/me', { token });
  return { token, user: normalizeUser(me) };
}

export const api = {
  // ---- Tài khoản (Backend tài khoản) ----
  login,
  me: async (): Promise<User> => normalizeUser(await request<unknown>('GET', '/api/auth/me')),

  // ---- Sự kiện (Backend đặt vé) ----
  listEvents: (category?: EventCategory) =>
    request<EventSummary[]>('GET', '/api/events', { query: { category } }),
  getEvent: (id: string) => request<EventDetail>('GET', `/api/events/${enc(id)}`),

  // ---- Đơn của khách đang đăng nhập ----
  createOrder: (input: CreateOrderInput) => request<Order>('POST', '/api/orders', { body: input }),
  listMyOrders: () => request<Order[]>('GET', '/api/orders'),
  getOrder: (id: string) => request<Order>('GET', `/api/orders/${enc(id)}`),
  cancelOrder: (id: string) => request<Order>('POST', `/api/orders/${enc(id)}/cancel`),

  // ---- Quản trị ----
  admin: {
    createEvent: (input: EventInput) => request<EventDetail>('POST', '/api/admin/events', { body: input }),
    updateEvent: (id: string, input: EventInput) =>
      request<EventDetail>('PUT', `/api/admin/events/${enc(id)}`, { body: input }),
    createTicketType: (eventId: string, input: TicketTypeInput) =>
      request<TicketType>('POST', `/api/admin/events/${enc(eventId)}/ticket-types`, { body: input }),
    updateTicketType: (id: string, input: TicketTypeInput) =>
      request<TicketType>('PUT', `/api/admin/ticket-types/${enc(id)}`, { body: input }),
    listOrders: (filter: AdminOrderFilter = {}) =>
      request<Order[]>('GET', '/api/admin/orders', { query: { eventId: filter.eventId, status: filter.status } }),
    getOrder: (id: string) => request<Order>('GET', `/api/admin/orders/${enc(id)}`),
    getStats: (query: StatsQuery) =>
      request<StatsResponse>('GET', '/api/admin/stats', {
        query: { groupBy: query.groupBy, from: query.from, to: query.to },
      }),
  },
};

export { ApiError, errorMessage } from './client';
export type * from './types';
