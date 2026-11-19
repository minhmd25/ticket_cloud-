// Kịch bản đầu-cuối trên Chrome. Tự tạo sự kiện riêng nên chạy được với cả backend thật
// (npm run e2e:api) lẫn backend giả (npm run e2e).
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';

const API_MODE = process.env.E2E_MODE === 'api';
const SHOTS = process.env.E2E_SCREENSHOTS === '1';
const CUSTOMER_PASSWORD = process.env.E2E_CUSTOMER_PASSWORD ?? 'DemoCustomer2026!';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'DemoAdmin2026!';

const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
const EVENT_TITLE = `Nhạc kịch Ánh trăng Hồ Gươm #${stamp}`;
const SEAT_EVENT = `Hòa nhạc thính phòng #${stamp}`;

async function shot(page: Page, name: string, fullPage = true) {
  if (!SHOTS) return;
  // Kịch bản 5 mở nhiều tab cùng lúc; tab nằm sau không được vẽ lại nên phải đưa lên trước rồi mới chụp.
  await page.bringToFront();
  // Cuộn về đầu trang để thanh tiêu đề cố định không bị in lơ lửng khi chụp toàn trang.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage });
}

// Mỗi test chạy trong một ngữ cảnh trình duyệt mới nên chưa đăng nhập.
/** Chờ biểu đồ vẽ xong. Cột có giá trị 0 không được vẽ, nên chờ cột đầu tiên thực sự có số liệu. */
async function waitChart(page: Page) {
  await expect(page.locator('.recharts-bar-rectangle .recharts-rectangle').first()).toBeVisible();
}

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Tài khoản').fill(username);
  await page.getByLabel('Mật khẩu').fill(password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
}

/** "2026-11-24T19:30" theo giờ Việt Nam, cách hôm nay `days` ngày. */
function vnInput(days: number, hhmm: string) {
  const d = new Date(Date.now() + 7 * 3_600_000 + days * 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hhmm}`;
}

/** Giờ Việt Nam hiện tại cộng `minutes` phút, dạng ô datetime-local. */
function vnNow(minutes: number) {
  return new Date(Date.now() + 7 * 3_600_000 + minutes * 60_000).toISOString().slice(0, 16);
}

const seat = (label: string) => new RegExp(`^Ghế ${label} ·`);

test.describe.configure({ mode: 'serial' });

let orderCode = '';
let orderUrl = '';
let seatEventId = '';

// Backend thật: mỗi kịch bản một trình duyệt sạch. Backend giả lưu dữ liệu trong localStorage
// của trình duyệt, nên các kịch bản dùng chung một ngữ cảnh để thấy dữ liệu của nhau
// (sessionStorage vẫn tách theo từng tab nên mỗi tab đăng nhập riêng).
let shared: BrowserContext | null = null;

async function newPage(browser: Browser, options: BrowserContextOptions = {}): Promise<Page> {
  if (API_MODE) return (await browser.newContext(options)).newPage();
  shared ??= await browser.newContext();
  if (Object.keys(options).length === 0) return shared.newPage();
  return (await browser.newContext({ ...options, storageState: await shared.storageState() })).newPage();
}

test.afterAll(async () => {
  await shared?.close();
});

test('1. quản trị viên tạo sự kiện và khai báo hạng vé', async ({ browser }) => {
  const page = await newPage(browser);
  await page.goto('/login');
  await shot(page, '01-dang-nhap');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByText('Vui lòng nhập tài khoản.')).toBeVisible();
  await page.getByLabel('Tài khoản').fill('admin1');
  await page.getByLabel('Mật khẩu').fill('sai-mat-khau');
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
  await expect(page.getByText(/Sai tài khoản hoặc mật khẩu/)).toBeVisible();
  await shot(page, '02-dang-nhap-loi');

  await login(page, 'admin1', ADMIN_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Quản lý sự kiện' })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await shot(page, '20-quan-tri-su-kien');

  await page.getByRole('link', { name: 'Tạo sự kiện' }).click();
  const form = page.getByRole('form', { name: 'Thông tin sự kiện' });
  await form.getByRole('button', { name: 'Tạo sự kiện' }).click();
  await expect(form.getByText('Vui lòng nhập tên sự kiện.')).toBeVisible();
  await shot(page, '21-tao-su-kien-loi');

  await form.getByLabel(/Tên sự kiện/).fill(EVENT_TITLE);
  await form.getByLabel(/Loại hình/).selectOption('musical');
  await form.getByLabel(/Bắt đầu/).fill(vnInput(5, '19:30'));
  await form.getByLabel(/Kết thúc/).fill(vnInput(5, '22:00'));
  await form.getByLabel(/Địa điểm/).fill('Nhà hát Lớn Hà Nội');
  await form.getByLabel('Mô tả').fill('Vở nhạc kịch hai màn về Hà Nội xưa, có dàn nhạc sống và hợp xướng 40 người.');
  await form.getByRole('button', { name: 'Tạo sự kiện' }).click();
  await expect(page.getByText(/Đã tạo sự kiện/)).toBeVisible();

  const add = page.getByRole('form', { name: 'Thêm hạng vé' });
  const table = page.getByRole('table', { name: 'Các hạng vé của sự kiện' });
  for (const [name, price, qty] of [
    ['VIP', '1500000', '5'],
    ['Thường', '500000', '100'],
  ]) {
    await add.getByLabel('Tên hạng vé').fill(name);
    await add.getByLabel('Giá (VND)').fill(price);
    await add.getByLabel('Số lượng bán').fill(qty);
    await add.getByRole('button', { name: 'Thêm hạng vé' }).click();
    await expect(page.getByText(`Đã thêm hạng vé "${name}".`)).toBeVisible();
    await expect(table.getByRole('cell', { name, exact: true })).toBeVisible();
  }
  await shot(page, '22-khai-bao-hang-ve');
});

test('2. khách hàng lọc sự kiện, đặt vé, mất mạng khi đặt không bị trùng đơn', async ({ browser }) => {
  const page = await newPage(browser);
  await login(page, 'alice', CUSTOMER_PASSWORD);
  await expect(page.getByRole('heading', { name: 'Sự kiện', level: 1 })).toBeVisible();
  await expect(page.locator('.event-card').first()).toBeVisible();
  await shot(page, '03-danh-sach-su-kien');

  await page.getByRole('button', { name: 'Nhạc kịch' }).click();
  await expect(page.getByRole('link', { name: EVENT_TITLE })).toBeVisible();
  await expect(page.locator('.event-card .tag').filter({ hasNotText: 'Nhạc kịch' })).toHaveCount(0);
  await shot(page, '04-loc-nhac-kich');

  await page.getByRole('link', { name: EVENT_TITLE }).click();
  const form = page.getByRole('form', { name: 'Đặt vé' });
  await form.getByText('VIP').click();
  await form.getByLabel('Số lượng', { exact: true }).fill('6');
  await expect(form.getByText('Hạng vé này chỉ còn 5 vé.')).toBeVisible();
  await shot(page, '05-dat-ve-loi-so-luong');

  await form.getByLabel('Số lượng', { exact: true }).fill('2');
  await expect(form.getByText('3.000.000 ₫').or(form.getByText('3.000.000 đ'))).toBeVisible();
  await form.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(form.getByText(/Đặt vé thành công/)).toBeVisible();
  orderCode = (await form.locator('.alert .code').textContent())!;
  await expect(form.getByText('Còn 3 vé')).toBeVisible();
  await expect(page.getByText('Đang cập nhật số vé…')).toBeHidden();
  await shot(page, '06-dat-ve-thanh-cong');
  orderUrl = (await form.getByRole('link', { name: 'Xem đơn' }).getAttribute('href'))!;

  // Rớt mạng sau khi máy chủ đã nhận đơn: bấm lại không tạo đơn thứ hai.
  await form.getByText('Thường').click();
  await form.getByLabel('Số lượng', { exact: true }).fill('1');
  if (API_MODE) {
    await page.route(
      '**/api/orders',
      async (route) => {
        await route.fetch(); // yêu cầu tới máy chủ và được xử lý
        await route.abort('failed'); // nhưng phản hồi không về tới trình duyệt
      },
      { times: 1 },
    );
  } else {
    await page.getByLabel('Giả lập mất kết nối').check();
  }
  await form.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(form.getByText(/Mất kết nối tới máy chủ/)).toBeVisible();
  await shot(page, '10-mat-ket-noi');
  if (!API_MODE) await page.getByLabel('Giả lập mất kết nối').uncheck();
  await form.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(form.getByText(/Đặt vé thành công/)).toBeVisible();

  await page.getByRole('link', { name: 'Vé của tôi' }).first().click();
  await expect(page.locator('.ticket').filter({ hasText: orderCode })).toBeVisible();
  const ticketsOfEvent = page.locator('.ticket').filter({ hasText: EVENT_TITLE });
  await expect(ticketsOfEvent).toHaveCount(2); // 2 vé VIP + 1 vé Thường, không có đơn trùng
  await shot(page, '07-ve-cua-toi');
});

test('3. khách hàng hủy đơn, không xem được đơn người khác, đơn sắp diễn quá hạn hủy', async ({ browser }) => {
  const page = await newPage(browser);
  await login(page, 'alice', CUSTOMER_PASSWORD);
  await page.goto('/my-tickets');
  await page
    .locator('.ticket')
    .filter({ hasText: EVENT_TITLE })
    .filter({ hasText: 'Thường' })
    .getByRole('link', { name: /Xem chi tiết đơn/ })
    .click();
  await page.getByRole('button', { name: 'Yêu cầu hủy đơn' }).click();
  await page.getByLabel('Lý do hủy (không bắt buộc)').fill('Đổi lịch công tác');
  await shot(page, '08-xac-nhan-huy');
  await page.getByRole('button', { name: 'Xác nhận hủy' }).click();
  await expect(page.getByText(/Đã hủy đơn thành công/)).toBeVisible();
  await expect(page.getByText('Đổi lịch công tác')).toBeVisible();
  await shot(page, '09-huy-thanh-cong');

  // Sự kiện diễn ra trong vòng 24 giờ: đặt được nhưng không hủy được.
  await page.goto('/events');
  await page.getByRole('link', { name: 'Kịch: Hồn Trương Ba, da hàng thịt' }).click();
  const form = page.getByRole('form', { name: 'Đặt vé' });
  await form.getByRole('button', { name: 'Đặt vé' }).click();
  await form.getByRole('link', { name: 'Xem đơn' }).click();
  await expect(page.getByText(/Đã quá hạn hủy đơn/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Yêu cầu hủy đơn' })).toHaveCount(0);
  await shot(page, '14-qua-han-huy');

  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Không có quyền truy cập' })).toBeVisible();
  await shot(page, '11-khong-co-quyen');

  // bob mở đơn của alice
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await page.waitForURL('**/login');
  await login(page, 'bob', CUSTOMER_PASSWORD);
  await page.goto(orderUrl);
  await expect(page.getByText('Không tìm thấy đơn đặt vé')).toBeVisible();
  await shot(page, '15-don-cua-nguoi-khac');
});

test('4. quản trị viên: giảm vé bị chặn, tra đơn, xem thống kê', async ({ browser }) => {
  const page = await newPage(browser);
  await login(page, 'admin1', ADMIN_PASSWORD);
  await page.getByRole('row', { name: new RegExp(EVENT_TITLE.replace(/[#]/g, '.')) }).getByRole('link', { name: /Chỉnh sửa/ }).click();
  await page.getByRole('button', { name: 'Sửa hạng vé VIP' }).click();
  await page.getByLabel('Số lượng bán hạng vé VIP').fill('1');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText(/đang có 2 vé được giữ/)).toBeVisible();
  await expect(page.getByText('Tối thiểu 2 vé.')).toBeVisible();
  await shot(page, '23-loi-giam-so-ve');

  await page.getByRole('link', { name: 'Đơn đặt vé' }).click();
  await expect(page.getByRole('heading', { name: 'Tra cứu đơn đặt vé' })).toBeVisible();
  await expect(page.getByRole('option', { name: EVENT_TITLE })).toBeAttached();
  await page.getByLabel('Sự kiện', { exact: true }).selectOption({ label: EVENT_TITLE });
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByText(/Đã xác nhận: 1 đơn, 2 vé/)).toBeVisible();
  await shot(page, '24-tra-cuu-don');
  await page.getByRole('link', { name: `Xem chi tiết đơn ${orderCode}` }).click();
  await expect(page.getByText('Người đặt')).toBeVisible();
  await expect(page.getByRole('definition').filter({ hasText: /^alice$/ })).toBeVisible();
  await shot(page, '25-chi-tiet-don');

  await page.getByRole('link', { name: 'Thống kê' }).click();
  await expect(page.getByRole('heading', { name: 'Bảng số liệu' })).toBeVisible({ timeout: 60_000 });
  await waitChart(page);
  await shot(page, '26-thong-ke-theo-ngay');
  await page.locator('.recharts-bar-rectangle .recharts-rectangle').last().hover();
  await expect(page.locator('.chart-tooltip')).toBeVisible();
  await shot(page, '27-thong-ke-tooltip', false);

  await page.getByRole('button', { name: 'Theo sự kiện' }).click();
  const row = page.getByRole('row', { name: new RegExp(EVENT_TITLE.replace(/[#]/g, '.')) });
  await expect(row).toBeVisible({ timeout: 60_000 });
  // 3 vé đặt (2 VIP + 1 Thường), 1 vé hủy, doanh thu thực 3.000.000
  await expect(row.getByRole('cell').nth(0)).toHaveText('3');
  await expect(row.getByRole('cell').nth(1)).toHaveText('1');
  await expect(row.getByRole('cell').nth(3)).toContainText('3.000.000');
  await waitChart(page);
  await shot(page, '28-thong-ke-theo-su-kien');
});

test('5. chọn ghế trên sơ đồ và mở bán qua hàng chờ ảo', async ({ browser }) => {
  // Quản trị viên: hai hạng chọn ghế, sơ đồ lưới 5 hàng x 12 ghế, hàng chờ mở bán ngay, mỗi lượt 1 người mua.
  const admin = await newPage(browser);
  await login(admin, 'admin1', ADMIN_PASSWORD);
  await admin.getByRole('link', { name: 'Tạo sự kiện' }).click();
  const form = admin.getByRole('form', { name: 'Thông tin sự kiện' });
  await form.getByLabel(/Tên sự kiện/).fill(SEAT_EVENT);
  await form.getByLabel(/Loại hình/).selectOption('concert');
  await form.getByLabel(/Bắt đầu/).fill(vnInput(6, '20:00'));
  await form.getByLabel(/Kết thúc/).fill(vnInput(6, '22:00'));
  await form.getByLabel(/Địa điểm/).fill('Nhà hát Lớn Hà Nội');
  await form.getByLabel('Mô tả').fill('Dàn nhạc thính phòng chơi Vivaldi. Chọn ghế trên sơ đồ, mở bán qua hàng chờ.');
  await form.getByRole('button', { name: 'Tạo sự kiện' }).click();
  await expect(admin.getByText(/Đã tạo sự kiện/)).toBeVisible();
  seatEventId = decodeURIComponent(new URL(admin.url()).pathname.split('/')[3]);

  const add = admin.getByRole('form', { name: 'Thêm hạng vé' });
  for (const [name, price] of [
    ['Hạng nhất', '900000'],
    ['Hạng hai', '500000'],
  ]) {
    await add.getByLabel('Tên hạng vé').fill(name);
    await add.getByLabel('Giá (VND)').fill(price);
    await add.getByLabel('Cách bán').selectOption('ASSIGNED');
    await add.getByRole('button', { name: 'Thêm hạng vé' }).click();
    await expect(admin.getByText(`Đã thêm hạng vé "${name}".`)).toBeVisible();
  }
  await admin.getByLabel('Mẫu sơ đồ').selectOption('grid');
  await admin.getByLabel('Số ghế mỗi hàng').fill('12');
  await admin.getByLabel('Hạng nhất', { exact: true }).fill('2');
  await admin.getByLabel('Hạng hai', { exact: true }).fill('3');
  await admin.getByRole('button', { name: 'Xem trước sơ đồ' }).click();
  await expect(admin.getByText('Bản xem trước', { exact: true })).toBeVisible();
  await admin.getByRole('button', { name: 'Lưu sơ đồ' }).click();
  await expect(admin.getByText(/Đã lưu sơ đồ 60 ghế/)).toBeVisible();

  const queue = admin.getByRole('form', { name: 'Cấu hình hàng chờ' });
  await queue.getByLabel('Giờ mở bán (giờ Việt Nam)').fill(vnNow(-1));
  await queue.getByLabel('Số người mua cùng lúc').fill('1');
  await queue.getByLabel('Số phút mỗi lượt mua').fill('10');
  await queue.getByRole('button', { name: 'Lưu cấu hình hàng chờ' }).click();
  await expect(admin.getByText('Đã lưu cấu hình hàng chờ.')).toBeVisible();

  // bob vào hàng trước và tới lượt; alice vào sau thì phải chờ (mỗi lượt chỉ 1 người mua).
  const bob = await newPage(browser);
  await login(bob, 'bob', CUSTOMER_PASSWORD);
  await bob.goto(`/events/${encodeURIComponent(seatEventId)}`);
  await bob.getByRole('button', { name: 'Vào hàng chờ' }).click();
  await expect(bob.getByText('Đã tới lượt bạn!')).toBeVisible({ timeout: 20_000 });

  const alice = await newPage(browser);
  await login(alice, 'alice', CUSTOMER_PASSWORD);
  await alice.goto(`/events/${encodeURIComponent(seatEventId)}`);
  await alice.getByRole('button', { name: 'Vào hàng chờ' }).click();
  await expect(alice.getByText('Bạn đứng đầu hàng')).toBeVisible({ timeout: 20_000 });
  await expect(alice.getByRole('form', { name: 'Đặt vé' })).toHaveCount(0);
  await shot(alice, '17-hang-cho');

  const bobForm = bob.getByRole('form', { name: 'Đặt vé' });
  await bobForm.getByRole('button', { name: seat('A1') }).click();
  await bobForm.getByRole('button', { name: seat('A2') }).click();
  await expect(bobForm.getByText('Ghế đã chọn (2/10)')).toBeVisible();
  await shot(bob, '16-chon-ghe');
  await bobForm.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(bob.getByText(/Lượt mua của bạn đã kết thúc/)).toBeVisible();

  // bob mua xong thì tới lượt alice; ghế bob vừa đặt không chọn được nữa.
  await expect(alice.getByText('Đã tới lượt bạn!')).toBeVisible({ timeout: 30_000 });
  const aliceForm = alice.getByRole('form', { name: 'Đặt vé' });
  await expect(aliceForm.getByRole('img', { name: /^Ghế A1 · .*đã có người đặt/ })).toBeVisible();
  await aliceForm.getByRole('button', { name: seat('A3') }).click();

  // Ngay lúc đó quản trị viên khóa ghế A3: alice bấm đặt thì bị từ chối, ghế được bỏ khỏi lựa chọn.
  await admin.getByRole('button', { name: seat('A3') }).click();
  await admin.getByRole('button', { name: 'Khóa ghế' }).click();
  await expect(admin.getByText('Đã khóa 1 ghế.')).toBeVisible();
  await aliceForm.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(aliceForm.getByText(/Có ghế đang bị khóa|A3 vừa được người khác đặt hoặc ngừng bán/)).toBeVisible();
  await shot(alice, '18-ghe-vua-bi-khoa');

  await aliceForm.getByRole('button', { name: seat('A4') }).click();
  await aliceForm.getByRole('button', { name: seat('A5') }).click();
  await aliceForm.getByRole('button', { name: 'Đặt vé' }).click();
  await expect(alice.getByText(/ghế A4, A5/)).toBeVisible();

  await admin.getByRole('button', { name: 'Tải lại số người' }).click();
  await expect(admin.getByText('Đã mua xong', { exact: true }).locator('..')).toContainText('2');
  await admin.reload();
  await expect(admin.getByRole('img', { name: /^Ghế A5 · .*đã có người đặt/ })).toBeVisible();
  await shot(admin, '30-quan-tri-so-do-ghe');

  // Tắt hàng chờ: khách chọn ghế và đặt trực tiếp.
  const queueForm = admin.getByRole('form', { name: 'Cấu hình hàng chờ' });
  await queueForm.getByLabel('Bật hàng chờ ảo cho sự kiện này').uncheck();
  await queueForm.getByRole('button', { name: 'Lưu cấu hình hàng chờ' }).click();
  await expect(admin.getByText(/Đã tắt hàng chờ/)).toBeVisible();

  await admin.getByRole('link', { name: 'Đơn đặt vé' }).click();
  await admin.getByLabel('Sự kiện', { exact: true }).selectOption({ label: SEAT_EVENT });
  await expect(admin.locator('tbody tr')).toHaveCount(2);
  await expect(admin.locator('tbody tr').filter({ hasText: 'alice' })).toContainText('Ghế A4, A5');
});

test('6. giao diện điện thoại và chế độ tối', async ({ browser }) => {
  const page = await newPage(browser, {
    viewport: { width: 390, height: 844 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    isMobile: true,
    reducedMotion: 'reduce',
  });
  await login(page, 'alice', CUSTOMER_PASSWORD);
  await expect(page.locator('.event-card').first()).toBeVisible();
  await shot(page, '12-dien-thoai-su-kien', false);
  await page.getByRole('button', { name: 'Nhạc kịch' }).click();
  await page.getByRole('link', { name: EVENT_TITLE }).click();
  await expect(page.getByRole('form', { name: 'Đặt vé' })).toBeVisible();
  await shot(page, '13-dien-thoai-chi-tiet');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.goto(`/events/${encodeURIComponent(seatEventId)}`);
  await expect(page.getByRole('group', { name: /Sơ đồ ghế/ })).toBeVisible();
  await page.getByRole('button', { name: seat('C6') }).click();
  await shot(page, '19-dien-thoai-so-do-ghe');
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.goto('/my-tickets');
  await expect(page.locator('.ticket').first()).toBeVisible();
  await shot(page, '07b-dien-thoai-ve-cua-toi', false);
  await page.context().close();

  const darkPage = await newPage(browser, {
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    viewport: { width: 1280, height: 860 },
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
  });
  await login(darkPage, 'admin1', ADMIN_PASSWORD);
  await darkPage.goto('/admin/stats');
  await expect(darkPage.getByRole('heading', { name: 'Bảng số liệu' })).toBeVisible({ timeout: 60_000 });
  await waitChart(darkPage);
  await shot(darkPage, '29-thong-ke-che-do-toi', false);
  await darkPage.context().close();
});
