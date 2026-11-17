// Kiểm thử giao diện quản trị (Nguyễn Quang Huy):
// tạo sự kiện → khai báo hạng vé → khách đặt → quản trị thấy đơn và thống kê.
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { api } from '../api';
import { mockControls } from '../api/mock/server';
import { loginAs, renderApp } from './utils';

describe('quản lý sự kiện và hạng vé', () => {
  it('admin đăng nhập được đưa vào khu vực quản trị', async () => {
    const { user } = renderApp('/login');
    await user.type(screen.getByLabelText('Tài khoản'), 'admin');
    await user.type(screen.getByLabelText('Mật khẩu'), 'admin123');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('heading', { name: 'Quản lý sự kiện' })).toBeInTheDocument();
    expect(await screen.findByText('Đêm nhạc Mùa Thu Hà Nội')).toBeInTheDocument();
  });

  it('tạo sự kiện mới, báo lỗi trường thiếu, rồi thêm hạng vé', async () => {
    await loginAs('admin');
    const { user } = renderApp('/admin/events');
    await user.click(await screen.findByRole('link', { name: /Tạo sự kiện/ }));
    expect(await screen.findByRole('heading', { name: 'Tạo sự kiện' })).toBeInTheDocument();

    const form = screen.getByRole('form', { name: 'Thông tin sự kiện' });
    await user.click(within(form).getByRole('button', { name: 'Tạo sự kiện' }));
    expect(within(form).getByText('Vui lòng nhập tên sự kiện.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng chọn loại hình.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng chọn thời gian diễn ra.')).toBeInTheDocument();
    expect(within(form).getByText('Vui lòng nhập địa điểm.')).toBeInTheDocument();

    await user.type(within(form).getByLabelText(/Tên sự kiện/), 'Hòa nhạc Giáng sinh');
    await user.selectOptions(within(form).getByLabelText(/Loại hình/), 'concert');
    fireEvent.change(within(form).getByLabelText(/Thời gian diễn ra/), { target: { value: '2030-12-24T20:00' } });
    await user.type(within(form).getByLabelText(/Địa điểm/), 'Nhà hát Hòa Bình, TP. Hồ Chí Minh');
    await user.click(within(form).getByRole('button', { name: 'Tạo sự kiện' }));

    expect(await screen.findByRole('heading', { name: 'Chỉnh sửa sự kiện' })).toBeInTheDocument();
    expect(screen.getByText(/Đã tạo sự kiện "Hòa nhạc Giáng sinh"/)).toBeInTheDocument();
    expect(screen.getByText(/Chưa có hạng vé nào/)).toBeInTheDocument();

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
  });

  it('hiện lỗi backend khi giảm số vé xuống dưới số đã đặt', async () => {
    await loginAs('admin');
    const { user } = renderApp('/admin/events/ev-104/edit');
    await user.click(await screen.findByRole('button', { name: 'Sửa hạng vé VIP' }));
    const quantity = screen.getByLabelText('Số lượng bán hạng vé VIP');
    await user.clear(quantity);
    await user.type(quantity, '5');
    await user.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText(/đã có 20 vé được đặt/)).toBeInTheDocument();
    expect(screen.getByText('Tối thiểu 20 vé.')).toBeInTheDocument();
  });

  it('sửa sự kiện với dữ liệu điền sẵn và cập nhật lại danh sách', async () => {
    await loginAs('admin');
    const { user } = renderApp('/admin/events/ev-101/edit');
    const form = await screen.findByRole('form', { name: 'Thông tin sự kiện' });
    const name = within(form).getByLabelText(/Tên sự kiện/);
    expect(name).toHaveValue('Đêm nhạc Mùa Thu Hà Nội');
    await user.clear(name);
    await user.type(name, 'Đêm nhạc Mùa Thu Hà Nội 2026');
    await user.click(within(form).getByRole('button', { name: 'Lưu thay đổi' }));
    expect(await screen.findByRole('heading', { name: 'Quản lý sự kiện' })).toBeInTheDocument();
    expect(screen.getByText(/Đã lưu thay đổi cho sự kiện "Đêm nhạc Mùa Thu Hà Nội 2026"/)).toBeInTheDocument();
    expect(await screen.findByRole('cell', { name: 'Đêm nhạc Mùa Thu Hà Nội 2026' })).toBeInTheDocument();
  });
});

describe('tra cứu đơn và thống kê', () => {
  it('lọc đơn theo sự kiện, trạng thái và mở chi tiết', async () => {
    await loginAs('admin');
    const { user } = renderApp('/admin/orders');
    const table = await screen.findByRole('table', { name: 'Danh sách đơn đặt vé' });
    expect(within(table).getAllByRole('row').length).toBeGreaterThan(2);

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

    const firstLink = within(screen.getByRole('table', { name: 'Danh sách đơn đặt vé' })).getAllByRole('link')[0];
    await user.click(firstLink);
    expect(await screen.findByRole('heading', { name: /^Đơn DH\d+$/ })).toBeInTheDocument();
    expect(screen.getByText('Người đặt')).toBeInTheDocument();
  });

  it('luồng đầy đủ: tạo sự kiện → hạng vé → khách đặt → quản trị thấy đơn và thống kê', async () => {
    await loginAs('admin');
    const ev = await api.admin.createEvent({
      name: 'Đêm nhạc kiểm thử tích hợp',
      category: 'concert',
      description: '',
      startTime: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      venue: 'Hà Nội',
    });
    const tt = await api.admin.createTicketType(ev.id, { name: 'Thường', price: 200_000, totalQuantity: 10 });

    await loginAs('khach');
    const order = await api.createOrder({ ticketTypeId: tt.id, quantity: 3 });

    await loginAs('admin');
    const { user } = renderApp(`/admin/orders?eventId=${ev.id}`);
    expect(await screen.findByText(order.id)).toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: 'Thống kê' }));
    expect(await screen.findByRole('heading', { name: 'Thống kê vé' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Theo sự kiện' }));
    const row = await screen.findByRole('row', { name: /Đêm nhạc kiểm thử tích hợp/ });
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent('3');
  });

  it('dashboard: tổng trên ô thống kê khớp với bảng, báo lỗi khi mất kết nối và tải lại được', async () => {
    await loginAs('admin');
    const { user } = renderApp('/admin/stats');
    const table = await screen.findByRole('table');
    const totalRow = within(table).getByRole('row', { name: /Tổng/ });
    const bookedTotal = within(totalRow).getAllByRole('cell')[0].textContent;
    const tile = screen.getByText('Vé đã đặt', { selector: '.stat__label' }).parentElement!;
    expect(tile).toHaveTextContent(bookedTotal!);
    expect(within(table).getAllByRole('row')).toHaveLength(14 + 2); // 14 ngày + tiêu đề + tổng

    mockControls.setOffline(true);
    await user.click(screen.getByRole('button', { name: /Tải lại số liệu/ }));
    expect(await screen.findByText(/Không cập nhật được số liệu mới/)).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument(); // vẫn giữ số liệu cũ

    mockControls.setOffline(false);
    await user.click(screen.getByRole('button', { name: /Tải lại số liệu/ }));
    await waitFor(() => expect(screen.queryByText(/Không cập nhật được số liệu mới/)).not.toBeInTheDocument());
  });

  it('dashboard báo lỗi khi lần đầu không lấy được số liệu', async () => {
    await loginAs('admin');
    mockControls.setOffline(true);
    renderApp('/admin/stats');
    expect(await screen.findByText('Không lấy được số liệu thống kê')).toBeInTheDocument();
  });
});
