// Backend giả chạy ngay trong trình duyệt, trả lời đúng theo docs/API-CONTRACT.md.
// Mục đích: frontend làm và kiểm thử song song khi backend thật chưa xong.
import { config } from '../../config';
import { addDays, shortDayLabel, vnDayKey } from '../../lib/dates';
import { heldQuantity, loadDb, resetMockDb, saveDb } from './db';
import type { DbOrder, DbTicketType, DbUser, MockDb } from './db';

/** Điều khiển backend giả từ giao diện (chân trang) và từ test. */
export const mockControls = {
  offline: false,
  setOffline(value: boolean) {
    mockControls.offline = value;
  },
  reset() {
    resetMockDb();
  },
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

function fail(status: number, code: string, message: string, details?: Record<string, string>): never {
  throw new HttpError(status, code, message, details);
}

interface Ctx {
  db: MockDb;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
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

const publicUser = (u: DbUser) => ({ id: u.id, username: u.username, role: u.role, fullName: u.fullName });

function toTicketType(db: MockDb, tt: DbTicketType) {
  return {
    id: tt.id,
    eventId: tt.eventId,
    name: tt.name,
    price: tt.price,
    totalQuantity: tt.totalQuantity,
    remainingQuantity: tt.totalQuantity - heldQuantity(db, tt.id),
  };
}

function toEventDetail(db: MockDb, eventId: string) {
  const ev = db.events.find((e) => e.id === eventId);
  if (!ev) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
  return {
    ...ev,
    ticketTypes: db.ticketTypes.filter((t) => t.eventId === ev.id).map((t) => toTicketType(db, t)),
  };
}

function toOrder(db: MockDb, o: DbOrder) {
  const ev = db.events.find((e) => e.id === o.eventId);
  const tt = db.ticketTypes.find((t) => t.id === o.ticketTypeId);
  const user = db.users.find((u) => u.id === o.userId);
  return {
    id: o.id,
    eventId: o.eventId,
    eventName: ev?.name ?? '(sự kiện đã xóa)',
    eventStartTime: ev?.startTime ?? '',
    ticketTypeId: o.ticketTypeId,
    ticketTypeName: tt?.name ?? '(hạng vé đã xóa)',
    quantity: o.quantity,
    unitPrice: o.unitPrice,
    totalAmount: o.unitPrice * o.quantity,
    status: o.status,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    userId: o.userId,
    username: user?.username ?? o.userId,
  };
}

const byNewest = (a: DbOrder, b: DbOrder) => b.createdAt.localeCompare(a.createdAt);

// ---------- Kiểm tra dữ liệu ----------

const CATEGORIES = ['concert', 'sports', 'musical'];
const isNonNegativeInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isPositiveInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

function validateEvent(body: Record<string, unknown>) {
  const details: Record<string, string> = {};
  const name = text(body.name);
  const venue = text(body.venue);
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!name) details.name = 'Tên sự kiện là bắt buộc.';
  else if (name.length > 200) details.name = 'Tên sự kiện tối đa 200 ký tự.';
  if (!CATEGORIES.includes(String(body.category))) details.category = 'Loại hình phải là concert, sports hoặc musical.';
  if (typeof body.startTime !== 'string' || Number.isNaN(new Date(body.startTime).getTime()))
    details.startTime = 'Thời gian diễn ra không hợp lệ.';
  if (!venue) details.venue = 'Địa điểm là bắt buộc.';
  if (description.length > 2000) details.description = 'Mô tả tối đa 2000 ký tự.';
  if (Object.keys(details).length) fail(400, 'VALIDATION_ERROR', 'Dữ liệu sự kiện không hợp lệ.', details);
  return {
    name,
    category: body.category as MockDb['events'][number]['category'],
    description,
    startTime: new Date(body.startTime as string).toISOString(),
    venue,
  };
}

function validateTicketType(db: MockDb, eventId: string, body: Record<string, unknown>, selfId?: string) {
  const details: Record<string, string> = {};
  const name = text(body.name);
  if (!name) details.name = 'Tên hạng vé là bắt buộc.';
  else if (name.length > 100) details.name = 'Tên hạng vé tối đa 100 ký tự.';
  else if (db.ticketTypes.some((t) => t.eventId === eventId && t.id !== selfId && t.name.toLowerCase() === name.toLowerCase()))
    details.name = 'Sự kiện đã có hạng vé cùng tên.';
  if (!isNonNegativeInt(body.price)) details.price = 'Giá vé phải là số nguyên không âm.';
  if (!isPositiveInt(body.totalQuantity)) details.totalQuantity = 'Số lượng mở bán phải là số nguyên dương.';
  if (Object.keys(details).length) fail(400, 'VALIDATION_ERROR', 'Dữ liệu hạng vé không hợp lệ.', details);
  return { name, price: body.price as number, totalQuantity: body.totalQuantity as number };
}

// ---------- Tài khoản ----------

route('POST', '/api/auth/login', 'public', ({ db, body, now }) => {
  const username = text(body.username);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) {
    const details: Record<string, string> = {};
    if (!username) details.username = 'Vui lòng nhập tài khoản.';
    if (!password) details.password = 'Vui lòng nhập mật khẩu.';
    fail(400, 'VALIDATION_ERROR', 'Vui lòng nhập đầy đủ tài khoản và mật khẩu.', details);
  }
  const user = db.users.find((u) => u.username === username);
  if (!user || user.password !== password) fail(401, 'INVALID_CREDENTIALS', 'Sai tài khoản hoặc mật khẩu.');
  const token = `mock.${user.id}.${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  db.sessions.push({ token, userId: user.id, expiresAt: new Date(now.getTime() + 8 * 3_600_000).toISOString() });
  return ok({ token, user: publicUser(user) });
});

route('GET', '/api/auth/me', 'user', ({ user }) => ok(publicUser(user!)));

// ---------- Sự kiện ----------

route('GET', '/api/events', 'public', ({ db, query }) => {
  const category = query.get('category');
  const list = db.events
    .filter((e) => !category || e.category === category)
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .map(({ id, name, category: c, startTime, venue }) => ({ id, name, category: c, startTime, venue }));
  return ok(list);
});

route('GET', '/api/events/:id', 'public', ({ db, params }) => ok(toEventDetail(db, params.id)));

// ---------- Đơn của khách ----------

route('POST', '/api/orders', 'user', ({ db, body, user, now }) => {
  if (user!.role !== 'customer') fail(403, 'FORBIDDEN', 'Tài khoản quản trị không dùng để đặt vé.');
  const quantity = body.quantity;
  if (!isPositiveInt(quantity))
    fail(400, 'VALIDATION_ERROR', 'Số lượng phải là số nguyên dương.', { quantity: 'Số lượng phải là số nguyên dương.' });
  const tt = db.ticketTypes.find((t) => t.id === String(body.ticketTypeId));
  if (!tt) fail(404, 'TICKET_TYPE_NOT_FOUND', 'Không tìm thấy hạng vé.');
  const ev = db.events.find((e) => e.id === tt.eventId)!;
  if (new Date(ev.startTime) <= now) fail(409, 'EVENT_CLOSED', 'Sự kiện đã diễn ra, không thể đặt vé.');
  const remaining = tt.totalQuantity - heldQuantity(db, tt.id);
  if (remaining <= 0) fail(409, 'SOLD_OUT', `Hạng vé "${tt.name}" đã hết.`);
  if ((quantity as number) > remaining)
    fail(409, 'INSUFFICIENT_TICKETS', `Hạng vé "${tt.name}" chỉ còn ${remaining} vé.`);
  const order: DbOrder = {
    id: `DH${++db.seq}`,
    userId: user!.id,
    eventId: tt.eventId,
    ticketTypeId: tt.id,
    quantity: quantity as number,
    unitPrice: tt.price,
    status: 'CONFIRMED',
    createdAt: now.toISOString(),
    cancelledAt: null,
  };
  db.orders.push(order);
  db.activities.push({
    id: `A-${order.id}-B`,
    type: 'BOOKED',
    orderId: order.id,
    eventId: order.eventId,
    ticketTypeId: order.ticketTypeId,
    quantity: order.quantity,
    at: order.createdAt,
  });
  return ok(toOrder(db, order), 201);
});

route('GET', '/api/orders', 'user', ({ db, user }) =>
  ok(db.orders.filter((o) => o.userId === user!.id).sort(byNewest).map((o) => toOrder(db, o))),
);

function findOwnOrder(db: MockDb, id: string, user: DbUser) {
  const order = db.orders.find((o) => o.id === id);
  // Đơn của người khác cũng trả 404 để không lộ thông tin.
  if (!order || order.userId !== user.id) fail(404, 'ORDER_NOT_FOUND', 'Không tìm thấy đơn đặt vé.');
  return order;
}

route('GET', '/api/orders/:id', 'user', ({ db, params, user }) => ok(toOrder(db, findOwnOrder(db, params.id, user!))));

route('POST', '/api/orders/:id/cancel', 'user', ({ db, params, user, now }) => {
  const order = findOwnOrder(db, params.id, user!);
  if (order.status === 'CANCELLED') fail(409, 'ALREADY_CANCELLED', 'Đơn này đã được hủy trước đó.');
  const ev = db.events.find((e) => e.id === order.eventId);
  if (ev && new Date(ev.startTime) <= now) fail(409, 'CANCEL_NOT_ALLOWED', 'Sự kiện đã diễn ra nên không thể hủy đơn.');
  order.status = 'CANCELLED';
  order.cancelledAt = now.toISOString();
  db.activities.push({
    id: `A-${order.id}-C`,
    type: 'CANCELLED',
    orderId: order.id,
    eventId: order.eventId,
    ticketTypeId: order.ticketTypeId,
    quantity: order.quantity,
    at: order.cancelledAt,
  });
  return ok(toOrder(db, order));
});

// ---------- Quản trị ----------

route('POST', '/api/admin/events', 'admin', ({ db, body }) => {
  const data = validateEvent(body);
  const ev = { id: `ev-${++db.seq}`, ...data };
  db.events.push(ev);
  return ok(toEventDetail(db, ev.id), 201);
});

route('PUT', '/api/admin/events/:id', 'admin', ({ db, params, body }) => {
  const ev = db.events.find((e) => e.id === params.id);
  if (!ev) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
  Object.assign(ev, validateEvent(body));
  return ok(toEventDetail(db, ev.id));
});

route('POST', '/api/admin/events/:id/ticket-types', 'admin', ({ db, params, body }) => {
  if (!db.events.some((e) => e.id === params.id)) fail(404, 'EVENT_NOT_FOUND', 'Không tìm thấy sự kiện.');
  const data = validateTicketType(db, params.id, body);
  const tt: DbTicketType = { id: `tt-${++db.seq}`, eventId: params.id, ...data };
  db.ticketTypes.push(tt);
  return ok(toTicketType(db, tt), 201);
});

route('PUT', '/api/admin/ticket-types/:id', 'admin', ({ db, params, body }) => {
  const tt = db.ticketTypes.find((t) => t.id === params.id);
  if (!tt) fail(404, 'TICKET_TYPE_NOT_FOUND', 'Không tìm thấy hạng vé.');
  const data = validateTicketType(db, tt.eventId, body, tt.id);
  const held = heldQuantity(db, tt.id);
  if (data.totalQuantity < held)
    fail(
      409,
      'QUANTITY_BELOW_BOOKED',
      `Không thể giảm số lượng xuống ${data.totalQuantity} vì đã có ${held} vé được đặt trong các đơn còn hiệu lực.`,
      { totalQuantity: `Tối thiểu ${held} vé.` },
    );
  Object.assign(tt, data);
  return ok(toTicketType(db, tt));
});

route('GET', '/api/admin/orders', 'admin', ({ db, query }) => {
  const eventId = query.get('eventId');
  const status = query.get('status');
  const list = db.orders
    .filter((o) => (!eventId || o.eventId === eventId) && (!status || o.status === status))
    .sort(byNewest)
    .map((o) => toOrder(db, o));
  return ok(list);
});

route('GET', '/api/admin/orders/:id', 'admin', ({ db, params }) => {
  const order = db.orders.find((o) => o.id === params.id);
  if (!order) fail(404, 'ORDER_NOT_FOUND', 'Không tìm thấy đơn đặt vé.');
  return ok(toOrder(db, order));
});

// Thống kê: thực tế backend GCP lấy từ API của Azure. Ở đây tính từ bản ghi đặt/hủy.
route('GET', '/api/admin/stats', 'admin', ({ db, query, now }) => {
  const groupBy = query.get('groupBy') === 'event' ? 'event' : 'day';
  const to = query.get('to') ?? vnDayKey(now);
  const from = query.get('from') ?? addDays(to, -6);
  const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!dayPattern.test(from) || !dayPattern.test(to) || from > to)
    fail(400, 'VALIDATION_ERROR', 'Khoảng ngày thống kê không hợp lệ.');

  const inRange = db.activities.filter((a) => {
    const key = vnDayKey(a.at);
    return key >= from && key <= to;
  });

  type Item = { key: string; label: string; booked: number; cancelled: number };
  const items: Item[] = [];
  const index = new Map<string, Item>();
  if (groupBy === 'day') {
    for (let key = from; key <= to; key = addDays(key, 1)) {
      const item = { key, label: shortDayLabel(key), booked: 0, cancelled: 0 };
      items.push(item);
      index.set(key, item);
    }
  }
  for (const a of inRange) {
    const key = groupBy === 'day' ? vnDayKey(a.at) : a.eventId;
    let item = index.get(key);
    if (!item) {
      const label = db.events.find((e) => e.id === key)?.name ?? key;
      item = { key, label, booked: 0, cancelled: 0 };
      items.push(item);
      index.set(key, item);
    }
    if (a.type === 'BOOKED') item.booked += a.quantity;
    else item.cancelled += a.quantity;
  }
  if (groupBy === 'event') items.sort((a, b) => b.booked - a.booked || a.label.localeCompare(b.label));

  const totals = items.reduce(
    (sum, i) => ({ booked: sum.booked + i.booked, cancelled: sum.cancelled + i.cancelled }),
    { booked: 0, cancelled: 0 },
  );
  return ok({ groupBy, from, to, items, totals, generatedAt: now.toISOString() });
});

// ---------- Bộ định tuyến ----------

function authenticate(db: MockDb, header: string | null, now: Date, required: boolean): DbUser | null {
  const token = header?.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    if (required) fail(401, 'UNAUTHENTICATED', 'Vui lòng đăng nhập.');
    return null;
  }
  const session = db.sessions.find((s) => s.token === token);
  if (!session) {
    if (required) fail(401, 'INVALID_TOKEN', 'Phiên đăng nhập không hợp lệ.');
    return null;
  }
  if (new Date(session.expiresAt) <= now) {
    if (required) fail(401, 'TOKEN_EXPIRED', 'Phiên đăng nhập đã hết hạn.');
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
      return json(400, { error: { code: 'BAD_JSON', message: 'Dữ liệu JSON không hợp lệ.' } });
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
      if (r.access === 'admin' && user?.role !== 'admin') fail(403, 'FORBIDDEN', 'Bạn không có quyền quản trị.');
      const result = r.handler({ db, params, query: searchParams, body, user, now });
      saveDb(db);
      return json(result.status, result.body);
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn API.' } });
  } catch (error) {
    if (error instanceof HttpError) {
      return json(error.status, { error: { code: error.code, message: error.message, details: error.details } });
    }
    console.error('[mock] lỗi xử lý', error);
    return json(500, { error: { code: 'INTERNAL_ERROR', message: 'Máy chủ gặp lỗi.' } });
  }
}
