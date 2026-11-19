// Backend giả chạy ngay trong trình duyệt, trả lời theo cùng hợp đồng với cloud-backend
// (cloud-backend/docs/API.md): cùng đường dẫn, cùng dạng dữ liệu, cùng mã lỗi.
// Dùng khi chạy demo không có backend và trong bộ kiểm thử giao diện.
import { config } from '../../config';
import { addDays, vnDayKey } from '../../lib/dates';
import { DEMO_QUEUE_PREFIX, DEMO_QUEUE_PURCHASE_SECONDS, loadDb, makeUuid, resetMockDb, RULES, saveDb } from './db';
import type { DbEvent, DbOrder, DbQueueEntry, DbQueueSettings, DbSeat, DbSeatMap, DbTicketType, DbUser, MockDb } from './db';

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
    seating: t.seating,
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
  const map = db.seatMaps.find((m) => m.eventId === e.id);
  const q = db.queueSettings.find((x) => x.eventId === e.id);
  return {
    ...toEvent(e),
    ticketTypes: ticketTypesOf(db, e.id).map(toTicketType),
    seatMap: map ? { version: map.version } : null,
    queue: q ? { enabled: q.enabled, saleStartAt: q.saleStartAt, maxActive: q.maxActive, accessMinutes: q.accessMinutes } : null,
  };
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
    seats: seatsOfOrder(db, o),
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    cancelledBy: o.cancelledBy,
    cancelReason: o.cancelReason,
    cancellationDeadline: deadline.toISOString(),
    canCancel: o.status === 'CONFIRMED' && (e.status === 'CANCELLED' || now <= deadline),
  };
}

const byNewest = (a: DbOrder, b: DbOrder) => b.createdAt.localeCompare(a.createdAt);

function seatsOfOrder(db: MockDb, o: DbOrder) {
  const map = db.seatMaps.find((m) => m.eventId === o.eventId);
  return o.seatIds.map((id) => ({ id, label: map?.seats.find((s) => s.id === id)?.label ?? '?' }));
}

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
  if (has('seating') && body.seating !== 'GENERAL' && body.seating !== 'ASSIGNED')
    issues.push({ path: 'seating', message: 'seating phải là GENERAL hoặc ASSIGNED' });
  const assigned = body.seating === 'ASSIGNED';
  if (has('totalQuantity') || (!partial && !assigned)) {
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
  const hasSeats = 'seatIds' in body && body.seatIds !== undefined;
  const seatIds = hasSeats && Array.isArray(body.seatIds) ? (body.seatIds as unknown[]) : [];
  if (hasSeats) {
    if (!Array.isArray(body.seatIds) || seatIds.length === 0 || seatIds.some((x) => typeof x !== 'string'))
      issues.push({ path: 'seatIds', message: 'seatIds phải là danh sách ghế, không rỗng' });
    else if (new Set(seatIds).size !== seatIds.length) issues.push({ path: 'seatIds', message: 'Có ghế bị lặp' });
    if ('quantity' in body && body.quantity !== seatIds.length)
      issues.push({ path: 'quantity', message: 'quantity phải bằng số ghế' });
  } else if (!isInt(body.quantity, 1)) issues.push({ path: 'quantity', message: 'Số lượng phải >= 1' });
  invalid(issues);
  const ticketTypeId = body.ticketTypeId as string;
  const quantity = hasSeats ? seatIds.length : (body.quantity as number);
  const wanted = (seatIds as string[]).slice().sort();
  if (quantity > RULES.maxTicketsPerOrder)
    fail(422, 'QUANTITY_EXCEEDS_LIMIT', `Mỗi đơn được đặt tối đa ${RULES.maxTicketsPerOrder} vé`, {
      requested: quantity,
      max: RULES.maxTicketsPerOrder,
    });

  const key = headers.get('Idempotency-Key')?.trim() || null;
  if (key) {
    const existing = db.orders.find((o) => o.userId === user!.id && o.idempotencyKey === key);
    if (existing) {
      const same =
        existing.ticketTypeId === ticketTypeId &&
        existing.quantity === quantity &&
        existing.seatIds.slice().sort().join(',') === wanted.join(',');
      if (!same) fail(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key đã dùng cho một yêu cầu đặt vé khác');
      return ok(toOrder(db, existing, now), 200);
    }
  }

  const t = db.ticketTypes.find((x) => x.id === ticketTypeId);
  if (!t) fail(404, 'TICKET_TYPE_NOT_FOUND', 'Không tìm thấy hạng vé');
  const e = db.events.find((x) => x.id === t.eventId)!;
  if (e.status === 'CANCELLED') fail(409, 'EVENT_CANCELLED', 'Sự kiện đã bị hủy');
  if (e.status !== 'PUBLISHED') fail(409, 'EVENT_NOT_OPEN', 'Sự kiện chưa mở bán');
  if (new Date(e.startTime) <= now) fail(409, 'EVENT_ALREADY_STARTED', 'Sự kiện đã diễn ra, không thể đặt vé');
  if (t.seating === 'ASSIGNED' && !hasSeats)
    fail(422, 'SEATS_REQUIRED', 'Hạng vé này bán theo ghế, hãy chọn ghế (seatIds)');
  if (t.seating === 'GENERAL' && hasSeats)
    fail(422, 'SEATS_NOT_ALLOWED', 'Hạng vé này không bán theo ghế, chỉ gửi quantity');

  const entry = checkQueueAdmission(db, e.id, user!.id, now);

  if (t.availableQuantity === 0)
    fail(409, 'SOLD_OUT', 'Hạng vé này đã hết', { requested: quantity, available: 0 });
  if (quantity > t.availableQuantity)
    fail(409, 'INSUFFICIENT_TICKETS', `Chỉ còn ${t.availableQuantity} vé, không đủ cho ${quantity} vé yêu cầu`, {
      requested: quantity,
      available: t.availableQuantity,
    });

  if (hasSeats) {
    const map = db.seatMaps.find((m) => m.eventId === e.id);
    const seats = wanted.map((id) => map?.seats.find((x) => x.id === id));
    const missing = wanted.filter((_, i) => !seats[i]);
    if (missing.length) fail(422, 'SEATS_NOT_FOUND', 'Có ghế không thuộc sơ đồ của sự kiện này', { seatIds: missing });
    const found = seats as DbSeat[];
    const wrong = found.filter((x) => x.ticketTypeId !== t.id);
    if (wrong.length)
      fail(422, 'SEAT_TICKET_TYPE_MISMATCH', 'Mỗi đơn chỉ gồm ghế của đúng hạng vé đã chọn', { labels: wrong.map((x) => x.label) });
    const blocked = found.filter((x) => x.blocked);
    if (blocked.length)
      fail(409, 'SEAT_BLOCKED', 'Có ghế đang bị khóa, không bán', {
        seatIds: blocked.map((x) => x.id),
        labels: blocked.map((x) => x.label),
      });
    const sold = soldSeatIds(db, e.id);
    const taken = found.filter((x) => sold.has(x.id));
    if (taken.length)
      fail(409, 'SEAT_TAKEN', `Ghế ${taken.map((x) => x.label).join(', ')} vừa có người đặt, vui lòng chọn ghế khác`, {
        seatIds: taken.map((x) => x.id),
        labels: taken.map((x) => x.label),
      });
  }

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
    seatIds: wanted,
  };
  t.availableQuantity -= quantity;
  db.orders.push(order);
  recordActivity(db, 'BOOKED', order, order.createdAt);
  if (entry) {
    entry.status = 'COMPLETED';
    entry.finishedAt = now.toISOString();
  }
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
  const seating = body.seating === 'ASSIGNED' ? 'ASSIGNED' : 'GENERAL';
  if (seating === 'ASSIGNED' && typeof body.totalQuantity === 'number' && body.totalQuantity > 0)
    fail(409, 'SEAT_MANAGED_QUANTITY', 'Hạng vé theo ghế: số vé tính theo sơ đồ ghế, sửa sơ đồ thay vì nhập totalQuantity');
  if (nameTaken(db, e.id, name)) fail(409, 'TICKET_TYPE_NAME_TAKEN', 'Sự kiện đã có hạng vé cùng tên');
  const total = seating === 'ASSIGNED' ? 0 : (body.totalQuantity as number);
  const t: DbTicketType = {
    id: newId(),
    eventId: e.id,
    name,
    description: typeof body.description === 'string' ? body.description : '',
    price: body.price as number,
    seating,
    totalQuantity: total,
    availableQuantity: total,
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
  const nextSeating = (body.seating as DbTicketType['seating'] | undefined) ?? t.seating;
  const changingSeating = nextSeating !== t.seating;
  if (changingSeating) {
    if (db.orders.some((o) => o.ticketTypeId === t.id))
      fail(409, 'TICKET_TYPE_HAS_ORDERS', 'Hạng vé đã có đơn, không đổi được cách bán (theo số lượng / theo ghế)');
    const seats = db.seatMaps.find((m) => m.eventId === t.eventId)?.seats.filter((x) => x.ticketTypeId === t.id).length ?? 0;
    if (t.seating === 'ASSIGNED' && seats > 0)
      fail(409, 'TICKET_TYPE_HAS_SEATS', 'Hạng vé đang có ghế trên sơ đồ, hãy gỡ các ghế này khỏi sơ đồ trước', { seats });
  }
  if ('totalQuantity' in body && nextSeating === 'ASSIGNED')
    fail(409, 'SEAT_MANAGED_QUANTITY', 'Hạng vé theo ghế: số vé tính theo sơ đồ ghế, sửa sơ đồ thay vì nhập totalQuantity');
  if ('totalQuantity' in body && !changingSeating) {
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
  if (changingSeating) {
    t.seating = nextSeating;
    t.totalQuantity = 0;
    t.availableQuantity = 0;
  }
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

// ---------- Sơ đồ ghế ----------

function soldSeatIds(db: MockDb, eventId: string): Set<string> {
  return new Set(db.orders.filter((o) => o.eventId === eventId && o.status === 'CONFIRMED').flatMap((o) => o.seatIds));
}

/** Hạng ASSIGNED: tổng vé = số ghế không bị khóa, còn lại = tổng − số ghế đang được giữ. */
function recomputeAssigned(db: MockDb, eventId: string) {
  const map = db.seatMaps.find((m) => m.eventId === eventId);
  const sold = soldSeatIds(db, eventId);
  for (const t of db.ticketTypes.filter((x) => x.eventId === eventId && x.seating === 'ASSIGNED')) {
    const seats = map?.seats.filter((x) => x.ticketTypeId === t.id) ?? [];
    t.totalQuantity = seats.filter((x) => !x.blocked).length;
    t.availableQuantity = seats.filter((x) => !x.blocked && !sold.has(x.id)).length;
  }
}

const toSeatMap = (m: DbSeatMap) => ({ ...m, seats: m.seats.map((x) => ({ ...x })) });

function findMap(db: MockDb, eventId: string, publicView: boolean) {
  const e = db.events.find((x) => x.id === eventId);
  if (!e || (publicView && e.status !== 'PUBLISHED')) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  const map = db.seatMaps.find((m) => m.eventId === eventId);
  if (!map) fail(404, 'SEAT_MAP_NOT_FOUND', 'Không tìm thấy sơ đồ ghế');
  return { e, map };
}

function seatStatus(db: MockDb, eventId: string, publicView: boolean) {
  const { map } = findMap(db, eventId, publicView);
  return {
    eventId,
    version: map.version,
    sold: [...soldSeatIds(db, eventId)],
    blocked: map.seats.filter((x) => x.blocked).map((x) => x.id),
  };
}

route('GET', '/api/events/:id/seat-map', 'public', ({ db, params }) => ok(toSeatMap(findMap(db, params.id, true).map)));
route('GET', '/api/events/:id/seats/status', 'public', ({ db, params }) => ok(seatStatus(db, params.id, true)));
route('GET', '/api/admin/events/:id/seat-map', 'admin', ({ db, params }) => ok(toSeatMap(findMap(db, params.id, false).map)));
route('GET', '/api/admin/events/:id/seats/status', 'admin', ({ db, params }) => ok(seatStatus(db, params.id, false)));

const SECTION_KEY = /^[A-Za-z0-9_-]{1,50}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

type SeatInput = Omit<DbSeat, 'id'>;

/** Kiểm tra và lưu toàn bộ sơ đồ (dùng cho PUT và chép sơ đồ). */
function saveSeatMap(db: MockDb, e: DbEvent, body: Record<string, unknown>, now: Date) {
  if (e.status === 'CANCELLED') fail(409, 'EVENT_CANCELLED', 'Sự kiện đã hủy');
  const issues: Issue[] = [];
  if (!isInt(body.version, 0)) issues.push({ path: 'version', message: 'version phải là số nguyên >= 0' });
  for (const k of ['width', 'height']) {
    const v = body[k];
    if (!isInt(v, 100) || (v as number) > 20000) issues.push({ path: k, message: `${k} phải là số nguyên 100–20000` });
  }
  const seatSize = body.seatSize === undefined ? 24 : body.seatSize;
  if (!isNum(seatSize) || (seatSize as number) <= 0 || (seatSize as number) > 500)
    issues.push({ path: 'seatSize', message: 'seatSize phải > 0 và tối đa 500' });
  const sections = Array.isArray(body.sections) ? (body.sections as Array<Record<string, unknown>>) : [];
  if (!Array.isArray(body.sections ?? [])) issues.push({ path: 'sections', message: 'sections phải là danh sách' });
  if (sections.length > 100) issues.push({ path: 'sections', message: 'Tối đa 100 khu' });
  const keys = new Set<string>();
  sections.forEach((sec, i) => {
    const key = String(sec?.key ?? '');
    if (!SECTION_KEY.test(key)) issues.push({ path: `sections.${i}.key`, message: 'key chỉ gồm chữ không dấu, số, "-", "_"' });
    else if (keys.has(key)) issues.push({ path: `sections.${i}.key`, message: `Trùng khu "${key}"` });
    keys.add(key);
    if (!text(sec?.name)) issues.push({ path: `sections.${i}.name`, message: 'Tên khu không được trống' });
    if (sec?.color != null && !COLOR.test(String(sec.color))) issues.push({ path: `sections.${i}.color`, message: 'Màu phải dạng #RRGGBB' });
  });
  const rawSeats = Array.isArray(body.seats) ? (body.seats as Array<Record<string, unknown>>) : null;
  if (!rawSeats) issues.push({ path: 'seats', message: 'seats phải là danh sách' });
  else if (rawSeats.length > 5000) issues.push({ path: 'seats', message: 'Tối đa 5000 ghế' });
  const decorations = Array.isArray(body.decorations) ? (body.decorations as Array<Record<string, unknown>>) : [];
  if (decorations.length > 200) issues.push({ path: 'decorations', message: 'Tối đa 200 hình trang trí' });
  decorations.forEach((d, i) => {
    if (!text(d?.type) || String(d.type).length > 30) issues.push({ path: `decorations.${i}.type`, message: 'type 1–30 ký tự' });
  });
  invalid(issues.slice(0, 20));

  const width = body.width as number;
  const height = body.height as number;
  const size = seatSize as number;
  const labels = new Set<string>();
  const seats: SeatInput[] = [];
  (rawSeats ?? []).forEach((raw, i) => {
    const label = text(raw?.label);
    if (!label || label.length > 20) issues.push({ path: `seats.${i}.label`, message: 'Nhãn ghế 1–20 ký tự' });
    else if (labels.has(label)) issues.push({ path: `seats.${i}.label`, message: `Trùng nhãn ghế "${label}"` });
    labels.add(label);
    const section = raw?.section == null ? null : String(raw.section);
    if (section !== null && !keys.has(section)) issues.push({ path: `seats.${i}.section`, message: `Không có khu "${section}"` });
    if (!isNum(raw?.x) || !isNum(raw?.y)) issues.push({ path: `seats.${i}`, message: `Ghế "${label}" thiếu tọa độ` });
    const rotation = raw?.rotation === undefined ? 0 : raw.rotation;
    if (!isNum(rotation) || Math.abs(rotation as number) > 360) issues.push({ path: `seats.${i}.rotation`, message: 'rotation từ -360 đến 360' });
    if (typeof raw?.ticketTypeId !== 'string') issues.push({ path: `seats.${i}.ticketTypeId`, message: 'Thiếu hạng vé' });
    seats.push({
      label,
      row: raw?.row == null ? null : String(raw.row),
      section,
      ticketTypeId: String(raw?.ticketTypeId ?? ''),
      x: Number(raw?.x),
      y: Number(raw?.y),
      rotation: Number(rotation),
      accessible: raw?.accessible === true,
      blocked: raw?.blocked === true,
    });
  });
  // Ghế nằm trọn trong khung và không chồng nhau (khoảng cách tâm < seatSize).
  const r = size / 2;
  seats.forEach((st, i) => {
    if (st.x - r < 0 || st.y - r < 0 || st.x + r > width || st.y + r > height)
      issues.push({ path: `seats.${i}`, message: `Ghế "${st.label}" nằm ngoài khung sơ đồ` });
  });
  const order = seats.map((_, i) => i).sort((a, b) => seats[a].x - seats[b].x);
  for (let a = 0; a < order.length && issues.length < 20; a++) {
    for (let b = a + 1; b < order.length; b++) {
      const p = seats[order[a]];
      const q = seats[order[b]];
      if (q.x - p.x >= size) break;
      if (Math.hypot(q.x - p.x, q.y - p.y) < size - 1e-9) {
        const [first, second] = order[a] < order[b] ? [p, q] : [q, p];
        issues.push({ path: `seats.${Math.max(order[a], order[b])}`, message: `Ghế "${second.label}" chồng lên ghế "${first.label}"` });
      }
    }
  }
  if (issues.length) fail(400, 'VALIDATION_ERROR', 'Sơ đồ ghế không hợp lệ', issues.slice(0, 20));

  const current = db.seatMaps.find((m) => m.eventId === e.id);
  const currentVersion = current?.version ?? 0;
  if (body.version !== currentVersion)
    fail(409, 'SEAT_MAP_VERSION_CONFLICT', 'Sơ đồ đã bị thay đổi bởi người khác, hãy tải lại rồi sửa tiếp', {
      currentVersion,
      yourVersion: body.version,
    });
  const assigned = new Set(db.ticketTypes.filter((t) => t.eventId === e.id && t.seating === 'ASSIGNED').map((t) => t.id));
  const badType = seats.filter((st) => !assigned.has(st.ticketTypeId));
  if (badType.length)
    fail(422, 'INVALID_SEAT_TICKET_TYPE', 'Ghế chỉ được gán cho hạng vé chọn ghế (ASSIGNED) của chính sự kiện này', {
      seats: badType.slice(0, 20).map((st) => st.label),
    });
  const sold = soldSeatIds(db, e.id);
  const locked: Array<{ label: string; reason: string }> = [];
  for (const old of current?.seats.filter((x) => sold.has(x.id)) ?? []) {
    const next = seats.find((st) => st.label === old.label);
    if (!next) locked.push({ label: old.label, reason: 'xóa ghế đã bán' });
    else if (next.ticketTypeId !== old.ticketTypeId) locked.push({ label: old.label, reason: 'đổi hạng ghế đã bán' });
    else if (next.blocked) locked.push({ label: old.label, reason: 'khóa ghế đã bán' });
  }
  if (locked.length)
    fail(409, 'SEAT_SOLD_LOCKED', 'Không thể xóa, đổi hạng hoặc khóa ghế đã có người đặt', { seats: locked });

  const saved: DbSeatMap = {
    eventId: e.id,
    version: currentVersion + 1,
    width,
    height,
    seatSize: size,
    sections: sections.map((sec) => ({ key: String(sec.key), name: text(sec.name), color: sec.color == null ? null : String(sec.color) })),
    decorations: decorations.map((d) => ({ ...d, type: String(d.type) })),
    seats: seats.map((st) => ({ ...st, id: current?.seats.find((x) => x.label === st.label)?.id ?? newId() })),
    updatedAt: now.toISOString(),
  };
  db.seatMaps = db.seatMaps.filter((m) => m.eventId !== e.id).concat(saved);
  recomputeAssigned(db, e.id);
  return saved;
}

route('PUT', '/api/admin/events/:id/seat-map', 'admin', ({ db, params, body, now }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  return ok(toSeatMap(saveSeatMap(db, e, body, now)));
});

route('POST', '/api/admin/events/:id/seat-map/copy-from/:sourceId', 'admin', ({ db, params, body, now }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  if (params.id === params.sourceId) fail(400, 'VALIDATION_ERROR', 'Không chép sơ đồ từ chính sự kiện này');
  const src = db.seatMaps.find((m) => m.eventId === params.sourceId);
  if (!src) fail(404, 'SEAT_MAP_NOT_FOUND', 'Không tìm thấy sơ đồ ghế của sự kiện nguồn');
  const srcName = new Map(db.ticketTypes.filter((t) => t.eventId === src.eventId).map((t) => [t.id, t.name]));
  const target = new Map(
    db.ticketTypes.filter((t) => t.eventId === e.id && t.seating === 'ASSIGNED').map((t) => [t.name.toLowerCase(), t.id]),
  );
  const names = [...new Set(src.seats.map((x) => srcName.get(x.ticketTypeId) ?? ''))];
  const missing = names.filter((n) => !target.has(n.toLowerCase()));
  if (missing.length)
    fail(422, 'TICKET_TYPE_MAPPING_FAILED', `Sự kiện này cần có hạng vé chọn ghế cùng tên: ${missing.join(', ')}`, { missing });
  const input = {
    version: body.version,
    width: src.width,
    height: src.height,
    seatSize: src.seatSize,
    sections: src.sections,
    decorations: src.decorations,
    seats: src.seats.map(({ id: _id, ...rest }) => ({
      ...rest,
      ticketTypeId: target.get((srcName.get(rest.ticketTypeId) ?? '').toLowerCase())!,
    })),
  };
  return ok(toSeatMap(saveSeatMap(db, e, input, now)));
});

route('PATCH', '/api/admin/events/:id/seats', 'admin', ({ db, params, body }) => {
  const issues: Issue[] = [];
  const ids = Array.isArray(body.seatIds) ? (body.seatIds as unknown[]) : null;
  if (!ids || ids.length === 0 || ids.some((x) => typeof x !== 'string'))
    issues.push({ path: 'seatIds', message: 'seatIds phải là danh sách ghế, không rỗng' });
  if (typeof body.blocked !== 'boolean') issues.push({ path: 'blocked', message: 'blocked phải là true hoặc false' });
  invalid(issues);
  const { e, map } = findMap(db, params.id, false);
  if (e.status === 'CANCELLED') fail(409, 'EVENT_CANCELLED', 'Sự kiện đã hủy');
  const seats = (ids as string[]).map((id) => map.seats.find((x) => x.id === id));
  const missing = (ids as string[]).filter((_, i) => !seats[i]);
  if (missing.length) fail(422, 'SEATS_NOT_FOUND', 'Có ghế không thuộc sơ đồ của sự kiện này', { seatIds: missing });
  const sold = soldSeatIds(db, e.id);
  const blocked = body.blocked as boolean;
  const lockedSold = (seats as DbSeat[]).filter((x) => blocked && sold.has(x.id));
  if (lockedSold.length)
    fail(409, 'SEAT_SOLD_LOCKED', 'Không khóa được ghế đã có người đặt', {
      seats: lockedSold.map((x) => ({ label: x.label, reason: 'đã có người đặt' })),
    });
  let changed = 0;
  for (const st of seats as DbSeat[]) {
    if (st.blocked !== blocked) {
      st.blocked = blocked;
      changed++;
    }
  }
  if (changed) {
    map.version++;
    recomputeAssigned(db, e.id);
  }
  return ok({ version: map.version, changed });
});

// ---------- Hàng chờ ảo ----------

const isDemoQueueUser = (userId: string) => userId.startsWith(DEMO_QUEUE_PREFIX);

/** Một nhịp của worker hàng chờ (src/queue/worker.ts): xếp ngẫu nhiên, cho hết hạn, cho người kế tiếp vào. */
function queueTick(db: MockDb, s: DbQueueSettings, now: Date) {
  const result = { admitted: 0, expired: 0, dropped: 0 };
  if (!s.enabled || new Date(s.saleStartAt) > now) return result;
  const nowIso = now.toISOString();
  const entries = db.queueEntries.filter((x) => x.eventId === s.eventId);
  if (!s.randomizedAt) {
    const early = entries.filter((x) => x.status === 'WAITING' && x.position === null);
    for (let i = early.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [early[i], early[j]] = [early[j], early[i]];
    }
    for (const x of early) x.position = ++s.lastPosition;
    s.randomizedAt = nowIso;
  }
  for (const x of entries) {
    if (isDemoQueueUser(x.userId)) {
      // Người giả luôn đang mở trang và mua xong sau vài chục giây.
      if (x.status === 'WAITING') x.lastSeenAt = nowIso;
      if (x.status === 'ADMITTED' && now.getTime() - new Date(x.admittedAt!).getTime() >= DEMO_QUEUE_PURCHASE_SECONDS * 1000) {
        x.status = 'COMPLETED';
        x.finishedAt = nowIso;
      }
    }
    if (x.status === 'ADMITTED' && x.expiresAt && new Date(x.expiresAt) <= now) {
      x.status = 'EXPIRED';
      x.finishedAt = nowIso;
      result.expired++;
    }
    if (x.status === 'WAITING' && now.getTime() - new Date(x.lastSeenAt).getTime() > RULES.queueStaleSeconds * 1000) {
      x.status = 'EXPIRED';
      x.finishedAt = nowIso;
      result.dropped++;
    }
  }
  let active = entries.filter((x) => x.status === 'ADMITTED').length;
  const waiting = entries
    .filter((x) => x.status === 'WAITING' && x.position !== null)
    .sort((a, b) => a.position! - b.position!);
  for (const x of waiting) {
    if (active >= s.maxActive) break;
    x.status = 'ADMITTED';
    x.admittedAt = nowIso;
    x.expiresAt = new Date(now.getTime() + s.accessMinutes * 60_000).toISOString();
    active++;
    result.admitted++;
  }
  return result;
}

function retryAfter(s: DbQueueSettings, x: DbQueueEntry, ahead: number | null, now: Date): number | null {
  if (!s.enabled) return null;
  let sec: number;
  if (x.status === 'WAITING') {
    const untilSale = (new Date(s.saleStartAt).getTime() - now.getTime()) / 1000;
    if (untilSale > 0) sec = untilSale > 120 ? 30 : untilSale > 15 ? 10 : 3;
    else sec = (ahead ?? 0) > 1000 ? 15 : (ahead ?? 0) > 100 ? 10 : 5;
  } else if (x.status === 'ADMITTED') sec = 30;
  else return null;
  return Math.max(2, Math.min(sec, Math.floor(RULES.queueStaleSeconds / 3)));
}

function toQueueEntry(db: MockDb, s: DbQueueSettings, x: DbQueueEntry, now: Date) {
  const waiting = db.queueEntries.filter((y) => y.eventId === s.eventId && y.status === 'WAITING');
  const ahead =
    x.status === 'WAITING' && x.position !== null ? waiting.filter((y) => y.position !== null && y.position < x.position!).length : null;
  return {
    eventId: s.eventId,
    status: x.status,
    queueEnabled: s.enabled,
    position: x.position,
    aheadOfYou: ahead,
    waitingCount: waiting.length,
    saleStartAt: s.saleStartAt,
    saleStarted: new Date(s.saleStartAt) <= now,
    admittedAt: x.admittedAt,
    expiresAt: x.expiresAt,
    retryAfterSeconds: retryAfter(s, x, ahead, now),
    serverTime: now.toISOString(),
  };
}

/** Đặt vé cho sự kiện bật hàng chờ: phải đang ADMITTED và còn hạn. Trả lượt để đánh dấu COMPLETED. */
function checkQueueAdmission(db: MockDb, eventId: string, userId: string, now: Date): DbQueueEntry | null {
  const s = db.queueSettings.find((x) => x.eventId === eventId);
  if (!s || !s.enabled) return null;
  queueTick(db, s, now);
  if (new Date(s.saleStartAt) > now) fail(409, 'SALE_NOT_STARTED', 'Chưa tới giờ mở bán', { saleStartAt: s.saleStartAt });
  const x = db.queueEntries.find((y) => y.eventId === eventId && y.userId === userId);
  if (!x || x.status !== 'ADMITTED' || (x.expiresAt && new Date(x.expiresAt) <= now))
    fail(409, 'QUEUE_ADMISSION_REQUIRED', 'Bạn cần xếp hàng và tới lượt mới đặt được vé', { queueStatus: x?.status ?? null });
  return x;
}

function queueOf(db: MockDb, eventId: string) {
  const s = db.queueSettings.find((x) => x.eventId === eventId);
  if (!s) fail(404, 'QUEUE_NOT_CONFIGURED', 'Không tìm thấy cấu hình hàng chờ');
  return s;
}

function myEntry(db: MockDb, eventId: string, userId: string) {
  const x = db.queueEntries.find((y) => y.eventId === eventId && y.userId === userId);
  if (!x) fail(404, 'QUEUE_ENTRY_NOT_FOUND', 'Không tìm thấy lượt xếp hàng');
  return x;
}

route('POST', '/api/events/:id/queue', 'user', ({ db, params, user, now }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e || e.status !== 'PUBLISHED') fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  if (new Date(e.startTime) <= now) fail(409, 'EVENT_ALREADY_STARTED', 'Sự kiện đã diễn ra');
  const s = db.queueSettings.find((x) => x.eventId === e.id);
  if (!s || !s.enabled) fail(409, 'QUEUE_NOT_ENABLED', 'Sự kiện này không dùng hàng chờ, có thể đặt vé trực tiếp');
  queueTick(db, s, now);
  const nowIso = now.toISOString();
  let x = db.queueEntries.find((y) => y.eventId === e.id && y.userId === user!.id);
  const active = x && (x.status === 'WAITING' || (x.status === 'ADMITTED' && new Date(x.expiresAt!) > now));
  if (x && active) {
    x.lastSeenAt = nowIso;
    return ok(toQueueEntry(db, s, x, now), 200);
  }
  const position = s.randomizedAt ? ++s.lastPosition : null;
  const fresh: DbQueueEntry = {
    eventId: e.id,
    userId: user!.id,
    status: 'WAITING',
    position,
    joinedAt: nowIso,
    lastSeenAt: nowIso,
    admittedAt: null,
    expiresAt: null,
    finishedAt: null,
  };
  if (x) Object.assign(x, fresh);
  else db.queueEntries.push((x = fresh));
  queueTick(db, s, now);
  return ok(toQueueEntry(db, s, x, now), 201);
});

route('GET', '/api/events/:id/queue/me', 'user', ({ db, params, user, now }) => {
  const x = myEntry(db, params.id, user!.id);
  const s = queueOf(db, params.id);
  x.lastSeenAt = now.toISOString();
  queueTick(db, s, now);
  return ok(toQueueEntry(db, s, x, now));
});

route('DELETE', '/api/events/:id/queue/me', 'user', ({ db, params, user, now }) => {
  const x = myEntry(db, params.id, user!.id);
  const s = queueOf(db, params.id);
  if (x.status === 'WAITING' || x.status === 'ADMITTED') {
    x.status = 'LEFT';
    x.finishedAt = now.toISOString();
  }
  queueTick(db, s, now);
  return ok(toQueueEntry(db, s, x, now));
});

function toQueueSettings(db: MockDb, s: DbQueueSettings) {
  const counts: Record<string, number> = {};
  for (const x of db.queueEntries.filter((y) => y.eventId === s.eventId)) counts[x.status] = (counts[x.status] ?? 0) + 1;
  const { lastPosition: _last, ...rest } = s;
  return { ...rest, counts };
}

route('GET', '/api/admin/events/:id/queue', 'admin', ({ db, params }) => ok(toQueueSettings(db, queueOf(db, params.id))));

route('PUT', '/api/admin/events/:id/queue', 'admin', ({ db, params, body, now }) => {
  const e = db.events.find((x) => x.id === params.id);
  if (!e) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện');
  const issues: Issue[] = [];
  if (typeof body.enabled !== 'boolean') issues.push({ path: 'enabled', message: 'enabled phải là true hoặc false' });
  if (typeof body.saleStartAt !== 'string' || !/(Z|[+-]\d{2}:?\d{2})$/.test(body.saleStartAt) || !isIso(body.saleStartAt))
    issues.push({ path: 'saleStartAt', message: 'Giờ mở bán phải theo ISO 8601 có múi giờ' });
  if (!isInt(body.maxActive, 1) || (body.maxActive as number) > 10000)
    issues.push({ path: 'maxActive', message: 'Số người mua cùng lúc từ 1 đến 10000' });
  if (!isInt(body.accessMinutes, 1) || (body.accessMinutes as number) > 120)
    issues.push({ path: 'accessMinutes', message: 'Số phút mỗi lượt từ 1 đến 120' });
  invalid(issues);
  if (e.status === 'CANCELLED') fail(409, 'EVENT_CANCELLED', 'Sự kiện đã hủy');
  const saleStartAt = new Date(body.saleStartAt as string).toISOString();
  let s = db.queueSettings.find((x) => x.eventId === e.id);
  if (s && new Date(s.saleStartAt) <= now && new Date(s.saleStartAt).getTime() !== new Date(saleStartAt).getTime())
    fail(409, 'QUEUE_ALREADY_STARTED', 'Hàng chờ đã mở bán, không đổi được giờ mở bán nữa', { saleStartAt: s.saleStartAt });
  if (!s) {
    s = { eventId: e.id, enabled: false, saleStartAt, maxActive: 1, accessMinutes: 1, randomizedAt: null, lastPosition: 0, updatedAt: '' };
    db.queueSettings.push(s);
  }
  s.enabled = body.enabled as boolean;
  s.saleStartAt = saleStartAt;
  s.maxActive = body.maxActive as number;
  s.accessMinutes = body.accessMinutes as number;
  s.updatedAt = now.toISOString();
  return ok(toQueueSettings(db, s));
});

route('POST', '/api/admin/events/:id/queue/tick', 'admin', ({ db, params, now }) => {
  const s = queueOf(db, params.id);
  const r = queueTick(db, s, now);
  return ok({ tick: { events: 1, ...r }, settings: toQueueSettings(db, s) });
});

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
