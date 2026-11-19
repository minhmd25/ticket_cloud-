// Kiểm thử giao diện quản trị (Nguyễn Quang Huy):
// tạo sự kiện → khai báo hạng vé → khách đặt → quản trị thấy đơn và thống kê.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { api } from '../api';
import { mockControls } from '../api/mock/server';
import { DEMO_PASSWORDS, loadDb } from '../api/mock/db';
import { shortId } from '../lib/format';
import { loginAs, renderApp } from './utils';

describe('quản lý sự kiện và hạng vé', () => {
  it('admin đăng nhập được đưa vào khu vực quản trị, thấy cả sự kiện nháp', async () => {
    const { user } = renderApp('/login');
    await user.type(screen.getByLabelText('Tài khoản'), 'admin1');
    await user.type(screen.getByLabelText('Mật khẩu'), DEMO_PASSWORDS.admin);
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('heading', { name: 'Quản lý sự kiện' })).toBeInTheDocument();
    expect(await screen.findByText('Đêm nhạc Mùa Thu Hà Nội')).toBeInTheDocument();
    const draftRow = screen.getByRole('row', { name: /Lễ hội Ẩm thực/ });
    expect(within(draftRow).getByText('Nháp')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Trạng thái'), 'DRAFT');
    await waitFor(() => expect(screen.queryByText('Đêm nhạc Mùa Thu Hà Nội')).not.toBeInTheDocument());
  });

  it('tạo sự kiện mới, báo lỗi trường thiếu, rồi thêm hạng vé', async () => {
    await loginAs('admin1');
    const { user } = renderApp('/admin/events');
    await user.click(await screen.findByRole('link', { name: /Tạo sự kiện/ }));
    expect(await screen.findByRole('heading', { name: 'Tạo sự kiện' })).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Thông tin sự kiện' });
    await user.click(within(form).getByRole('button', { name: 'Tạo sự kiện' }));
    expect(within(form).getByText('Vui lòng nhập tên sự kiện.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng chọn loại hình.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng chọn thời gian bắt đầu.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng chọn thời gian kết thúc.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng nhập địa điểm.')).toBeInTheDocument();

    await user.type(within(form).getByLabelText(/Tên sự kiện/), 'Hòa nhạc Giáng sinh');
    await user.selectOptions(within(form).getByLabelText(/Loại hình/), 'concert');
    fireEvent.change(within(form).getByLabelText(/Bắt đầu/), { target: { value: '2030-12-24T20:00' } });
    fireEvent.change(within(form).getByLabelText(/Kết thúc/), { target: { value: '2030-12-24T19:00' } });
    await user.type(within(form).getByLabelText(/Địa điểm/), 'Nhà hát Hòa Bình, TP. Hồ Chí Minh');
    await user.click(within(form).getByRole('button', { name: 'Tạo sự kiện' }));
    expect(within(form).getByText('Giờ kết thúc phải sau giờ bắt đầu.')).toBeInTheDocument();

    fireEvent.change(within(form).getByLabelText(/Kết thúc/), { target: { value: '2030-12-24T22:00' } });
    await user.click(within(form).getByRole('button', { name: 'Tạo sự kiện' }));

    expect(await screen.findByRole('heading', { name: 'Chỉnh sửa sự kiện' })).toBeInTheDocument();
    expect(screen.getByText(/Đã tạo sự kiện "Hòa nhạc Giáng sinh"/)).toBeInTheDocument();
    expect(screen.getByText(/Chưa có hạng vé nào/)).toBeInTheDocument();
    const created = loadDb().events.find((e) => e.title === 'Hòa nhạc Giáng sinh')!;
    expect(created).toMatchObject({ status: 'PUBLISHED', category: 'concert', startTime: '2030-12-24T13:00:00.000Z' });

    const addForm = screen.getByRole('form', { name: 'Thêm hạng vé' });
    await user.type(within(addForm).getByLabelText('Tên hạng vé'), 'Hạng A');
    await user.type(within(addForm).getByLabelText('Giá (VND)'), 'abc');
    await user.type(within(addForm).getByLabelText('Số lượng bán'), '100');
    await user.click(within(addForm).getByRole('button', { name: 'Thêm hạng vé' }));
    expect(within(addForm).getByText('Giá phải là số nguyên không âm (VND).')).toBeInTheDocument();

    await user.clear(within(addForm).getByLabelText('Giá (VND)'));
    await user.type(within(addForm).getByLabelText('Giá (VND)'), '300000');
    await user.click(within(addForm).getByRole('button', { name: 'Thêm hạng vé' }));
    expect(await screen.findByText('Đã thêm hạng vé "Hạng A".')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Các hạng vé của sự kiện' });
    expect(await within(table).findByText('Hạng A')).toBeInTheDocument();
    expect(within(table).getByText(/300\.000/)).toBeInTheDocument();

    // Trùng tên hạng vé: lỗi backend hiện dưới ô tên
    await user.type(within(addForm).getByLabelText('Tên hạng vé'), 'hạng a');
    await user.type(within(addForm).getByLabelText('Giá (VND)'), '1');
    await user.type(within(addForm).getByLabelText('Số lượng bán'), '1');
    await user.click(within(addForm).getByRole('button', { name: 'Thêm hạng vé' }));
    expect(await within(addForm).findByText('Sự kiện đã có hạng vé cùng tên.')).toBeInTheDocument();
  });

  it('hiện lỗi backend khi giảm số vé xuống dưới số đã đặt', async () => {
    await loginAs('admin1');
    const { user } = renderApp('/admin/events/ev-104/edit');
    await user.click(await screen.findByRole('button', { name: 'Sửa hạng vé VIP' }));
    const quantity = screen.getByLabelText('Số lượng bán hạng vé VIP');
    await user.clear(quantity);
    await user.type(quantity, '5');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText(/đang có 20 vé được giữ/)).toBeInTheDocument();
    expect(screen.getByText('Tối thiểu 20 vé.')).toBeInTheDocument();
  });

  it('sửa sự kiện với dữ liệu điền sẵn, chỉ gửi trường đã đổi', async () => {
    await loginAs('admin1');
    const { user } = renderApp('/admin/events/ev-101/edit');
    const form = await screen.findByRole('form', { name: 'Thông tin sự kiện' });
    const title = within(form).getByLabelText(/Tên sự kiện/);
    expect(title).toHaveValue('Đêm nhạc Mùa Thu Hà Nội');

    await user.click(within(form).getByRole('button', { name: 'Lưu thay đổi' }));
    expect(within(form).getByText('Bạn chưa thay đổi thông tin nào.')).toBeInTheDocument();

    await user.clear(title);
    await user.type(title, 'Đêm nhạc Mùa Thu Hà Nội 2026');
    await user.click(within(form).getByRole('button', { name: 'Lưu thay đổi' }));
    expect(await screen.findByRole('heading', { name: 'Quản lý sự kiện' })).toBeInTheDocument();
    expect(screen.getByText(/Đã lưu thay đổi cho sự kiện "Đêm nhạc Mùa Thu Hà Nội 2026"/)).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Đêm nhạc Mùa Thu Hà Nội 2026' })).toBeInTheDocument();
  });

  it('hủy cả sự kiện: các đơn còn hiệu lực bị hủy, form bị khóa', async () => {
    await loginAs('admin1');
    const confirmed = loadDb().orders.filter((o) => o.eventId === 'ev-102' && o.status === 'CONFIRMED').length;
    const { user } = renderApp('/admin/events/ev-102/edit');
    await user.click(await screen.findByRole('button', { name: 'Hủy sự kiện này' }));
    await user.type(screen.getByLabelText('Lý do (ghi vào các đơn bị hủy)'), 'Sân ngập nước');
    await user.click(screen.getByRole('button', { name: 'Xác nhận hủy sự kiện' }));
    expect(await screen.findByText(`Đã hủy sự kiện. ${confirmed} đơn còn hiệu lực đã được hủy và hoàn vé.`)).toBeInTheDocument();
    expect(screen.getByText(/Sự kiện đã bị hủy nên không thể sửa/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Thêm hạng vé' })).not.toBeInTheDocument();
    expect(loadDb().orders.filter((o) => o.eventId === 'ev-102' && o.status === 'CONFIRMED')).toHaveLength(0);
  });
});

describe('tra cứu đơn và thống kê', () => {
  it('lọc đơn theo sự kiện, trạng thái và mở chi tiết', async () => {
    await loginAs('admin1');
    const { user } = renderApp('/admin/orders');
    const table = await screen.findByRole('table', { name: 'Danh sách đơn đặt vé' });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(2);
    expect(await screen.findByRole('option', { name: 'Live concert Mùa Hè Rực Rỡ' })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Sự kiện'), 'ev-104');
    await user.selectOptions(screen.getByLabelText('Trạng thái'), 'CONFIRMED');
    await waitFor(() => {
      const rows = within(screen.getByRole('table', { name: 'Danh sách đơn đặt vé' })).getAllByRole('row').slice(1);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toHaveTextContent('Live concert Mùa Hè Rực Rỡ');
        expect(row).toHaveTextContent('Đã xác nhận');
      }
    });
    expect(screen.getByText(/Đã xác nhận: \d+ đơn/)).toBeInTheDocument();

    const firstLink = within(screen.getByRole('table', { name: 'Danh sách đơn đặt vé' })).getAllByRole('link')[0];
    await user.click(firstLink);
    expect(await screen.findByRole('heading', { name: /^Đơn [0-9A-F]{8}$/ })).toBeInTheDocument();
    expect(screen.getByText('Người đặt')).toBeInTheDocument();
  });

  it('admin hủy đơn của khách kèm lý do', async () => {
    await loginAs('admin1');
    const order = loadDb().orders.find((o) => o.userId === 'alice' && o.eventId === 'ev-106')!;
    const { user } = renderApp(`/admin/orders/${order.id}`);
    await user.click(await screen.findByRole('button', { name: 'Hủy đơn này' }));
    await user.type(screen.getByLabelText('Lý do (khách sẽ thấy)'), 'Khách gọi điện xin hủy');
    await user.click(screen.getByRole('button', { name: 'Xác nhận hủy' }));
    expect(await screen.findByText('Đã hủy đơn và hoàn vé cho sự kiện.')).toBeInTheDocument();
    expect(screen.getByText('Khách gọi điện xin hủy')).toBeInTheDocument();
    expect(screen.getByText(/Hủy bởi quản trị viên \(admin1\)/)).toBeInTheDocument();
  });

  it('luồng đầy đủ: tạo sự kiện → hạng vé → khách đặt → quản trị thấy đơn và thống kê', async () => {
    await loginAs('admin1');
    const ev = await api.admin.createEvent({
      title: 'Đêm nhạc kiểm thử tích hợp',
      category: 'concert',
      description: '',
      venue: 'Hà Nội',
      startTime: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      endTime: new Date(Date.now() + 3 * 86_400_000 + 7_200_000).toISOString(),
      status: 'PUBLISHED',
    });
    const tt = await api.admin.createTicketType(ev.id, { name: 'Thường', price: 200_000, totalQuantity: 10 });

    await loginAs('alice');
    const order = await api.createOrder({ ticketTypeId: tt.id, quantity: 3 });

    await loginAs('admin1');
    const { user } = renderApp(`/admin/orders?eventId=${ev.id}`);
    expect(await screen.findByText(shortId(order.id))).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Thống kê' }));
    expect(await screen.findByRole('heading', { name: 'Thống kê vé' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Theo sự kiện' }));
    const row = await screen.findByRole('row', { name: /Đêm nhạc kiểm thử tích hợp/ });
    const cells = within(row).getAllByRole('cell');
    expect(cells[0]).toHaveTextContent('3');
    expect(cells[3]).toHaveTextContent('600.000');
  });

  it('dashboard: tổng trên ô số liệu khớp với bảng, báo lỗi khi mất kết nối và tải lại được', async () => {
    await loginAs('admin1');
    const { user } = renderApp('/admin/stats');
    const table = await screen.findByRole('table');
    const totalRow = within(table).getByRole('row', { name: /Tổng/ });
    const bookedTotal = within(totalRow).getAllByRole('cell')[0].textContent;
    const tile = screen.getByText('Vé đã đặt', { selector: '.stat__label' }).parentElement!;
    expect(tile).toHaveTextContent(bookedTotal!);
    expect(within(table).getAllByRole('row')).toHaveLength(14 + 2); // 14 ngày + tiêu đề + tổng
    expect(screen.getByText(/Doanh thu thực/, { selector: '.stat__label' })).toBeInTheDocument();

    mockControls.setOffline(true);
    await user.click(screen.getByRole('button', { name: /Tải lại số liệu/ }));
    expect(await screen.findByText(/Không cập nhật được số liệu mới/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument(); // vẫn giữ số liệu cũ

    mockControls.setOffline(false);
    await user.click(screen.getByRole('button', { name: /Tải lại số liệu/ }));
    await waitFor(() => expect(screen.queryByText(/Không cập nhật được số liệu mới/)).not.toBeInTheDocument());
  });

  it('dashboard báo lỗi khi lần đầu không lấy được số liệu', async () => {
    await loginAs('admin1');
    mockControls.setOffline(true);
    renderApp('/admin/stats');
    expect(await screen.findByText('Không lấy được số liệu thống kê')).toBeInTheDocument();
  });
});
