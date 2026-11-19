// Kiểm thử lớp gọi API trên backend giả (cùng hợp đồng với cloud-backend/docs/API.md):
// định dạng lỗi, quyền truy cập và các quy tắc đặt/hủy vé.
import { describe, expect, it } from 'vitest';
import { api, ApiError } from './index';
import { mockControls } from './mock/server';
import { DEMO_PASSWORDS } from './mock/db';
import { clearSession, onUnauthorized, setSession } from '../auth/session';
import { addDays, vnDayKey } from '../lib/dates';
import { loginAs } from '../test/utils';

async function expectApiError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
  return error as ApiError;
}

const ticket = async (eventId: string, ticketTypeId: string) =>
  (await api.getEvent(eventId)).ticketTypes.find((t) => t.id === ticketTypeId)!;

const inDays = (days: number, hours = 0) => new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();

describe('đăng nhập', () => {
  it('trả token và vai trò khi đúng tài khoản', async () => {
    const res = await api.login('alice', DEMO_PASSWORDS.customer);
    expect(res.token).toBeTruthy();
    expect(res.expiresIn).toBe(3600);
    expect(res.user).toEqual({ id: 'alice', username: 'alice', role: 'customer' });
  });

  it('báo INVALID_CREDENTIALS khi sai mật khẩu', async () => {
    await expectApiError(api.login('alice', 'sai'), 401, 'INVALID_CREDENTIALS');
  });

  it('báo VALIDATION_ERROR khi bỏ trống', async () => {
    await expectApiError(api.login('', ''), 400, 'VALIDATION_ERROR');
  });

  it('GET /api/me trả đúng tài khoản và vai trò', async () => {
    await loginAs('admin1');
    expect(await api.me()).toEqual({ id: 'admin1', username: 'admin1', role: 'admin' });
  });

  it('mã xác thực sai → 401 UNAUTHORIZED và phát tín hiệu đăng xuất', async () => {
    setSession({ token: 'khong-hop-le', user: { id: 'x', username: 'x', role: 'customer' } });
    let notified = false;
    const off = onUnauthorized(() => {
      notified = true;
    });
    await expectApiError(api.me(), 401, 'UNAUTHORIZED');
    expect(notified).toBe(true);
    off();
  });

  it('chưa đăng nhập thì không gọi được API cần xác thực', async () => {
    clearSession();
    await expectApiError(api.listMyOrders(), 401, 'UNAUTHORIZED');
  });
});

describe('sự kiện', () => {
  it('trả danh sách theo trang, chỉ gồm sự kiện đang mở bán', async () => {
    const page = await api.listEvents({ limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.pagination).toMatchObject({ page: 1, limit: 2, total: 6, totalPages: 3 });
    const all = await api.listEvents({ limit: 100 });
    expect(all.data.every((e) => e.status === 'PUBLISHED')).toBe(true);
    expect(all.data.some((e) => e.title.includes('Lễ hội'))).toBe(false); // bản nháp
  });

  it('lọc theo loại hình và liệt kê loại hình đang có', async () => {
    const sport = await api.listEvents({ category: 'sport' });
    expect(sport.data.length).toBeGreaterThan(0);
    expect(sport.data.every((e) => e.category === 'sport')).toBe(true);
    const categories = await api.listCategories();
    expect(categories.map((c) => c.category)).toEqual(['concert', 'musical', 'sport', 'theater']);
  });

  it('chi tiết có hạng vé với giá, số còn lại, số đang giữ', async () => {
    const ev = await api.getEvent('ev-101');
    expect(ev.ticketTypes.length).toBe(2);
    for (const t of ev.ticketTypes) {
      expect(t.availableQuantity + t.reservedQuantity).toBe(t.totalQuantity);
      expect(t.soldOut).toBe(t.availableQuantity === 0);
    }
  });

  it('sự kiện không tồn tại hoặc là bản nháp → 404', async () => {
    await expectApiError(api.getEvent('khong-co'), 404, 'EVENT_NOT_FOUND');
    await expectApiError(api.getEvent('ev-107'), 404, 'EVENT_NOT_FOUND');
  });
});

describe('đặt và hủy vé', () => {
  it('đặt vé làm giảm số vé còn lại, hủy thì hoàn lại đúng một lần', async () => {
    await loginAs('alice');
    const before = await ticket('ev-101', 'tt-1012');

    const order = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 2 });
    expect(order).toMatchObject({ status: 'CONFIRMED', quantity: 2, totalAmount: 2 * before.price, canCancel: true });
    expect(order.event.title).toBe('Đêm nhạc Mùa Thu Hà Nội');
    expect((await ticket('ev-101', 'tt-1012')).availableQuantity).toBe(before.availableQuantity - 2);

    const cancelled = await api.cancelOrder(order.id, 'Bận việc');
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Bận việc', cancelledBy: 'alice', canCancel: false });

    await expectApiError(api.cancelOrder(order.id), 409, 'ORDER_ALREADY_CANCELLED');
    expect((await ticket('ev-101', 'tt-1012')).availableQuantity).toBe(before.availableQuantity);
  });

  it('cùng Idempotency-Key thì không tạo đơn trùng', async () => {
    await loginAs('alice');
    const before = await ticket('ev-101', 'tt-1012');
    const first = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1 }, 'khoa-1');
    const again = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1 }, 'khoa-1');
    expect(again.id).toBe(first.id);
    expect((await ticket('ev-101', 'tt-1012')).availableQuantity).toBe(before.availableQuantity - 1);
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 2 }, 'khoa-1'), 422, 'IDEMPOTENCY_KEY_REUSED');
  });

  it('báo hết vé, vượt số còn lại và vượt số vé mỗi đơn', async () => {
    await loginAs('alice');
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1041', quantity: 1 }), 409, 'SOLD_OUT');
    const error = await expectApiError(api.createOrder({ ticketTypeId: 'tt-1052', quantity: 6 }), 409, 'INSUFFICIENT_TICKETS');
    expect(error.detailNumber('available')).toBe(5);
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 11 }), 422, 'QUANTITY_EXCEEDS_LIMIT');
  });

  it('từ chối số lượng không phải số nguyên dương, có lỗi theo từng trường', async () => {
    await loginAs('alice');
    const error = await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 0 }), 400, 'VALIDATION_ERROR');
    expect(error.fieldErrors).toHaveProperty('quantity');
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1.5 }), 400, 'VALIDATION_ERROR');
  });

  it('không hủy được khi còn dưới 24 giờ trước giờ diễn', async () => {
    await loginAs('alice');
    const soon = (await api.listMyOrders({ limit: 100 })).data.find((o) => o.event.id === 'ev-106')!;
    expect(soon.canCancel).toBe(false);
    await expectApiError(api.cancelOrder(soon.id), 422, 'CANCELLATION_WINDOW_CLOSED');
  });

  it('khách không xem hoặc hủy được đơn của người khác', async () => {
    await loginAs('alice');
    const order = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1 });
    await loginAs('bob');
    await expectApiError(api.getOrder(order.id), 404, 'ORDER_NOT_FOUND');
    await expectApiError(api.cancelOrder(order.id), 404, 'ORDER_NOT_FOUND');
    expect((await api.listMyOrders({ limit: 100 })).data.some((o) => o.id === order.id)).toBe(false);
  });

  it('mất kết nối → lỗi NETWORK_ERROR với status 0', async () => {
    await loginAs('alice');
    mockControls.setOffline(true);
    const error = await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1 }), 0, 'NETWORK_ERROR');
    expect(error.isNetworkError).toBe(true);
  });
});

describe('quản trị', () => {
  const newEvent = () => ({
    title: 'Sự kiện thử',
    category: 'concert',
    description: 'Mô tả',
    venue: 'Hà Nội',
    startTime: inDays(3),
    endTime: inDays(3, 2),
    status: 'PUBLISHED' as const,
  });

  it('khách gọi API quản trị → 403', async () => {
    await loginAs('alice');
    await expectApiError(api.admin.listOrders(), 403, 'FORBIDDEN');
    await expectApiError(api.admin.createEvent(newEvent()), 403, 'FORBIDDEN');
  });

  it('thấy cả sự kiện nháp, tạo sự kiện, thêm và sửa hạng vé', async () => {
    await loginAs('admin1');
    expect((await api.admin.listEvents({ status: 'DRAFT' })).data.map((e) => e.id)).toEqual(['ev-107']);
    const ev = await api.admin.createEvent(newEvent());
    const tt = await api.admin.createTicketType(ev.id, { name: 'Thường', price: 100_000, totalQuantity: 50 });
    expect(tt.availableQuantity).toBe(50);
    const updated = await api.admin.updateTicketType(tt.id, { price: 120_000, totalQuantity: 40 });
    expect(updated).toMatchObject({ name: 'Thường', price: 120_000, totalQuantity: 40, availableQuantity: 40 });
    await expectApiError(
      api.admin.createTicketType(ev.id, { name: 'thường', price: 1, totalQuantity: 1 }),
      409,
      'TICKET_TYPE_NAME_TAKEN',
    );
  });

  it('báo lỗi từng trường khi dữ liệu sự kiện không hợp lệ', async () => {
    await loginAs('admin1');
    const error = await expectApiError(
      api.admin.createEvent({ ...newEvent(), title: '', venue: '', startTime: 'abc' }),
      400,
      'VALIDATION_ERROR',
    );
    expect(Object.keys(error.fieldErrors)).toEqual(expect.arrayContaining(['title', 'startTime', 'venue']));
    const end = await expectApiError(
      api.admin.createEvent({ ...newEvent(), endTime: newEvent().startTime }),
      400,
      'VALIDATION_ERROR',
    );
    expect(end.fieldErrors).toHaveProperty('endTime');
  });

  it('không cho giảm số lượng vé xuống dưới số vé đang giữ', async () => {
    await loginAs('admin1');
    const error = await expectApiError(api.admin.updateTicketType('tt-1041', { totalQuantity: 5 }), 409, 'QUANTITY_BELOW_RESERVED');
    expect(error.detailNumber('reserved')).toBe(20);
  });

  it('hủy cả sự kiện thì hủy mọi đơn còn hiệu lực và không mở lại được', async () => {
    await loginAs('admin1');
    const before = await api.admin.listOrders({ eventId: 'ev-103', status: 'CONFIRMED', limit: 100 });
    const res = await api.admin.cancelEvent('ev-103', 'Nghệ sĩ ốm');
    expect(res.status).toBe('CANCELLED');
    expect(res.cancelledOrders).toBe(before.pagination.total);
    expect((await api.admin.listOrders({ eventId: 'ev-103', status: 'CONFIRMED' })).pagination.total).toBe(0);
    await expectApiError(api.admin.updateEvent('ev-103', { status: 'PUBLISHED' }), 409, 'EVENT_CANCELLED');
  });

  it('lọc đơn theo sự kiện và trạng thái, kèm tổng hợp', async () => {
    await loginAs('admin1');
    const res = await api.admin.listOrders({ eventId: 'ev-101', status: 'CANCELLED', limit: 100 });
    expect(res.data.every((o) => o.event.id === 'ev-101' && o.status === 'CANCELLED')).toBe(true);
    expect(res.summary.CANCELLED?.orders).toBe(res.data.length);
    expect(res.summary.CONFIRMED).toBeUndefined();
  });

  it('admin hủy được đơn đã quá hạn hủy của khách', async () => {
    await loginAs('alice');
    const soon = (await api.listMyOrders({ limit: 100 })).data.find((o) => o.event.id === 'ev-106')!;
    await loginAs('admin1');
    const res = await api.admin.cancelOrder(soon.id, 'Hỗ trợ khách');
    expect(res).toMatchObject({ status: 'CANCELLED', cancelledBy: 'admin1' });
  });

  it('thống kê cộng đúng số vé và doanh thu sau khi đặt 2 vé rồi hủy 2 vé', async () => {
    const today = vnDayKey(new Date());
    const query = { from: addDays(today, -6), to: today };
    await loginAs('admin1');
    const before = await api.admin.statsDaily(query);
    expect(before.items).toHaveLength(7);

    await loginAs('alice');
    const order = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 2 });
    await api.cancelOrder(order.id);

    await loginAs('admin1');
    const after = await api.admin.statsDaily(query);
    expect(after.totals.bookedTickets).toBe(before.totals.bookedTickets + 2);
    expect(after.totals.cancelledTickets).toBe(before.totals.cancelledTickets + 2);
    expect(after.totals.netRevenue).toBe(before.totals.netRevenue);
    const byEvent = await api.admin.statsByEvent(query);
    expect(byEvent.items.find((i) => i.key === 'ev-101')?.eventTitle).toBe('Đêm nhạc Mùa Thu Hà Nội');
  });
});
