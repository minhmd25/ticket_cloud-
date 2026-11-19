# Kết nối frontend với backend

Frontend gọi **backend chung** trong thư mục `cloud-backend` (Vũ Ngọc Đức, Đoàn Việt Đức).
Hợp đồng API chính thức là [`cloud-backend/docs/API.md`](../../cloud-backend/docs/API.md). Tài liệu này chỉ ghi frontend dùng API nào và xử lý từng mã lỗi ra sao.

Mọi lời gọi API nằm trong một file: [`src/api/index.ts`](../src/api/index.ts). Nếu backend đổi đường dẫn hay dữ liệu, chỉ cần sửa file này.

## 1. Ba cách chạy

| Lệnh | Gọi tới | Dùng khi |
|---|---|---|
| `npm run dev` | Backend giả trong trình duyệt (`src/api/mock`) | Demo nhanh, không cần backend |
| `npm run dev:api` | Backend chạy trên máy, `http://localhost:3000` | Phát triển và kiểm thử với backend thật |
| `npm run dev:cloud` | `https://ticket-api-5iqotxgmrq-as.a.run.app` | Thử với bản backend trên Cloud Run |

Ở chế độ `dev:api` và `dev:cloud`, dev server của Vite chuyển tiếp mọi request `/api/...` sang backend (cấu hình `VITE_PROXY_TARGET` trong `.env.api`, `.env.cloud`). Trình duyệt coi frontend và backend là cùng một địa chỉ nên **không cần mở CORS cho localhost**.

Backend giả trả lời đúng cùng hợp đồng với backend thật (cùng đường dẫn, dữ liệu, mã lỗi, tài khoản mẫu), nên mọi màn hình chạy giống nhau ở cả ba chế độ.

### Chạy backend trên máy

Làm theo mục 3.2 của [README chung](../../README.md#32-chạy-cả-backend-và-frontend). Các biến cần cho frontend:

```bash
AUTH_MODE=local            # bật POST /api/auth/login
AUTH_JWT_SECRET=<32 byte ngẫu nhiên>
PUBLISHER_MODE=mock        # không gửi dữ liệu thử sang queue Azure dùng chung
STATS_MODE=mock            # thống kê tính từ DB trên máy
```

Tài khoản mẫu (`npm run seed:accounts -- --demo`):

| Vai trò | Tài khoản | Mật khẩu |
|---|---|---|
| Khách hàng | `alice` | `DemoCustomer2026!` |
| Quản trị viên | `admin1` | `DemoAdmin2026!` |

Backend giả có thêm `bob`, `carol` (cùng mật khẩu khách) để thử quyền xem đơn của người khác.

## 2. Màn hình nào gọi API nào

| Màn hình | API |
|---|---|
| Đăng nhập (chung) | `POST /api/auth/login`, `GET /api/me` (kiểm tra phiên khi tải lại trang) |
| Danh sách sự kiện | `GET /api/events/categories` (nút lọc), `GET /api/events?category=&page=&limit=` |
| Chi tiết + đặt vé | `GET /api/events/:id`, `POST /api/orders` kèm header `Idempotency-Key` (vé thường gửi `quantity`, vé chọn ghế gửi `seatIds`) |
| Chọn ghế | `GET /api/events/:id/seat-map` (một lần, có ETag), `GET /api/events/:id/seats/status` (mỗi 8 giây và ngay sau khi bị từ chối ghế) |
| Hàng chờ ảo | `GET /api/events/:id/queue/me` (khi mở trang và theo `retryAfterSeconds`), `POST /api/events/:id/queue` (Vào hàng), `DELETE /api/events/:id/queue/me` (Rời hàng) |
| Vé của tôi | `GET /api/orders?status=&page=` |
| Chi tiết đơn + hủy | `GET /api/orders/:id`, `POST /api/orders/:id/cancel` (kèm lý do) |
| Quản trị: danh sách sự kiện | `GET /api/admin/events?status=&includePast=&page=` (thấy cả bản nháp và sự kiện đã hủy) |
| Quản trị: tạo/sửa/hủy sự kiện | `POST /api/admin/events`, `GET /api/admin/events/:id`, `PATCH /api/admin/events/:id` |
| Quản trị: hạng vé | `POST /api/admin/events/:id/ticket-types`, `PATCH /api/admin/ticket-types/:id` (kèm `seating`: `GENERAL` / `ASSIGNED`) |
| Quản trị: sơ đồ ghế | `GET /api/admin/events/:id/seat-map`, `GET /api/admin/events/:id/seats/status`, `PUT /api/admin/events/:id/seat-map` (kèm `version`), `PATCH /api/admin/events/:id/seats` (khóa/mở ghế), `POST /api/admin/events/:id/seat-map/copy-from/:sourceId` |
| Quản trị: hàng chờ | `GET` / `PUT /api/admin/events/:id/queue`, `POST /api/admin/events/:id/queue/tick` (nút "Chạy một nhịp") |
| Quản trị: tra cứu đơn | `GET /api/admin/orders?eventId=&status=&page=` (kèm `summary`), `GET /api/admin/orders/:id`, `POST /api/admin/orders/:id/cancel` |
| Quản trị: thống kê | `GET /api/admin/stats/daily?from=&to=`, `GET /api/admin/stats/events?from=&to=` |

Khi sửa sự kiện hay hạng vé, frontend chỉ gửi các trường đã thay đổi (backend dùng `PATCH`).

## 3. Phiên đăng nhập

- Token lưu trong `sessionStorage` theo hướng dẫn của backend: tải lại trang vẫn giữ phiên, đóng tab thì mất.
- Mỗi request gửi `Authorization: Bearer <token>`. Khi mở lại ứng dụng, frontend gọi `GET /api/me` để lấy vai trò mới nhất.
- Bất kỳ API nào trả **401** thì frontend xóa token, về trang đăng nhập và báo "Phiên đăng nhập đã hết hạn".
- **403** giữ nguyên phiên và báo không có quyền.
- Sau khi đăng nhập: `customer` vào `/events`, `admin` vào `/admin`.

## 4. Xử lý mã lỗi

Frontend hiển thị nguyên văn `error.message` của backend, trừ vài trường hợp cần câu dễ hiểu hơn:

| Mã lỗi | Màn hình | Frontend làm gì |
|---|---|---|
| `VALIDATION_ERROR` (`details: [{ path, message }]`) | Mọi form | Hiện lỗi dưới đúng ô theo `path` |
| `INVALID_CREDENTIALS` | Đăng nhập | "Sai tài khoản hoặc mật khẩu" |
| `SOLD_OUT`, `INSUFFICIENT_TICKETS` | Đặt vé | Báo hết vé hoặc số vé còn lại (`details.available`), tải lại số vé |
| `QUANTITY_EXCEEDS_LIMIT`, `EVENT_*` | Đặt vé | Câu của backend, ví dụ "Mỗi đơn được đặt tối đa 10 vé" |
| Mất mạng, quá 15 giây | Đặt vé | Báo mất kết nối. Khi khách bấm lại, frontend gửi **cùng `Idempotency-Key`** nên backend trả lại đơn cũ, không tạo đơn trùng |
| `ORDER_NOT_FOUND`, 400 do mã sai định dạng | Chi tiết đơn/sự kiện | "Không tìm thấy" (backend cố ý trả 404 cho đơn của người khác) |
| `ORDER_ALREADY_CANCELLED` | Hủy đơn | Tải lại đơn, báo đã hủy trước đó |
| `CANCELLATION_WINDOW_CLOSED` | Hủy đơn | Báo quá hạn hủy. Nút hủy cũng ẩn sẵn theo `canCancel` và hiện hạn hủy `cancellationDeadline` |
| `QUANTITY_BELOW_RESERVED` | Sửa hạng vé | Câu của backend + "Tối thiểu N vé" dưới ô số lượng (`details.reserved`) |
| `TICKET_TYPE_NAME_TAKEN` | Hạng vé | "Sự kiện đã có hạng vé cùng tên" dưới ô tên |
| `EVENT_CANCELLED` | Sửa sự kiện | Câu của backend; form của sự kiện đã hủy bị khóa |
| `SEAT_TAKEN`, `SEAT_BLOCKED` | Đặt ghế | Câu của backend ("Ghế A3 vừa có người đặt…"), bỏ các ghế trong `details.seatIds` khỏi lựa chọn, tải lại trạng thái ghế. Lần hỏi định kỳ thấy ghế đang chọn vừa bán hoặc bị khóa cũng tự bỏ ra và báo |
| `SEATS_NOT_FOUND` | Đặt ghế | Sơ đồ đã đổi: bỏ lựa chọn, tải lại sơ đồ |
| `SALE_NOT_STARTED`, `QUEUE_ADMISSION_REQUIRED` | Đặt vé (sự kiện có hàng chờ) | Quay lại trang chờ, báo lượt mua không còn hiệu lực |
| `QUEUE_ENTRY_NOT_FOUND` | Trang chờ | Chưa vào hàng: hiện nút "Vào hàng chờ" |
| `QUEUE_NOT_ENABLED` | Trang chờ | Quản trị viên vừa tắt hàng chờ: hiện form đặt vé luôn |
| `SEAT_MAP_VERSION_CONFLICT` | Lưu sơ đồ | "Sơ đồ vừa bị người khác sửa", tải lại bản mới nhất |
| `VALIDATION_ERROR` khi lưu sơ đồ | Lưu sơ đồ | Liệt kê từng lỗi trong `details` (ghế chồng nhau, ngoài khung, trùng nhãn) |
| `SEAT_SOLD_LOCKED` | Lưu sơ đồ, khóa ghế | Liệt kê ghế đã bán bị xóa/đổi hạng/khóa (`details.seats`) |
| `INVALID_SEAT_TICKET_TYPE` | Lưu sơ đồ | Nhắc chỉ gán ghế cho hạng "Chọn ghế trên sơ đồ" của sự kiện này |
| `TICKET_TYPE_MAPPING_FAILED` | Chép sơ đồ | Liệt kê tên hạng vé còn thiếu (`details.missing`) |
| `SEAT_MANAGED_QUANTITY`, `TICKET_TYPE_HAS_ORDERS`, `TICKET_TYPE_HAS_SEATS` | Hạng vé | Lỗi dưới ô số lượng / ô cách bán |
| `QUEUE_ALREADY_STARTED` | Cấu hình hàng chờ | Lỗi dưới ô giờ mở bán. Ô này bị khóa sẵn khi đã mở bán, và form gửi lại nguyên giờ cũ khi chỉ sửa các ô khác |
| `STATS_*` (502/503/504) | Thống kê | Lần đầu: báo lỗi kèm nút Thử lại. Khi tải lại: giữ số liệu cũ và hiện cảnh báo |
| `stale: true` trong phản hồi thống kê | Thống kê | Báo Azure không phản hồi, số liệu là bản lưu tạm |

## 5. Khi đưa lên Cloud Run

Phần này làm sau, khi đã chốt bản chạy trên máy.

1. **Backend** (Hoàng Quốc Dương): service `ticket-api` hiện chạy `AUTH_MODE=jwt` với bản code cũ, chưa có `POST /api/auth/login`. Cần triển khai bản code mới với `AUTH_MODE=local` và tạo tài khoản bằng job seed (mục 7.1, 7.3 của [README chung](../../README.md#7-triển-khai-lên-gcp-cloud-run--cloud-sql)). Kiểm tra: `curl https://ticket-api-5iqotxgmrq-as.a.run.app/health` phải có `"auth":"local"`.
2. **Frontend**: build image bằng `Dockerfile`, triển khai với biến `API_BASE_URL=https://ticket-api-5iqotxgmrq-as.a.run.app`.
3. **CORS**: `CORS_ORIGIN` của backend phải chứa đúng URL frontend. Hiện đã có `https://ticket-web-5iqotxgmrq-as.a.run.app` và `https://ticket-admin-5iqotxgmrq-as.a.run.app`, nên chỉ cần triển khai frontend vào một trong hai service này.
4. Chạy lại kịch bản kiểm thử trên URL thật: `E2E_BASE_URL=<URL frontend> E2E_MODE=api npm run e2e` (cần tài khoản `alice`, `bob`, `admin1` trên DB cloud, hoặc đặt `E2E_CUSTOMER_PASSWORD`, `E2E_ADMIN_PASSWORD`).

## 6. Sơ đồ ghế và hàng chờ ảo

Thiết kế phía backend: [`GHE-VA-HANG-CHO.md`](../../cloud-backend/docs/GHE-VA-HANG-CHO.md). Frontend làm theo mục 5 của tài liệu đó:

- **Sơ đồ** vẽ bằng SVG theo tọa độ backend trả về ([`SeatMap.tsx`](../src/components/SeatMap.tsx)), không cần thư viện. Màu ghế theo hạng vé, hạng đắt nhất nhận màu 1 của bảng màu phân loại đã kiểm tra mù màu; ghế đã bán có dấu ×, ghế khóa có viền đứt, ghế đang chọn có dấu ✓, nên không phân biệt chỉ bằng màu. Mỗi ghế đọc được bằng trình đọc màn hình ("Ghế A3 · Hạng A · 1.500.000 ₫ · còn trống") và chọn được bằng bàn phím.
- **Chọn ghế**: chỉ ghế cùng một hạng trong một đơn (bấm ghế hạng khác thì chuyển hạng), tối đa 10 ghế. Khóa chống đặt trùng tính theo hạng vé và tập ghế.
- **Hàng chờ** ([`QueueGate.tsx`](../src/pages/customer/QueueGate.tsx)): đếm ngược theo giờ máy chủ (`serverTime`), hỏi lại theo `retryAfterSeconds`, dừng khi backend trả `null`. Hết giờ mua hoặc tới giờ mở bán thì hỏi lại ngay. Mất mạng tạm thời thì thử lại sau 5 giây, giữ nguyên màn hình.
- **Quản trị** ([`SeatMapManager.tsx`](../src/pages/admin/SeatMapManager.tsx)): tạo nhanh từ mẫu ([`seatLayouts.ts`](../src/lib/seatLayouts.ts), cùng công thức nhà hát với `cloud-backend/src/seating/theater.ts`), nhập/xuất file JSON đúng mẫu body của `PUT seat-map`, xem trước rồi mới lưu.
- Backend giả có đủ các API trên. Hai sự kiện mẫu: `ev-108` (nhà hát 367 ghế, hàng chờ mở bán 2 phút sau khi tạo dữ liệu, có 6 người xếp hàng giả mua xong sau 20 giây) và `ev-109` (ghế thẳng, đặt ngay).
