# Báo cáo: Giao diện tìm sự kiện và đặt vé

| | |
|---|---|
| Đầu việc | 1 — Giao diện tìm sự kiện và đặt vé (phía khách hàng) |
| Người thực hiện | Ma Đức Minh |
| Hệ thống | Hệ thống đặt vé đa sự kiện — Nhóm 5 (GCP + Azure) |
| Mã nguồn | `frontend/src/pages/LoginPage.tsx`, `frontend/src/pages/customer/`, phần dùng chung trong `src/api`, `src/auth`, `src/components`, `src/lib` |

## 1. Mục tiêu

Xây dựng các màn hình để khách hàng đăng nhập, xem và lọc sự kiện, đặt vé, theo dõi và hủy đơn của mình. Giao diện gọi API của backend chung trên GCP (thư mục `cloud-backend`): phần đăng nhập và phân quyền của Đoàn Việt Đức, phần sự kiện và đơn của Vũ Ngọc Đức.

Sau khi Vũ Ngọc Đức bổ sung sơ đồ ghế và hàng chờ ảo ở backend, phần giao diện cho hai chức năng này cũng do Ma Đức Minh làm (theo [`GHE-VA-HANG-CHO.md`](../../cloud-backend/docs/GHE-VA-HANG-CHO.md)): khách chọn ghế trên sơ đồ, xếp hàng chờ khi mở bán, và các công cụ quản trị sơ đồ ghế, hàng chờ.

## 2. Công nghệ và cách tổ chức

- **React 18 + TypeScript**, đóng gói bằng **Vite**; điều hướng bằng **React Router**. CSS tự viết (`src/styles.css`), hỗ trợ chế độ sáng/tối và màn hình điện thoại. Bộ giao diện được làm lại: màu chủ đạo tím chàm, font Be Vietnam Pro đi kèm ứng dụng (đủ dấu tiếng Việt, không tải từ máy chủ ngoài), ảnh bìa vẽ bằng CSS theo từng loại hình vì backend chưa có ảnh sự kiện.
- **Sơ đồ ghế** vẽ bằng SVG theo tọa độ backend trả về, không cần thêm thư viện (`src/components/SeatMap.tsx`). Màu hạng ghế lấy từ bảng màu phân loại đã chạy kiểm tra mù màu ở cả chế độ sáng và tối; trạng thái ghế còn có ký hiệu riêng (×, ✓, viền đứt) nên không chỉ dựa vào màu.
- **Lớp gọi API** (`src/api/client.ts`, `src/api/index.ts`) gom mọi xử lý chung vào một chỗ: gắn `Authorization: Bearer`, giới hạn thời gian chờ 15 giây, chuyển mọi lỗi về một dạng `ApiError { status, code, message, details }`, tách lỗi theo từng ô nhập từ `details: [{ path, message }]` của backend. Khi máy chủ trả 401, lớp này báo cho phần quản lý phiên để tự đăng xuất.
- **Nối với backend chung**: mọi đường dẫn, dữ liệu và mã lỗi theo [`cloud-backend/docs/API.md`](../../cloud-backend/docs/API.md). Khi phát triển, dev server của Vite chuyển tiếp `/api` sang backend nên không vướng CORS. Chi tiết: [KET-NOI-BACKEND.md](KET-NOI-BACKEND.md).
- **Backend giả** (`src/api/mock/`): trước khi có backend, nhóm frontend viết một backend giả chạy trong trình duyệt. Khi backend thật xong, backend giả được viết lại theo đúng hợp đồng của backend thật (cùng đường dẫn, dữ liệu, mã lỗi, tài khoản mẫu), để vẫn chạy demo và kiểm thử nhanh được khi không bật backend.

```text
Trình duyệt ──► Frontend ──/api──► Backend chung (Express, Cloud Run) ──► PostgreSQL (Cloud SQL)
                                          └──► Azure (hàng đợi và API thống kê)
```

## 3. Chức năng đã làm

| Yêu cầu trong bảng phân công | Cách làm | API backend |
|---|---|---|
| Trang đăng nhập: ô tài khoản, mật khẩu, nút đăng nhập; báo lỗi khi thiếu hoặc sai | Kiểm tra ô trống trước khi gửi (báo lỗi ngay dưới ô). Sai tài khoản hoặc mật khẩu thì báo lỗi chung, không nói rõ sai ô nào. Nút bị khóa trong lúc chờ. | `POST /api/auth/login` |
| Lưu phiên, chuyển khách tới trang sự kiện; dùng chung cho quản trị viên | Lưu token trong `sessionStorage` theo hướng dẫn của backend. Tải lại trang thì gọi `GET /api/me` để lấy vai trò mới nhất. Sau đăng nhập: `customer` vào `/events`, `admin` vào `/admin`. Bị chặn ở trang nào thì đăng nhập xong quay lại đúng trang đó. | `GET /api/me` |
| Danh sách sự kiện: tên, loại hình, thời gian, địa điểm | Lưới thẻ sự kiện có ảnh bìa theo loại hình và ô ngày, giờ Việt Nam kèm thứ trong tuần. Thêm giá thấp nhất, số vé còn, nhãn "Sắp hết vé"/"Hết vé". Có ô tìm theo tên hoặc địa điểm và phân trang. | `GET /api/events?q=&page=` |
| Bộ lọc concert / thể thao / nhạc kịch, đổi bộ lọc thì gọi API | Nút lọc lấy từ các loại hình đang có sự kiện mở bán, kèm tên tiếng Việt (`sport` → Thể thao, `musical` → Nhạc kịch, …). Đổi bộ lọc thì gọi lại API. Bộ lọc lưu trên URL nên tải lại trang hoặc gửi link vẫn giữ. | `GET /api/events/categories`, `GET /api/events?category=` |
| Trang chi tiết: mô tả, thời gian, địa điểm, hạng vé với giá và số còn lại | Hiện giờ bắt đầu và kết thúc. Mỗi hạng vé có thanh "còn / tổng", báo "sắp hết" khi còn dưới 15%. | `GET /api/events/:id` |
| Form đặt vé: chọn hạng, số lượng nguyên dương, thành tiền tạm tính | Hạng hết vé bị khóa. Số lượng có nút tăng/giảm, phải là số nguyên dương và không vượt số còn lại. Thành tiền cập nhật ngay khi đổi hạng hoặc số lượng. | |
| **Chọn ghế trên sơ đồ** (hạng vé `ASSIGNED`) | Sơ đồ ghế có phóng to/thu nhỏ, chú thích từng hạng kèm giá và số ghế còn. Bấm ghế để chọn hoặc bỏ, tối đa 10 ghế cùng một hạng (bấm ghế hạng khác thì chuyển hạng). Trạng thái ghế được hỏi lại mỗi 8 giây; ghế đang chọn mà vừa bị người khác đặt hoặc bị khóa thì tự bỏ ra và báo. Nếu lúc bấm đặt có ghế vừa bị lấy (`SEAT_TAKEN`/`SEAT_BLOCKED`), cả đơn bị từ chối, các ghế đó được bỏ khỏi lựa chọn và sơ đồ cập nhật ngay. | `GET /api/events/:id/seat-map`, `GET /api/events/:id/seats/status`, `POST /api/orders` với `seatIds` |
| **Hàng chờ ảo** | Sự kiện bật hàng chờ thì form đặt vé được thay bằng trang chờ. Trước giờ mở bán: đồng hồ đếm ngược theo giờ máy chủ và số người đang chờ, kèm ghi chú thứ tự sẽ xếp ngẫu nhiên. Sau giờ mở bán: số thứ tự và số người phía trước. Tới lượt: hiện form đặt vé kèm thời gian còn lại. Đặt xong một đơn thì lượt kết thúc, có nút vào hàng lại. Tải lại trang thì tiếp tục lượt đang có. | `POST /api/events/:id/queue`, `GET /api/events/:id/queue/me`, `DELETE /api/events/:id/queue/me` |
| Bấm đặt: khóa nút khi chờ; hiện mã đơn khi thành công; báo rõ khi hết vé hoặc mất kết nối | Nút đổi thành "Đang đặt vé…" và bị khóa. Thành công: hiện mã đơn, số vé, thành tiền, link tới đơn; số vé còn lại được tải lại. Hết vé (`SOLD_OUT`) hoặc không đủ (`INSUFFICIENT_TICKETS`): báo số vé còn lại. Vượt 10 vé mỗi đơn: hiện nguyên văn câu của backend. **Mất kết nối**: mỗi lần bấm kèm một `Idempotency-Key`; khi khách bấm lại cùng hạng và số lượng, frontend gửi lại đúng khóa đó nên backend trả về đơn đã tạo, **không tạo đơn trùng**. | `POST /api/orders` |
| Trang Vé của tôi: sự kiện, hạng vé, số lượng, mã đơn, trạng thái | Mỗi đơn là một tấm vé có cuống xé: sự kiện, hạng vé, số ghế (nếu có), mã đơn, trạng thái, thành tiền. Mới nhất trước, lọc theo trạng thái, phân trang. Mã đơn là UUID nên hiện 8 ký tự đầu, xem đủ ở trang chi tiết. | `GET /api/orders` |
| Xem chi tiết đơn và yêu cầu hủy; cập nhật trạng thái sau khi API xác nhận | Hiện đủ thông tin đơn và **hạn hủy** (backend chỉ cho hủy trước giờ diễn ít nhất 24 giờ). Nút hủy chỉ hiện khi backend báo `canCancel`. Bấm hủy → hộp xác nhận, nhập lý do (không bắt buộc) → gọi API. **Chỉ đổi trạng thái trên màn hình sau khi API trả thành công.** Quá hạn: "Đã quá hạn hủy đơn (chỉ được hủy đến …)". Đơn bị quản trị viên hủy thì ghi rõ người hủy và lý do. Đơn của người khác: "Không tìm thấy đơn". | `GET /api/orders/:id`, `POST /api/orders/:id/cancel` |
| Kiểm tra màn hình khi đang tải, không có dữ liệu, API lỗi | Mọi màn hình có ba trạng thái: đang tải, rỗng (kèm gợi ý), lỗi (kèm nút "Thử lại"). Phiên hết hạn thì tự đăng xuất và báo cho người dùng. | |

Ngoài yêu cầu: giao diện điện thoại, chế độ tối, điều hướng bằng bàn phím và nhãn cho trình đọc màn hình, trang "Không có quyền" khi khách vào khu quản trị.

## 4. Kiểm thử

### 4.1 Kiểm thử trên trình duyệt thật với backend thật (`npm run e2e:api`)

Chạy Playwright trên Google Chrome. Frontend gọi backend chung chạy trên máy (Node.js + PostgreSQL 16 trong Docker, `AUTH_MODE=local`, tài khoản mẫu `alice`, `bob`, `admin1`). Kịch bản tự tạo sự kiện riêng nên chạy lại bao nhiêu lần cũng được.

| Kịch bản | Nội dung | Kết quả |
|---|---|---|
| 1 | Đăng nhập bỏ trống, sai mật khẩu; quản trị viên tạo sự kiện nhạc kịch, thêm hạng VIP (5 vé) và Thường | Đạt |
| 2 | `alice` lọc "Nhạc kịch" → mở sự kiện → nhập 6 vé VIP (bị báo chỉ còn 5) → đặt 2 vé, thấy mã đơn và số còn lại giảm còn 3 → đặt 1 vé Thường nhưng **phản hồi bị chặn sau khi máy chủ đã tạo đơn**, bấm lại → "Vé của tôi" chỉ có 2 đơn, không trùng | Đạt |
| 3 | Hủy đơn kèm lý do; đặt vé vở kịch diễn trong vòng 24 giờ tới → đơn hiện "Đã quá hạn hủy"; vào trang quản trị bị chặn; `bob` mở đường dẫn đơn của `alice` → "Không tìm thấy" | Đạt |
| 4 | Phần quản trị (xem báo cáo của Nguyễn Quang Huy) | Đạt |
| 5 | Sự kiện chọn ghế mở bán qua hàng chờ, mỗi lượt 1 người: `bob` vào hàng trước và tới lượt, `alice` vào sau thì thấy "Bạn đứng đầu hàng" và chưa có form đặt vé; `bob` chọn ghế A1, A2 và đặt xong thì `alice` tự được vào; ghế A1 hiện đã bán; quản trị viên khóa đúng ghế A3 `alice` đang chọn → đơn bị từ chối, ghế được bỏ khỏi lựa chọn; `alice` chọn A4, A5 và đặt được | Đạt |
| 6 | Màn hình điện thoại 390 px (không có thanh cuộn ngang, cả trang sơ đồ ghế) và chế độ tối | Đạt |

Cùng bộ kịch bản cũng đạt khi chạy với backend giả (`npm run e2e`).

### 4.2 Kiểm thử tự động (Vitest + Testing Library, `npm test`)

Chạy trên backend giả, mô phỏng người dùng bấm và gõ thật. Toàn bộ **61 test đều đạt** (gồm cả phần quản trị).

| Nhóm | Số test | Nội dung chính |
|---|---|---|
| Lớp API — đăng nhập | 6 | đúng/sai mật khẩu, bỏ trống, `/api/me`, token sai → tự đăng xuất, chưa đăng nhập gọi API cần xác thực |
| Lớp API — sự kiện | 4 | phân trang, ẩn bản nháp, lọc theo loại, danh sách loại hình, 404 |
| Lớp API — đặt/hủy | 7 | trừ và hoàn vé đúng một lần, `Idempotency-Key`, hết vé, vượt số còn lại, vượt 10 vé/đơn, số lượng 0 hoặc 1,5, quá hạn hủy, đơn của người khác, mất mạng |
| Lớp API — ghế và hàng chờ | 4 | đặt ghế rồi hủy thì trả ghế; ghế đã bán, khác hạng, thiếu ghế, ghế cho vé thường, quá 10 ghế, `Idempotency-Key` theo tập ghế; quản trị lưu sơ đồ, xung đột phiên bản, ghế chồng nhau, khóa ghế, ghế đã bán, chép sơ đồ; hàng chờ: chưa mở bán, lần lượt vào mua, đặt xong thì kết thúc lượt |
| Giao diện khách hàng | 18 | luồng đầy đủ đăng nhập → lọc → đặt → Vé của tôi → hủy kèm lý do; khóa nút khi chờ; hạng hết vé; lỗi vượt số vé/đơn; rớt mạng rồi bấm lại không trùng đơn; quá hạn hủy; lỗi tải và nút Thử lại; danh sách rỗng; chuyển trang; phiên hết hạn; khách vào trang quản trị; chọn ghế và chuyển hạng; ghế vừa bị người khác đặt; vào và rời hàng chờ; tới lượt thì đặt được và lượt kết thúc |

### 4.3 Ảnh chụp màn hình (chạy với backend thật)

| | |
|---|---|
| ![Đăng nhập](screenshots/01-dang-nhap.png) Đăng nhập | ![Lỗi đăng nhập](screenshots/02-dang-nhap-loi.png) Sai mật khẩu |
| ![Danh sách sự kiện](screenshots/03-danh-sach-su-kien.png) Danh sách sự kiện, nút lọc lấy từ backend | ![Lọc](screenshots/04-loc-nhac-kich.png) Lọc "Nhạc kịch" |
| ![Lỗi số lượng](screenshots/05-dat-ve-loi-so-luong.png) Số lượng vượt số vé còn lại | ![Đặt vé thành công](screenshots/06-dat-ve-thanh-cong.png) Đặt vé thành công, hiện mã đơn |
| ![Mất kết nối](screenshots/10-mat-ket-noi.png) Báo mất kết nối khi đặt vé | ![Vé của tôi](screenshots/07-ve-cua-toi.png) Vé của tôi |
| ![Xác nhận hủy](screenshots/08-xac-nhan-huy.png) Xác nhận hủy, nhập lý do | ![Hủy thành công](screenshots/09-huy-thanh-cong.png) Hủy thành công |
| ![Quá hạn hủy](screenshots/14-qua-han-huy.png) Đơn quá hạn hủy | ![Đơn của người khác](screenshots/15-don-cua-nguoi-khac.png) Mở đơn của người khác |
| ![Không có quyền](screenshots/11-khong-co-quyen.png) Khách vào khu quản trị | ![Điện thoại](screenshots/13-dien-thoai-chi-tiet.png) Giao diện điện thoại |
| ![Chọn ghế](screenshots/16-chon-ghe.png) Chọn ghế trên sơ đồ | ![Hàng chờ](screenshots/17-hang-cho.png) Đang xếp hàng chờ tới lượt |
| ![Ghế bị khóa](screenshots/18-ghe-vua-bi-khoa.png) Ghế vừa bị khóa khi đang chọn | ![Sơ đồ ghế trên điện thoại](screenshots/19-dien-thoai-so-do-ghe.png) Sơ đồ ghế trên điện thoại |
| ![Vé trên điện thoại](screenshots/07b-dien-thoai-ve-cua-toi.png) Vé của tôi trên điện thoại | |

## 5. Hướng dẫn chạy

```bash
# Backend (thư mục cloud-backend): xem mục 3.2 của README chung, cần AUTH_MODE=local
cd frontend
npm install
npm run dev:api    # http://localhost:5173, tài khoản alice / DemoCustomer2026!
npm test           # kiểm thử tự động
npm run e2e:api    # kịch bản trên Chrome với backend thật
```

Không bật backend thì dùng `npm run dev` (dữ liệu giả, cùng tài khoản).

## 6. Hạn chế và việc còn lại

- **Chưa chạy trên cloud.** Frontend đã nối và kiểm thử với bản backend mới nhất chạy trên máy. Bản `ticket-api` đang chạy trên Cloud Run là bản cũ với `AUTH_MODE=jwt`, chưa có API đăng nhập. Cần Hoàng Quốc Dương triển khai lại backend với `AUTH_MODE=local` và tài khoản mẫu, sau đó triển khai frontend (mục 5 của [KET-NOI-BACKEND.md](KET-NOI-BACKEND.md)).
- Thống kê trên máy dùng `STATS_MODE=mock` (backend tự tính từ DB), chưa thử với API thống kê thật trên Azure.
- Token lưu trong `sessionStorage` nên vẫn có thể bị đọc nếu trang dính lỗi XSS. Hệ thống thật nên chuyển sang cookie `HttpOnly` do backend cấp.
- Hàng chờ chỉ được thử trên máy với vài người. Mỗi khách đang chờ hỏi lại trạng thái 3–30 giây một lần; khi đông người thật cần tăng số instance backend (worker hàng chờ đã chạy song song an toàn).
- Chưa có công cụ kéo thả để vẽ sơ đồ từng ghế: quản trị viên tạo từ mẫu (nhà hát hàng cong, các hàng thẳng) hoặc nhập file JSON. API không cần đổi khi làm thêm công cụ này.
