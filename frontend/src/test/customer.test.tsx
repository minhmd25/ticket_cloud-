// Kiểm thử giao diện khách hàng (Ma Đức Minh): đăng nhập → xem sự kiện → đặt vé → xem đơn → hủy.
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { config } from '../config';
import { mockControls } from '../api/mock/server';
import { DEMO_PASSWORDS, loadDb, saveDb } from '../api/mock/db';
import { setSession } from '../auth/session';
import { loginAs, renderApp } from './utils';

describe('đăng nhập', () => {
  it('báo lỗi khi bỏ trống và khi sai mật khẩu', async () => {
    const { user } = renderApp('/login');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(screen.getByText('Vui lòng nhập tài khoản.')).toBeInTheDocument();
    expect(screen.getByText('Vui lòng nhập mật khẩu.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Tài khoản'), 'alice');
    await user.type(screen.getByLabelText('Mật khẩu'), 'sai-mat-khau');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByText(/Sai tài khoản hoặc mật khẩu/)).toBeInTheDocument();
  });

  it('chưa đăng nhập thì bị chuyển về trang đăng nhập, đăng nhập xong quay lại trang cũ', async () => {
    const { user } = renderApp('/my-tickets');
    expect(await screen.findByRole('heading', { name: 'Đăng nhập' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Tài khoản'), 'alice');
    await user.type(screen.getByLabelText('Mật khẩu'), DEMO_PASSWORDS.customer);
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('heading', { name: 'Vé của tôi' })).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
  });

  it('phiên hết hạn thì đăng xuất và báo cho người dùng', async () => {
    setSession({ token: 'het-han', user: { id: 'alice', username: 'alice', role: 'customer' } });
    renderApp('/events');
    expect(await screen.findByText(/Phiên đăng nhập đã hết hạn/)).toBeInTheDocument();
  });

  it('khách hàng vào khu vực quản trị thì thấy thông báo không có quyền', async () => {
    await loginAs('alice');
    renderApp('/admin/events');
    expect(await screen.findByRole('heading', { name: 'Không có quyền truy cập' })).toBeInTheDocument();
  });
});

describe('luồng đặt vé', () => {
  it('đăng nhập, lọc sự kiện, đặt vé, xem đơn và hủy đơn', async () => {
    const { user } = renderApp('/login');
    await user.type(screen.getByLabelText('Tài khoản'), 'alice');
    await user.type(screen.getByLabelText('Mật khẩu'), DEMO_PASSWORDS.customer);
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    // Danh sách sự kiện + bộ lọc lấy từ backend
    expect(await screen.findByRole('heading', { name: 'Sự kiện', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Đêm nhạc Mùa Thu Hà Nội' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Thể thao' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Đêm nhạc Mùa Thu Hà Nội' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Thể thao' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Nhạc kịch' })).toBeInTheDocument();

    // Chi tiết sự kiện
    await user.click(screen.getByRole('link', { name: 'Giải chạy Marathon Hồ Tây' }));
    expect(await screen.findByRole('heading', { name: 'Giải chạy Marathon Hồ Tây', level: 1 })).toBeInTheDocument();

    // Form đặt vé: kiểm tra số lượng và thành tiền
    const form = screen.getByRole('form', { name: 'Đặt vé' });
    await user.click(within(form).getByRole('radio', { name: /Cự ly 42 km/ }));
    const quantity = within(form).getByLabelText('Số lượng');
    await user.clear(quantity);
    await user.type(quantity, '6');
    expect(within(form).getByText('Hạng vé này chỉ còn 5 vé.')).toBeInTheDocument();
    await user.clear(quantity);
    await user.type(quantity, '2');
    expect(within(form).getByText(/1\.600\.000/)).toBeInTheDocument();

    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    const success = await within(form).findByText(/Đặt vé thành công/);
    const code = success.closest('.alert')!.querySelector('.code')!.textContent!;
    expect(code).toMatch(/^[0-9A-F]{8}$/);
    // Số vé còn lại cập nhật sau khi đặt
    expect(await within(form).findByText('Còn 3 vé')).toBeInTheDocument();

    // Vé của tôi
    await user.click(within(form).getByRole('link', { name: 'Vé của tôi' }));
    expect(await screen.findByRole('heading', { name: 'Vé của tôi' })).toBeInTheDocument();
    await user.click(await screen.findByRole('link', { name: `Xem chi tiết đơn ${code}` }));

    // Chi tiết đơn và hủy
    expect(await screen.findByRole('heading', { name: `Đơn ${code}` })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yêu cầu hủy đơn' }));
    await user.type(screen.getByLabelText('Lý do hủy (không bắt buộc)'), 'Đổi lịch');
    await user.click(screen.getByRole('button', { name: 'Xác nhận hủy' }));
    expect(await screen.findByText(/Đã hủy đơn thành công/)).toBeInTheDocument();
    expect(screen.getAllByText('Đã hủy').length).toBeGreaterThan(0);
    expect(screen.getByText('Đổi lịch')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yêu cầu hủy đơn' })).not.toBeInTheDocument();
  });

  it('khóa nút trong lúc chờ API', async () => {
    await loginAs('alice');
    const { user } = renderApp('/events/ev-101');
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    config.mockLatencyMs = 80;
    try {
      await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
      expect(within(form).getByRole('button', { name: 'Đang đặt vé…' })).toBeDisabled();
      expect(await within(form).findByText(/Đặt vé thành công/)).toBeInTheDocument();
      // Chờ lượt tải lại số vé sau khi đặt xong, để không còn request chạy dở sang test sau.
      await waitFor(() => expect(screen.queryByText('Đang cập nhật số vé…')).not.toBeInTheDocument());
    } finally {
      config.mockLatencyMs = 0;
    }
  });

  it('báo rõ khi hạng vé đã hết', async () => {
    await loginAs('alice');
    renderApp('/events/ev-104');
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    expect(within(form).getByRole('radio', { name: /VIP/ })).toBeDisabled();
    expect(within(form).getByText('Hết vé')).toBeInTheDocument();
  });

  it('hiện nguyên văn lỗi backend khi vượt số vé mỗi đơn', async () => {
    await loginAs('alice');
    const { user } = renderApp('/events/ev-101');
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    await user.clear(within(form).getByLabelText('Số lượng'));
    await user.type(within(form).getByLabelText('Số lượng'), '11');
    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    expect(await within(form).findByText('Mỗi đơn được đặt tối đa 10 vé')).toBeInTheDocument();
  });

  it('mất kết nối rồi bấm lại thì không tạo đơn trùng', async () => {
    await loginAs('alice');
    const { user } = renderApp('/events/ev-101');
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    const ordersBefore = loadDb().orders.length;

    // Lần 1: yêu cầu tới máy chủ, đơn được tạo, nhưng phản hồi bị mất trên đường về.
    mockControls.dropNextResponse = 'POST /api/orders';
    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    expect(await within(form).findByText(/Mất kết nối tới máy chủ/)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Đặt vé' })).toBeEnabled();
    expect(loadDb().orders.length).toBe(ordersBefore + 1);

    // Lần 2: thử lại cùng hạng vé và số lượng → thành công, vẫn chỉ có thêm đúng một đơn.
    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    expect(await within(form).findByText(/Đặt vé thành công/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Đóng thông báo' }));
    expect(loadDb().orders.length).toBe(ordersBefore + 1);
  });

  it('đơn sắp diễn ra thì báo đã quá hạn hủy', async () => {
    await loginAs('alice');
    const order = loadDb().orders.find((o) => o.userId === 'alice' && o.eventId === 'ev-106')!;
    renderApp(`/my-tickets/${order.id}`);
    expect(await screen.findByText(/Đã quá hạn hủy đơn/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yêu cầu hủy đơn' })).not.toBeInTheDocument();
  });
});

describe('trạng thái tải, rỗng và lỗi', () => {
  it('hiện lỗi khi không tải được sự kiện và tải lại được khi bấm Thử lại', async () => {
    await loginAs('alice');
    mockControls.setOffline(true);
    const { user } = renderApp('/events');
    expect(await screen.findByText('Không tải được danh sách sự kiện')).toBeInTheDocument();
    mockControls.setOffline(false);
    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('link', { name: 'Đêm nhạc Mùa Thu Hà Nội' })).toBeInTheDocument();
  });

  it('hiện trạng thái rỗng khi chưa có đơn nào', async () => {
    const db = loadDb();
    saveDb({ ...db, orders: db.orders.filter((o) => o.userId !== 'alice') });
    await loginAs('alice');
    renderApp('/my-tickets');
    expect(await screen.findByText('Bạn chưa đặt vé nào')).toBeInTheDocument();
  });

  it('báo không tìm thấy khi mở đơn của người khác', async () => {
    const other = loadDb().orders.find((o) => o.userId !== 'alice')!;
    await loginAs('alice');
    renderApp(`/my-tickets/${other.id}`);
    expect(await screen.findByText('Không tìm thấy đơn đặt vé')).toBeInTheDocument();
  });

  it('chuyển trang trong Vé của tôi', async () => {
    await loginAs('alice');
    const total = loadDb().orders.filter((o) => o.userId === 'alice').length;
    const { user } = renderApp('/my-tickets');
    expect(await screen.findByText(`Trang 1/${Math.ceil(total / 20)} · ${total} mục`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trang sau →' }));
    expect(await screen.findByText(`Trang 2/${Math.ceil(total / 20)} · ${total} mục`)).toBeInTheDocument();
  });
});

describe('chọn ghế và hàng chờ', () => {
  const seatButton = (label: string) => screen.getByRole('button', { name: new RegExp(`^Ghế ${label} ·`) });

  it('chọn ghế trên sơ đồ rồi đặt vé', async () => {
    await loginAs('alice');
    const { user } = renderApp('/events/ev-109');
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    expect(await within(form).findByRole('group', { name: /Sơ đồ ghế/ })).toBeInTheDocument();
    // Ghế đã bán không bấm được.
    expect(within(form).getByRole('img', { name: /^Ghế A7 · .*đã có người đặt/ })).toBeInTheDocument();

    await user.click(seatButton('A1'));
    await user.click(seatButton('A2'));
    expect(seatButton('A1')).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).getByText('Ghế đã chọn (2/10)')).toBeInTheDocument();
    expect(within(form).getByText(/2\.400\.000/)).toBeInTheDocument();

    // Chọn ghế hạng khác thì chuyển hạng và chỉ giữ ghế vừa bấm.
    await user.click(seatButton('E1'));
    expect(within(form).getByRole('radio', { name: /Hạng hai/ })).toBeChecked();
    expect(within(form).getByText(/Đã chuyển sang Hạng hai/)).toBeInTheDocument();
    await user.click(seatButton('E2'));

    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    expect(await within(form).findByText(/Đặt vé thành công/)).toBeInTheDocument();
    expect(within(form).getByText(/ghế E1, E2/)).toBeInTheDocument();
    await waitFor(() => expect(within(form).getByRole('img', { name: /^Ghế E1 · .*đã có người đặt/ })).toBeInTheDocument());
  });

  it('ghế vừa có người khác đặt thì báo lỗi và bỏ ghế đó khỏi lựa chọn', async () => {
    await loginAs('alice');
    const { user } = renderApp('/events/ev-109');
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    await within(form).findByRole('group', { name: /Sơ đồ ghế/ });
    await user.click(seatButton('B1'));
    await user.click(seatButton('B2'));

    // Trong lúc alice đang chọn, bob đặt mất ghế B2.
    const db = loadDb();
    const b2 = db.seatMaps.find((m) => m.eventId === 'ev-109')!.seats.find((x) => x.label === 'B2')!;
    db.orders.push({ ...db.orders.find((o) => o.eventId === 'ev-109')!, id: 'don-cua-bob', userId: 'bob', seatIds: [b2.id], quantity: 1, status: 'CONFIRMED' });
    saveDb(db);

    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    expect(await within(form).findByText(/Ghế B2 vừa có người đặt/)).toBeInTheDocument();
    expect(within(form).getByText('Ghế đã chọn (1/10)')).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Bỏ chọn ghế B2' })).not.toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Bỏ chọn ghế B1' })).toBeInTheDocument();
  });

  it('sự kiện có hàng chờ: vào hàng, chờ tới giờ mở bán', async () => {
    await loginAs('alice');
    const { user } = renderApp('/events/ev-108');
    expect(await screen.findByText('Sự kiện mở bán qua hàng chờ')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Đặt vé' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Vào hàng chờ' }));
    expect(await screen.findByText('Mở bán sau')).toBeInTheDocument();
    expect(screen.getByText(/Thứ tự sẽ được xếp ngẫu nhiên/)).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument(); // 6 người giả + alice đang chờ
    await user.click(screen.getByRole('button', { name: 'Rời hàng' }));
    expect(await screen.findByText('Bạn đã rời hàng chờ.')).toBeInTheDocument();
  });

  it('sự kiện có hàng chờ: tới lượt thì hiện form đặt vé kèm thời gian còn lại', async () => {
    const db = loadDb();
    const settings = db.queueSettings.find((x) => x.eventId === 'ev-108')!;
    settings.saleStartAt = new Date(Date.now() - 60_000).toISOString();
    db.queueEntries = [];
    saveDb(db);
    await loginAs('alice');
    const { user } = renderApp('/events/ev-108');
    await user.click(await screen.findByRole('button', { name: 'Vào hàng chờ' }));
    expect(await screen.findByText('Đã tới lượt bạn!')).toBeInTheDocument();
    const form = await screen.findByRole('form', { name: 'Đặt vé' });
    await within(form).findByRole('group', { name: /Sơ đồ ghế/ });
    await user.click(seatButton('A5'));
    await user.click(within(form).getByRole('button', { name: 'Đặt vé' }));
    // Đặt xong một đơn thì lượt kết thúc; trang chờ báo kết quả và cho vào hàng lại.
    expect(await screen.findByText(/Lượt mua của bạn đã kết thúc/)).toBeInTheDocument();
    expect(screen.getByText(/ghế A5/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Vào hàng lại' })).toBeInTheDocument();
  });
});
