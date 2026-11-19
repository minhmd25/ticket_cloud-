// Backend giả chạy ngay trong trình duyệt, trả lời theo cùng hợp đồng với cloud-backend
// (cloud-backend/docs/API.md): cùng đường dẫn, cùng dạng dữ liệu, cùng mã lỗi.
// Dùng khi chạy demo không có backend và trong bộ kiểm thử giao diện.
import { config } from '../../config';
import { addDays, vnDayKey } from '../../lib/dates';
import { loadDb, makeUuid, resetMockDb, RULES, saveDb } from './db';
import type { DbEvent, DbOrder, DbTicketType, DbUser, MockDb } from './db';

/** Điều khiển backend giả từ giao diện (chân trang) và từ test. */
export const mockControls = {
  offline: false,
  /**
   * Xử lý bình thường yêu cầu kế tiếp khớp "METHOD /đường-dẫn" (ví dụ "POST /api/orders")
   * nhưng làm mất phản hồi, giả lập rớt mạng sau khi máy chủ đã xử lý xong.
   */
  dropNextResponse: null as string | null,
  setOffline(value: boolean) {
    mockControls.offline = value;
  },
  reset() {
    resetMockDb();
  },
};

type Issue = { path: string; message: string };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Phản hồi bị "mất trên đường về" sau khi máy chủ đã xử lý xong. */
class DroppedResponse extends Error {}

function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new HttpError(status, code, message, details);
}

function invalid(issues: Issue[]): void {
  if (issues.length) fail(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', issues);
}

interface Ctx {
  db: MockDb;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  headers: Headers;
  user: DbUser | null;
  now: Date;
}

interface Result {
  status: number;
  body: unknown;
}

type Access = 'public' | 'user' | 'admin';

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  access: Access;
  handler: (ctx: Ctx) => Result;
}

const routes: Route[] = [];

function route(method: string, path: string, access: Access, handler: (ctx: Ctx) => Result) {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return '([^/]+)';
    })}/?$`,
  );
  routes.push({ method, pattern, keys, access, handler });
}

const ok = (body: unknown, status = 200): Result => ({ status, body });

// ---------- Chuyển dữ liệu sang dạng trả về ----------

function paginate<T>(items: T[], query: URLSearchParams) {
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.get('limit') ?? 20) || 20));
  return {
    data: items.slice((page - 1) * limit, page * limit),
    pagination: { page, limit, total: items.length, totalPages: Math.ceil(items.length / limit) },
  };
}

function toTicketType(t: DbTicketType) {
  return {
    id: t.id,
    eventId: t.eventId,
    name: t.name,
    description: t.description,
    price: t.price,
    totalQuantity: t.totalQuantity,
    availableQuantity: t.availableQuantity,
    reservedQuantity: t.totalQuantity - t.availableQuantity,
    soldOut: t.availableQuantity === 0,
  };
}

function toEvent(e: DbEvent) {
  const { createdAt: _created, ...rest } = e;
  return rest;
}

function ticketTypesOf(db: MockDb, eventId: string) {
  return db.ticketTypes
    .filter((t) => t.eventId === eventId)
    .sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}

function toEventSummary(db: MockDb, e: DbEvent) {
  const tts = ticketTypesOf(db, e.id);
  return {
    ...toEvent(e),
    minPrice: tts.length ? Math.min(...tts.map((t) => t.price)) : null,
    maxPrice: tts.length ? Math.max(...tts.map((t) => t.price)) : null,
    totalAvailable: tts.reduce((sum, t) => sum + t.availableQuantity, 0),
  };
}

function toEventDetail(db: MockDb, e: DbEvent) {
  return { ...toEvent(e), ticketTypes: ticketTypesOf(db, e.id).map(toTicketType) };
}

function deadlineOf(e: DbEvent) {
  return new Date(new Date(e.startTime).getTime() - RULES.cancellationDeadlineHours * 3_600_000);
}

function toOrder(db: MockDb, o: DbOrder, now: Date) {
  const e = db.events.find((x) => x.id === o.eventId)!;
  const t = db.ticketTypes.find((x) => x.id === o.ticketTypeId)!;
  const deadline = deadlineOf(e);
  return {
    id: o.id,
    userId: o.userId,
    status: o.status,
    quantity: o.quantity,
    unitPrice: o.unitPrice,
    totalAmount: o.unitPrice * o.quantity,
    currency: 'VND',
    event: { id: e.id, title: e.title, category: e.category, venue: e.venue, startTime: e.startTime, status: e.status },
    ticketType: { id: t.id, name: t.name },
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    cancelledBy: o.cancelledBy,
    cancelReason: o.cancelReason,
    cancellationDeadline: deadline.toISOString(),
    canCancel: o.status === 'CONFIRMED' && (e.status === 'CANCELLED' || now <= deadline),
  };
}

const byNewest = (a: DbOrder, b: DbOrder) => b.createdAt.localeCompare(a.createdAt);

// ---------- Kiểm tra dữ liệu ----------

const isInt = (v: unknown, min: number) => typeof v === 'number' && Number.isInteger(v) && v >= min;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const isIso = (v: unknown) =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) && !Number.isNaN(new Date(v).getTime());
const CATEGORY = /^[a-z0-9_-]+$/;

function checkEventFields(body: Record<string, unknown>, partial: boolean, issues: Issue[]) {
  const has = (k: string) => k in body;
  if (!partial || has('title')) {
    const title = text(body.title);
    if (!title) issues.push({ path: 'title', message: 'Tên sự kiện không được trống' });
    else if (title.length > 200) issues.push({ path: 'title', message: 'Tên sự kiện tối đa 200 ký tự' });
  }
  if (!partial || has('category')) {
    if (!CATEGORY.test(text(body.category).toLowerCase()))
      issues.push({ path: 'category', message: 'Loại hình chỉ gồm chữ thường không dấu, số, "-" hoặc "_" (vd: concert, sport)' });
  }
  if (!partial || has('venue')) {
    if (!text(body.venue)) issues.push({ path: 'venue', message: 'Địa điểm không được trống' });
  }
  for (const k of ['startTime', 'endTime']) {
    if ((!partial || has(k)) && !isIso(body[k]))
      issues.push({ path: k, message: 'Thời gian phải theo ISO 8601, vd 2026-12-31T19:00:00+07:00' });
  }
  if (has('description') && typeof body.description === 'string' && body.description.length > 10000)
    issues.push({ path: 'description', message: 'Mô tả quá dài' });
}

function checkTicketFields(body: Record<string, unknown>, partial: boolean, issues: Issue[]) {
  const has = (k: string) => k in body;
  if (!partial || has('name')) {
    const name = text(body.name);
    if (!name) issues.push({ path: 'name', message: 'Tên hạng vé không được trống' });
    else if (name.length > 100) issues.push({ path: 'name', message: 'Tên hạng vé tối đa 100 ký tự' });
  }
  if (!partial || has('price')) {
    const price = body.price;
    if (typeof price !== 'number' || !Number.isFinite(price)) issues.push({ path: 'price', message: 'Giá phải là số' });
    else if (price < 0) issues.push({ path: 'price', message: 'Giá không được âm' });
  }
  if (!partial || has('totalQuantity')) {
    if (!isInt(body.totalQuantity, 0)) issues.push({ path: 'totalQuantity', message: 'Số lượng phải là số nguyên không âm' });
  }
}

function nameTaken(db: MockDb, eventId: string, name: string, selfId?: string) {
  return db.ticketTypes.some(
    (t) => t.eventId === eventId && t.id !== selfId && t.name.toLowerCase() === name.toLowerCase(),
  );
}

function newId() {
  return makeUuid();
}

function recordActivity(db: MockDb, type: 'BOOKED' | 'CANCELLED', o: DbOrder, at: string) {
  db.activities.push({ id: newId(), type, orderId: o.id, eventId: o.eventId, quantity: o.quantity, amount: o.quantity * o.unitPrice, at });
}

function cancelOrder(db: MockDb, o: DbOrder, actor: DbUser, reason: string | null, now: Date) {
  o.status = 'CANCELLED';
  o.cancelledAt = now.toISOString();
  o.cancelledBy = actor.id;
  o.cancelReason = reason;
  db.ticketTypes.find((t) => t.id === o.ticketTypeId)!.availableQuantity += o.quantity;
  recordActivity(db, 'CANCELLED', o, o.cancelledAt);
}

// ---------- Tài khoản ----------

route('POST', '/api/auth/login', 'public', ({ db, body, now }) => {
  const username = text(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[A-Za-z0-9_.@-]{1,100}$/.test(username) || !password)
    fail(400, 'VALIDATION_ERROR', 'Vui lòng nhập tài khoản và mật khẩu hợp lệ');
  const user = db.users.find((u) => u.username === username);
  if (!user || user.password !== password) fail(401, 'INVALID_CREDENTIALS', 'Tài khoản hoặc mật khẩu không đúng');
  const token = `mock.${user.id}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  db.sessions.push({ token, userId: user.id, expiresAt: new Date(now.getTime() + 3_600_000).toISOString() });
  return ok({ token, expiresIn: 3600, userId: user.id, role: user.role });
});

route('GET', '/api/me', 'user', ({ user }) => ok({ userId: user!.id, role: user!.role }));

// ---------- Sự kiện (công khai) ----------

function listEvents(db: MockDb, query: URLSearchParams, now: Date, publicView: boolean) {
  const category = query.get('category')?.toLowerCase();
  const status = query.get('status');
  const q = query.get('q')?.toLowerCase();
  const includePast = query.get('includePast') === 'true';
  const list = db.events
    .filter((e) => (publicView ? e.status === 'PUBLISHED' : !status || e.status === status))
    .filter((e) => !category || e.category === category)
    .filter((e) => !q || e.title.toLowerCase().includes(q) || e.venue.toLowerCase().includes(q))
    .filter((e) => includePast || new Date(e.endTime) > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map((e) => toEventSummary(db, e));
  return paginate(list, query);
}

route('GET', '/api/events', 'public', ({ db, query, now }) => ok(listEvents(db, query, now, true)));

route('GET', '/api/events/categories', 'public', ({ db, now }) => {
  const counts = new Map<string, number>();
  for (const e of db.events) {
    if (e.status === 'PUBLISHED' && new Date(e.endTime) > now) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);
  }
  const data = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, eventCount]) => ({ category, eventCount }));
  return ok({ data });
});

route('GET', '/api/events/:id', 'public', ({ db, params }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e || e.status !== 'PUBLISHED') fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  return ok(toEventDetail(db, e));
});

// ---------- Đơn của khách ----------

route('POST', '/api/orders', 'user', ({ db, body, headers, user, now }) => {
  const issues: Issue[] = [];
  if (typeof body.ticketTypeId !== 'string' || !body.ticketTypeId)
    issues.push({ path: 'ticketTypeId', message: 'Định danh phải là UUID hợp lệ' });
  if (!isInt(body.quantity, 1)) issues.push({ path: 'quantity', message: 'Số lượng phải >= 1' });
  invalid(issues);
  const quantity = body.quantity as number;
  const ticketTypeId = body.ticketTypeId as string;
  if (quantity > RULES.maxTicketsPerOrder)
    fail(422, 'QUANTITY_EXCEEDS_LIMIT', `Mỗi đơn được đặt tối đa ${RULES.maxTicketsPerOrder} vé`, {
      requested: quantity,
      max: RULES.maxTicketsPerOrder,
    });

  const key = headers.get('Idempotency-Key')?.trim() || null;
  if (key) {
    const existing = db.orders.find((o) => o.userId === user!.id && o.idempotencyKey === key);
    if (existing) {
      if (existing.ticketTypeId !== ticketTypeId || existing.quantity !== quantity)
        fail(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã dùng cho một yêu cầu đặt vé khác');
      return ok(toOrder(db, existing, now), 200);
    }
  }

  const t = db.ticketTypes.find((x) => x.id === ticketTypeId);
  if (!t) fail(404, 'TICKET_TYPE_NOT_FOUND', 'Không tìm thấy hạng vé');
  const e = db.events.find((x) => x.id === t.eventId)!;
  if (e.status === 'CANCELLED') fail(409, 'EVENT_CANCELLED', 'Sự kiện đã bị hủy');
  if (e.status !== 'PUBLISHED') fail(409, 'EVENT_NOT_OPEN', 'Sự kiện chưa mở bán');
  if (new Date(e.startTime) <= now) fail(409, 'EVENT_ALREADY_STARTED', 'Sự kiện đã diễn ra, không thể đặt vé');
  if (t.availableQuantity === 0)
    fail(409, 'SOLD_OUT', 'Hạng vé này đã hết', { requested: quantity, available: 0 });
  if (quantity > t.availableQuantity)
    fail(409, 'INSUFFICIENT_TICKETS', `Chỉ còn ${t.availableQuantity} vé, không đủ cho ${quantity} vé yêu cầu`, {
      requested: quantity,
      available: t.availableQuantity,
    });

  const order: DbOrder = {
    id: newId(),
    userId: user!.id,
    eventId: e.id,
    ticketTypeId: t.id,
    quantity,
    unitPrice: t.price,
    status: 'CONFIRMED',
    createdAt: now.toISOString(),
    cancelledAt: null,
    cancelledBy: null,
    cancelReason: null,
    idempotencyKey: key,
  };
  t.availableQuantity -= quantity;
  db.orders.push(order);
  recordActivity(db, 'BOOKED', order, order.createdAt);
  return ok(toOrder(db, order, now), 201);
});

route('GET', '/api/orders', 'user', ({ db, query, user, now }) => {
  const status = query.get('status');
  const list = db.orders
    .filter((o) => o.userId === user!.id && (!status || o.status === status))
    .sort(byNewest)
    .map((o) => toOrder(db, o, now));
  return ok(paginate(list, query));
});

/** Chủ đơn hoặc admin. Người khác nhận 404 để không lộ đơn có tồn tại hay không. */
function findAccessibleOrder(db: MockDb, id: string, user: DbUser) {
  const o = db.orders.find((x) => x.id === id);
  if (!o || (user.role !== 'admin' && o.userId !== user.id)) fail(404, 'ORDER_NOT_FOUND', 'Không tìm thấy đơn đặt vé');
  return o;
}

function handleCancel({ db, params, body, user, now }: Ctx): Result {
  const o = findAccessibleOrder(db, params.id, user!);
  if (o.status === 'CANCELLED')
    fail(409, 'ORDER_ALREADY_CANCELLED', 'Đơn đã được hủy trước đó', { cancelledAt: o.cancelledAt });
  const e = db.events.find((x) => x.id === o.eventId)!;
  if (user!.role !== 'admin' && e.status !== 'CANCELLED' && now > deadlineOf(e))
    fail(
      422,
      'CANCELLATION_WINDOW_CLOSED',
      `Chỉ được hủy đơn trước giờ diễn ra ít nhất ${RULES.cancellationDeadlineHours} giờ`,
      { cancellationDeadline: deadlineOf(e).toISOString() },
    );
  const reason = text(body.reason) || null;
  cancelOrder(db, o, user!, reason, now);
  return ok(toOrder(db, o, now));
}

route('GET', '/api/orders/:id', 'user', ({ db, params, user, now }) =>
  ok(toOrder(db, findAccessibleOrder(db, params.id, user!), now)),
);
route('POST', '/api/orders/:id/cancel', 'user', handleCancel);

// ---------- Quản trị: sự kiện và hạng vé ----------

route('GET', '/api/admin/events', 'admin', ({ db, query, now }) => ok(listEvents(db, query, now, false)));

route('GET', '/api/admin/events/:id', 'admin', ({ db, params }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  return ok(toEventDetail(db, e));
});

route('POST', '/api/admin/events', 'admin', ({ db, body, now }) => {
  const issues: Issue[] = [];
  checkEventFields(body, false, issues);
  const status = body.status ?? 'DRAFT';
  if (status !== 'DRAFT' && status !== 'PUBLISHED') issues.push({ path: 'status', message: 'Trạng thái không hợp lệ' });
  if (!issues.length && new Date(body.endTime as string) <= new Date(body.startTime as string))
    issues.push({ path: 'endTime', message: 'Giờ kết thúc phải sau giờ bắt đầu' });
  invalid(issues);
  const e: DbEvent = {
    id: newId(),
    title: text(body.title),
    category: text(body.category).toLowerCase(),
    description: typeof body.description === 'string' ? body.description : '',
    venue: text(body.venue),
    startTime: new Date(body.startTime as string).toISOString(),
    endTime: new Date(body.endTime as string).toISOString(),
    status: status as DbEvent['status'],
    imageUrl: null,
    createdAt: now.toISOString(),
  };
  db.events.push(e);
  return ok(toEventDetail(db, e), 201);
});

const EVENT_PATCH_KEYS = ['title', 'description', 'category', 'venue', 'startTime', 'endTime', 'status', 'imageUrl', 'cancelReason'];

route('PATCH', '/api/admin/events/:id', 'admin', ({ db, params, body, user, now }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  const issues: Issue[] = [];
  const keys = Object.keys(body);
  if (!keys.length) issues.push({ path: '', message: 'Cần ít nhất một trường để cập nhật' });
  for (const k of keys) if (!EVENT_PATCH_KEYS.includes(k)) issues.push({ path: k, message: 'Trường không được hỗ trợ' });
  checkEventFields(body, true, issues);
  if ('status' in body && !['DRAFT', 'PUBLISHED', 'CANCELLED'].includes(String(body.status)))
    issues.push({ path: 'status', message: 'Trạng thái không hợp lệ' });
  if ('cancelReason' in body && body.status !== 'CANCELLED')
    issues.push({ path: 'cancelReason', message: 'cancelReason chỉ dùng khi đặt status = CANCELLED' });
  invalid(issues);

  const start = (body.startTime as string | undefined) ?? e.startTime;
  const end = (body.endTime as string | undefined) ?? e.endTime;
  if (new Date(end) <= new Date(start))
    fail(400, 'VALIDATION_ERROR', 'Giờ kết thúc phải sau giờ bắt đầu', [
      { path: 'endTime', message: 'Giờ kết thúc phải sau giờ bắt đầu' },
    ]);
  if (e.status === 'CANCELLED' && body.status && body.status !== 'CANCELLED')
    fail(409, 'EVENT_CANCELLED', 'Sự kiện đã hủy, không thể mở lại');

  const wasCancelled = e.status === 'CANCELLED';
  if ('title' in body) e.title = text(body.title);
  if ('description' in body) e.description = String(body.description ?? '');
  if ('category' in body) e.category = text(body.category).toLowerCase();
  if ('venue' in body) e.venue = text(body.venue);
  if ('startTime' in body) e.startTime = new Date(start).toISOString();
  if ('endTime' in body) e.endTime = new Date(end).toISOString();
  if ('status' in body) e.status = body.status as DbEvent['status'];

  let cancelledOrders = 0;
  if (e.status === 'CANCELLED' && !wasCancelled) {
    const reason = text(body.cancelReason) || 'Sự kiện bị hủy';
    for (const o of db.orders.filter((x) => x.eventId === e.id && x.status === 'CONFIRMED')) {
      cancelOrder(db, o, user!, reason, now);
      cancelledOrders++;
    }
  }
  return ok({ ...toEventDetail(db, e), cancelledOrders });
});

route('POST', '/api/admin/events/:id/ticket-types', 'admin', ({ db, params, body }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  if (e.status === 'CANCELLED') fail(409, 'EVENT_CANCELLED', 'Sự kiện đã hủy');
  const issues: Issue[] = [];
  checkTicketFields(body, false, issues);
  invalid(issues);
  const name = text(body.name);
  if (nameTaken(db, e.id, name)) fail(409, 'TICKET_TYPE_NAME_TAKEN', 'Sự kiện đã có hạng vé cùng tên');
  const t: DbTicketType = {
    id: newId(),
    eventId: e.id,
    name,
    description: typeof body.description === 'string' ? body.description : '',
    price: body.price as number,
    totalQuantity: body.totalQuantity as number,
    availableQuantity: body.totalQuantity as number,
  };
  db.ticketTypes.push(t);
  return ok(toTicketType(t), 201);
});

route('PATCH', '/api/admin/ticket-types/:id', 'admin', ({ db, params, body }) => {
  const t = db.ticketTypes.find((x) => x.id === params.id);
  if (!t) fail(404, 'TICKET_TYPE_NOT_FOUND', 'Không tìm thấy hạng vé');
  const issues: Issue[] = [];
  if (!Object.keys(body).length) issues.push({ path: '', message: 'Cần ít nhất một trường để cập nhật' });
  checkTicketFields(body, true, issues);
  invalid(issues);
  if ('totalQuantity' in body) {
    const requested = body.totalQuantity as number;
    const reserved = t.totalQuantity - t.availableQuantity;
    if (requested < reserved)
      fail(
        409,
        'QUANTITY_BELOW_RESERVED',
        `Không thể giảm tổng số vé xuống ${requested} vì đang có ${reserved} vé được giữ trong đơn hợp lệ`,
        { requested, reserved },
      );
  }
  if ('name' in body && nameTaken(db, t.eventId, text(body.name), t.id))
    fail(409, 'TICKET_TYPE_NAME_TAKEN', 'Sự kiện đã có hạng vé cùng tên');
  if ('totalQuantity' in body) {
    const requested = body.totalQuantity as number;
    t.availableQuantity += requested - t.totalQuantity;
    t.totalQuantity = requested;
  }
  if ('name' in body) t.name = text(body.name);
  if ('price' in body) t.price = body.price as number;
  if ('description' in body) t.description = String(body.description ?? '');
  return ok(toTicketType(t));
});

// ---------- Quản trị: đơn ----------

route('GET', '/api/admin/orders', 'admin', ({ db, query, now }) => {
  const eventId = query.get('eventId');
  const status = query.get('status');
  const matched = db.orders.filter((o) => (!eventId || o.eventId === eventId) && (!status || o.status === status));
  const summary: Record<string, { orders: number; tickets: number; amount: number }> = {};
  for (const o of matched) {
    const s = (summary[o.status] ??= { orders: 0, tickets: 0, amount: 0 });
    s.orders++;
    s.tickets += o.quantity;
    s.amount += o.quantity * o.unitPrice;
  }
  const list = matched.sort(byNewest).map((o) => toOrder(db, o, now));
  return ok({ ...paginate(list, query), summary });
});

route('GET', '/api/admin/orders/:id', 'admin', ({ db, params, user, now }) =>
  ok(toOrder(db, findAccessibleOrder(db, params.id, user!), now)),
);
route('POST', '/api/admin/orders/:id/cancel', 'admin', handleCancel);

// ---------- Quản trị: thống kê ----------
// Backend thật lấy số vé từ Azure và doanh thu từ DB GCP. Ở đây tính cả hai từ bản ghi đặt/hủy.

const ZERO = {
  bookedTickets: 0,
  cancelledTickets: 0,
  bookedOrders: 0,
  cancelledOrders: 0,
  netTickets: 0,
  bookedRevenue: 0,
  cancelledRevenue: 0,
  netRevenue: 0,
};
type Counts = typeof ZERO;

function statsRange(query: URLSearchParams, now: Date, defaultDays: number) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const to = query.get('to') ?? vnDayKey(now);
  const from = query.get('from') ?? addDays(to, -(defaultDays - 1));
  if (!day.test(from) || !day.test(to)) fail(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [{ path: 'from', message: 'Ngày phải dạng YYYY-MM-DD' }]);
  if (to < from) fail(400, 'VALIDATION_ERROR', 'Dữ liệu không hợp lệ', [{ path: 'to', message: '"to" phải >= "from"' }]);
  return { from, to };
}

function aggregate(db: MockDb, from: string, to: string, keyOf: (a: MockDb['activities'][number]) => string) {
  const map = new Map<string, Counts>();
  for (const a of db.activities) {
    const day = vnDayKey(a.at);
    if (day < from || day > to) continue;
    const c = map.get(keyOf(a)) ?? { ...ZERO };
    if (a.type === 'BOOKED') {
      c.bookedTickets += a.quantity;
      c.bookedOrders++;
      c.bookedRevenue += a.amount;
    } else {
      c.cancelledTickets += a.quantity;
      c.cancelledOrders++;
      c.cancelledRevenue += a.amount;
    }
    c.netTickets = c.bookedTickets - c.cancelledTickets;
    c.netRevenue = c.bookedRevenue - c.cancelledRevenue;
    map.set(keyOf(a), c);
  }
  return map;
}

function sum(items: Counts[]): Counts {
  return items.reduce(
    (t, i) => Object.fromEntries(Object.keys(ZERO).map((k) => [k, t[k as keyof Counts] + i[k as keyof Counts]])) as Counts,
    { ...ZERO },
  );
}

function statsResponse(groupBy: 'day' | 'event', from: string, to: string, items: Array<Counts & { key: string }>, now: Date) {
  return {
    source: 'mock-frontend',
    stale: false,
    fetchedAt: now.toISOString(),
    query: { groupBy, from, to },
    items,
    totals: sum(items),
    notes: {
      tickets: 'Số vé từ Azure, cập nhật chậm khoảng 1-2 phút sau khi đặt/hủy',
      revenue: 'Doanh thu từ DB GCP (dữ liệu đơn chính thức), thời gian thực',
    },
  };
}

route('GET', '/api/admin/stats/daily', 'admin', ({ db, query, now }) => {
  const { from, to } = statsRange(query, now, 30);
  const map = aggregate(db, from, to, (a) => vnDayKey(a.at));
  const items = [];
  for (let key = from; key <= to; key = addDays(key, 1)) items.push({ key, ...(map.get(key) ?? ZERO) });
  return ok(statsResponse('day', from, to, items, now));
});

route('GET', '/api/admin/stats/events', 'admin', ({ db, query, now }) => {
  const { from, to } = statsRange(query, now, 30);
  const map = aggregate(db, from, to, (a) => a.eventId);
  const items = [...map.entries()]
    .map(([key, c]) => ({ key, ...c, eventTitle: db.events.find((e) => e.id === key)?.title ?? null }))
    .sort((a, b) => b.netTickets - a.netTickets || a.key.localeCompare(b.key));
  return ok(statsResponse('event', from, to, items, now));
});

// ---------- Bộ định tuyến ----------

function authenticate(db: MockDb, header: string | null, now: Date, required: boolean): DbUser | null {
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  const session = token ? db.sessions.find((s) => s.token === token) : undefined;
  if (!session || new Date(session.expiresAt) <= now) {
    if (required) fail(401, 'UNAUTHORIZED', 'Chưa đăng nhập hoặc phiên không hợp lệ');
    return null;
  }
  return db.users.find((u) => u.id === session.userId) ?? null;
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function mockTransport(url: string, init: RequestInit = {}): Promise<Response> {
  if (config.mockLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, config.mockLatencyMs));
  if (mockControls.offline) throw new TypeError('Failed to fetch');

  const { pathname, searchParams } = new URL(url, 'http://mock.local');
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  let body: Record<string, unknown> = {};
  if (typeof init.body === 'string' && init.body) {
    try {
      body = JSON.parse(init.body) ?? {};
    } catch {
      return json(400, { error: { code: 'INVALID_JSON', message: 'Body không phải JSON hợp lệ' } });
    }
  }

  // Làm việc trên bản sao, chỉ lưu khi xử lý thành công (giống một giao dịch).
  const db = structuredClone(loadDb());
  const now = new Date();
  try {
    for (const r of routes) {
      if (r.method !== method) continue;
      const match = r.pattern.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(r.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      const user = authenticate(db, headers.get('Authorization'), now, r.access !== 'public');
      if (r.access === 'admin' && user?.role !== 'admin')
        fail(403, 'FORBIDDEN', 'Chỉ quản trị viên mới được thực hiện thao tác này');
      const result = r.handler({ db, params, query: searchParams, body, headers, user, now });
      saveDb(db);
      if (mockControls.dropNextResponse === `${method} ${pathname}`) {
        mockControls.dropNextResponse = null;
        throw new DroppedResponse();
      }
      return json(result.status, result.body);
    }
    return json(404, { error: { code: 'ROUTE_NOT_FOUND', message: `Không có route ${method} ${pathname}` } });
  } catch (error) {
    if (error instanceof DroppedResponse) throw new TypeError('Failed to fetch');
    if (error instanceof HttpError) {
      return json(error.status, { error: { code: error.code, message: error.message, details: error.details } });
    }
    console.error('[mock] lỗi xử lý', error);
    return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' } });
  }
}
