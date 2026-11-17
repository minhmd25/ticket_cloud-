// Chạy toàn bộ luồng trên Chrome và chụp ảnh màn hình vào docs/screenshots (dùng cho báo cáo).
import { expect, test, type Page } from '@playwright/test';

async function shot(page: Page, name: string, fullPage = true) {
  // Cuộn về đầu trang để thanh tiêu đề cố định không bị in lơ lửng khi chụp toàn trang.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage });
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Tài khoản').fill(username);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

test.beforeEach(async ({ page }) => {
  // Bắt đầu từ dữ liệu mẫu sạch.
  await page.goto('/login');
  await page.evaluate(() => localStorage.clear());
});

test('khách hàng: đăng nhập → lọc → đặt vé → vé của tôi → hủy', async ({ page }) => {
  await page.goto('/login');
  await shot(page, '01-dang-nhap');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByText('Vui lòng nhập tài khoản.')).toBeVisible();
  await shot(page, '02-dang-nhap-loi');

  await login(page, 'khach', 'khach123');
  await expect(page.getByRole('heading', { name: 'Sự kiện', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Đêm nhạc Mùa Thu Hà Nội' })).toBeVisible();
  await shot(page, '03-danh-sach-su-kien');

  await page.getByRole('button', { name: 'Nhạc kịch' }).click();
  await expect(page.getByRole('link', { name: 'Đêm nhạc Mùa Thu Hà Nội' })).toBeHidden();
  await shot(page, '04-loc-nhac-kich');

  await page.getByRole('button', { name: 'Tất cả' }).click();
  await page.getByRole('link', { name: 'Giải chạy Marathon Hồ Tây' }).click();
  const form = page.getByRole('form', { name: 'Đặt vé' });
  await form.getByText('Cự ly 42 km').click();
  await form.getByLabel('Số lượng').fill('7');
  await expect(form.getByText('Hạng vé này chỉ còn 5 vé.')).toBeVisible();
  await shot(page, '05-dat-ve-loi-so-luong');
  await form.getByLabel('Số lượng').fill('2');
  await form.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(form.getByRole('button', { name: 'Đang đặt vé…' })).toBeDisabled();
  await expect(form.getByText(/Đặt vé thành công/)).toBeVisible();
  const code = (await form.locator('.alert .code').textContent())!;
  await expect(form.getByText('Còn 3 vé')).toBeVisible();
  await expect(page.getByText('Đang cập nhật số vé…')).toBeHidden();
  await shot(page, '06-dat-ve-thanh-cong');

  await page.getByRole('link', { name: 'Vé của tôi' }).first().click();
  await expect(page.getByRole('cell', { name: code, exact: true })).toBeVisible();
  await shot(page, '07-ve-cua-toi');

  await page.getByRole('link', { name: `Xem chi tiết đơn ${code}` }).click();
  await page.getByRole('button', { name: 'Yêu cầu hủy đơn' }).click();
  await shot(page, '08-xac-nhan-huy');
  await page.getByRole('button', { name: 'Xác nhận hủy' }).click();
  await expect(page.getByText(/Đã hủy đơn thành công/)).toBeVisible();
  await shot(page, '09-huy-thanh-cong');

  // Mất kết nối khi đặt vé
  await page.goto('/events/ev-101');
  await page.getByLabel('Giả lập mất kết nối').check();
  await page.getByRole('form', { name: 'Đặt vé' }).getByRole('button', { name: 'Đặt vé' }).click();
  await expect(page.getByText(/Mất kết nối tới máy chủ/)).toBeVisible();
  await shot(page, '10-mat-ket-noi');
  await page.getByLabel('Giả lập mất kết nối').uncheck();

  // Khách vào khu vực quản trị
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Không có quyền truy cập' })).toBeVisible();
  await shot(page, '11-khong-co-quyen');
});

test('khách hàng trên điện thoại', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    isMobile: true,
  });
  const page = await context.newPage();
  await login(page, 'khach', 'khach123');
  await expect(page.getByRole('link', { name: 'Đêm nhạc Mùa Thu Hà Nội' })).toBeVisible();
  await shot(page, '12-dien-thoai-su-kien', false);
  await page.goto('/events/ev-103');
  await expect(page.getByRole('form', { name: 'Đặt vé' })).toBeVisible();
  await shot(page, '13-dien-thoai-chi-tiet');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await context.close();
});

test('quản trị: sự kiện → hạng vé → đơn → thống kê', async ({ page }) => {
  await login(page, 'admin', 'admin123');
  await expect(page.getByRole('heading', { name: 'Quản lý sự kiện' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Đêm nhạc Mùa Thu Hà Nội', exact: true })).toBeVisible();
  await shot(page, '20-quan-tri-su-kien');

  await page.getByRole('link', { name: 'Tạo sự kiện' }).click();
  const form = page.getByRole('form', { name: 'Thông tin sự kiện' });
  await form.getByRole('button', { name: 'Tạo sự kiện' }).click();
  await shot(page, '21-tao-su-kien-loi');
  await form.getByLabel(/Tên sự kiện/).fill('Hòa nhạc Giáng sinh 2026');
  await form.getByLabel(/Loại hình/).selectOption('concert');
  await form.getByLabel(/Thời gian diễn ra/).fill('2026-12-24T20:00');
  await form.getByLabel(/Địa điểm/).fill('Nhà hát Hòa Bình, TP. Hồ Chí Minh');
  await form.getByLabel('Mô tả').fill('Chương trình hòa nhạc đêm Giáng sinh với dàn hợp xướng 60 người.');
  await form.getByRole('button', { name: 'Tạo sự kiện' }).click();
  await expect(page.getByText(/Đã tạo sự kiện/)).toBeVisible();

  const add = page.getByRole('form', { name: 'Thêm hạng vé' });
  for (const [name, price, qty] of [
    ['VIP', '1500000', '50'],
    ['Thường', '500000', '300'],
  ]) {
    await add.getByLabel('Tên hạng vé').fill(name);
    await add.getByLabel('Giá (VND)').fill(price);
    await add.getByLabel('Số lượng bán').fill(qty);
    await add.getByRole('button', { name: 'Thêm hạng vé' }).click();
    await expect(page.getByText(`Đã thêm hạng vé "${name}".`)).toBeVisible();
    await expect(page.getByRole('table', { name: 'Các hạng vé của sự kiện' }).getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await shot(page, '22-khai-bao-hang-ve');

  await page.goto('/admin/events/ev-104/edit');
  await page.getByRole('button', { name: 'Sửa hạng vé VIP' }).click();
  await page.getByLabel('Số lượng bán hạng vé VIP').fill('5');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText(/đã có 20 vé được đặt/)).toBeVisible();
  await shot(page, '23-loi-giam-so-ve');

  await page.getByRole('link', { name: 'Đơn đặt vé' }).click();
  await expect(page.getByRole('table', { name: 'Danh sách đơn đặt vé' })).toBeVisible();
  await page.getByLabel('Trạng thái').selectOption('CANCELLED');
  await expect(page.locator('tbody tr').first()).toContainText('Đã hủy');
  await shot(page, '24-tra-cuu-don');
  await page.locator('tbody tr').first().getByRole('link').click();
  await expect(page.getByText('Người đặt')).toBeVisible();
  await shot(page, '25-chi-tiet-don');

  await page.getByRole('link', { name: 'Thống kê' }).click();
  await expect(page.getByRole('heading', { name: 'Bảng số liệu' })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, '26-thong-ke-theo-ngay');
  const bar = page.locator('.recharts-bar-rectangle').nth(20);
  await bar.hover();
  await expect(page.locator('.chart-tooltip')).toBeVisible();
  await shot(page, '27-thong-ke-tooltip', false);

  await page.getByRole('button', { name: 'Theo sự kiện' }).click();
  await expect(page.getByRole('columnheader', { name: 'Sự kiện' })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, '28-thong-ke-theo-su-kien');
});

test('thống kê ở chế độ tối', async ({ browser }) => {
  const context = await browser.newContext({
    colorScheme: 'dark',
    viewport: { width: 1280, height: 860 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  });
  const page = await context.newPage();
  await login(page, 'admin', 'admin123');
  await page.goto('/admin/stats');
  await expect(page.getByRole('heading', { name: 'Bảng số liệu' })).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, '29-thong-ke-che-do-toi', false);
  await context.close();
});
