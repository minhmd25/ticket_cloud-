// Kiểm thử lớp gọi API trên backend giả: định dạng lỗi, quyền truy cập và các quy tắc đặt/hủy vé.
import { describe, expect, it } from 'vitest';
import { api, ApiError } from './index';
import { mockControls } from './mock/server';
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

describe('đăng nhập', () => {
  it('trả token và vai trò khi đúng tài khoản', async () => {
    const res = await api.login('khach', 'khach123');
    expect(res.token).toBeTruthy();
    expect(res.user).toMatchObject({ username: 'khach', role: 'customer' });
    expect(res.user).not.toHaveProperty('password');
  });

  it('báo INVALID_CREDENTIALS khi sai mật khẩu', async () => {
    await expectApiError(api.login('khach', 'sai'), 401, 'INVALID_CREDENTIALS');
  });

  it('báo lỗi từng trường khi bỏ trống', async () => {
    const error = await expectApiError(api.login('', ''), 400, 'VALIDATION_ERROR');
    expect(error.details).toHaveProperty('username');
    expect(error.details).toHaveProperty('password');
  });

  it('mã xác thực sai → 401 và phát tín hiệu đăng xuất', async () => {
    setSession({ token: 'khong-hop-le', user: { id: 'x', username: 'x', role: 'customer' } });
    let notified = false;
    const off = onUnauthorized(() => {
      notified = true;
    });
    await expectApiError(api.me(), 401, 'INVALID_TOKEN');
    expect(notified).toBe(true);
    off();
  });

  it('chưa đăng nhập thì không gọi được API cần xác thực', async () => {
    clearSession();
    await expectApiError(api.listMyOrders(), 401, 'UNAUTHENTICATED');
  });
});

describe('sự kiện', () => {
  it('lọc theo loại hình', async () => {
    await loginAs('khach');
    const sports = await api.listEvents('sports');
    expect(sports.length).toBeGreaterThan(0);
    expect(sports.every((e) => e.category === 'sports')).toBe(true);
  });

  it('chi tiết có hạng vé với giá và số lượng còn lại', async () => {
    await loginAs('khach');
    const ev = await api.getEvent('ev-101');
    expect(ev.ticketTypes.length).toBe(2);
    for (const t of ev.ticketTypes) {
      expect(t.price).toBeGreaterThan(0);
      expect(t.remainingQuantity).toBeLessThanOrEqual(t.totalQuantity);
    }
  });

  it('sự kiện không tồn tại → 404', async () => {
    await expectApiError(api.getEvent('khong-co'), 404, 'EVENT_NOT_FOUND');
  });
});

describe('đặt và hủy vé', () => {
  it('đặt vé làm giảm số vé còn lại, hủy thì hoàn lại đúng một lần', async () => {
    await loginAs('khach');
    const before = (await api.getEvent('ev-101')).ticketTypes.find((t) => t.id === 'tt-1012')!;

    const order = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 2 });
    expect(order).toMatchObject({ status: 'CONFIRMED', quantity: 2, totalAmount: 2 * before.price });
    const afterBook = (await api.getEvent('ev-101')).ticketTypes.find((t) => t.id === 'tt-1012')!;
    expect(afterBook.remainingQuantity).toBe(before.remainingQuantity - 2);

    const cancelled = await api.cancelOrder(order.id);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).toBeTruthy();

    await expectApiError(api.cancelOrder(order.id), 409, 'ALREADY_CANCELLED');
    const afterCancel = (await api.getEvent('ev-101')).ticketTypes.find((t) => t.id === 'tt-1012')!;
    expect(afterCancel.remainingQuantity).toBe(before.remainingQuantity);
  });

  it('báo hết vé và vượt số lượng còn lại', async () => {
    await loginAs('khach');
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1041', quantity: 1 }), 409, 'SOLD_OUT');
    const error = await expectApiError(
      api.createOrder({ ticketTypeId: 'tt-1052', quantity: 6 }),
      409,
      'INSUFFICIENT_TICKETS',
    );
    expect(error.message).toContain('5');
  });

  it('từ chối số lượng không phải số nguyên dương', async () => {
    await loginAs('khach');
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 0 }), 400, 'VALIDATION_ERROR');
    await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1.5 }), 400, 'VALIDATION_ERROR');
  });

  it('khách không xem hoặc hủy được đơn của người khác', async () => {
    await loginAs('khach');
    const order = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1 });
    await loginAs('khach2');
    await expectApiError(api.getOrder(order.id), 404, 'ORDER_NOT_FOUND');
    await expectApiError(api.cancelOrder(order.id), 404, 'ORDER_NOT_FOUND');
    expect((await api.listMyOrders()).some((o) => o.id === order.id)).toBe(false);
  });

  it('mất kết nối → lỗi NETWORK_ERROR với status 0', async () => {
    await loginAs('khach');
    mockControls.setOffline(true);
    const error = await expectApiError(api.createOrder({ ticketTypeId: 'tt-1012', quantity: 1 }), 0, 'NETWORK_ERROR');
    expect(error.isNetworkError).toBe(true);
  });
});

describe('quản trị', () => {
  it('khách gọi API quản trị → 403', async () => {
    await loginAs('khach');
    await expectApiError(api.admin.listOrders(), 403, 'FORBIDDEN');
    await expectApiError(
      api.admin.createEvent({ name: 'x', category: 'concert', description: '', startTime: new Date().toISOString(), venue: 'y' }),
      403,
      'FORBIDDEN',
    );
  });

  it('tạo sự kiện, thêm và sửa hạng vé', async () => {
    await loginAs('admin');
    const ev = await api.admin.createEvent({
      name: 'Sự kiện thử',
      category: 'concert',
      description: 'Mô tả',
      startTime: new Date(Date.now() + 86_400_000).toISOString(),
      venue: 'Hà Nội',
    });
    const tt = await api.admin.createTicketType(ev.id, { name: 'Thường', price: 100_000, totalQuantity: 50 });
    expect(tt.remainingQuantity).toBe(50);
    const updated = await api.admin.updateTicketType(tt.id, { name: 'Thường', price: 120_000, totalQuantity: 40 });
    expect(updated).toMatchObject({ price: 120_000, totalQuantity: 40, remainingQuantity: 40 });
  });

  it('báo lỗi từng trường khi dữ liệu sự kiện không hợp lệ', async () => {
    await loginAs('admin');
    const error = await expectApiError(
      api.admin.createEvent({ name: '', category: 'concert', description: '', startTime: 'abc', venue: '' }),
      400,
      'VALIDATION_ERROR',
    );
    expect(Object.keys(error.details ?? {})).toEqual(expect.arrayContaining(['name', 'startTime', 'venue']));
  });

  it('không cho giảm số lượng vé xuống dưới số vé đã đặt', async () => {
    await loginAs('admin');
    const tt = (await api.getEvent('ev-104')).ticketTypes.find((t) => t.id === 'tt-1041')!;
    const error = await expectApiError(
      api.admin.updateTicketType(tt.id, { name: tt.name, price: tt.price, totalQuantity: 5 }),
      409,
      'QUANTITY_BELOW_BOOKED',
    );
    expect(error.message).toContain('20');
  });

  it('lọc đơn theo sự kiện và trạng thái', async () => {
    await loginAs('admin');
    const orders = await api.admin.listOrders({ eventId: 'ev-101', status: 'CANCELLED' });
    expect(orders.every((o) => o.eventId === 'ev-101' && o.status === 'CANCELLED')).toBe(true);
  });

  it('thống kê cộng đúng số vé đặt và hủy mới', async () => {
    const today = vnDayKey(new Date());
    const query = { groupBy: 'day' as const, from: addDays(today, -6), to: today };
    await loginAs('admin');
    const before = await api.admin.getStats(query);
    expect(before.items).toHaveLength(7);

    await loginAs('khach');
    const order = await api.createOrder({ ticketTypeId: 'tt-1012', quantity: 2 });
    await api.cancelOrder(order.id);

    await loginAs('admin');
    const after = await api.admin.getStats(query);
    expect(after.totals.booked).toBe(before.totals.booked + 2);
    expect(after.totals.cancelled).toBe(before.totals.cancelled + 2);
  });
});
