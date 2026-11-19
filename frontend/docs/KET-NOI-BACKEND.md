# Kết nối frontend với backend

Frontend gọi **backend chung** trong thư mục `cloud-backend` (Vũ Ngọc Đức, Đoàn Việt Đức).
Hợp đồng API chính thức là [`cloud-backend/docs/API.md`](https://github.com/DucVu727/cloud-backend/blob/main/docs/API.md). Tài liệu này chỉ ghi frontend dùng API nào và xử lý từng mã lỗi ra sao.

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

Làm theo mục 1 trong [`cloud-backend/README.md`](https://github.com/DucVu727/cloud-backend/blob/main/README.md). Các biến cần cho frontend:

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
| Chi tiết + đặt vé | `GET /api/events/:id`, `POST /api/orders` kèm header `Idempotency-Key` |
| Vé của tôi | `GET /api/orders?status=&page=` |
| Chi tiết đơn + hủy | `GET /api/orders/:id`, `POST /api/orders/:id/cancel` (kèm lý do) |
| Quản trị: danh sách sự kiện | `GET /api/admin/events?status=&includePast=&page=` (thấy cả bản nháp và sự kiện đã hủy) |
| Quản trị: tạo/sửa/hủy sự kiện | `POST /api/admin/events`, `GET /api/admin/events/:id`, `PATCH /api/admin/events/:id` |
| Quản trị: hạng vé | `POST /api/admin/events/:id/ticket-types`, `PATCH /api/admin/ticket-types/:id` |
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
| `STATS_*` (502/503/504) | Thống kê | Lần đầu: báo lỗi kèm nút Thử lại. Khi tải lại: giữ số liệu cũ và hiện cảnh báo |
| `stale: true` trong phản hồi thống kê | Thống kê | Báo Azure không phản hồi, số liệu là bản lưu tạm |

## 5. Khi đưa lên Cloud Run

Phần này làm sau, khi đã chốt bản chạy trên máy.

1. **Backend** (Hoàng Quốc Dương): service `ticket-api` hiện chạy `AUTH_MODE=jwt` với bản code cũ, chưa có `POST /api/auth/login`. Cần triển khai bản code mới với `AUTH_MODE=local` và tạo tài khoản bằng job seed (mục 4.1, 4.3 của README backend). Kiểm tra: `curl https://ticket-api-5iqotxgmrq-as.a.run.app/health` phải có `"auth":"local"`.
2. **Frontend**: build image bằng `Dockerfile`, triển khai với biến `API_BASE_URL=https://ticket-api-5iqotxgmrq-as.a.run.app`.
3. **CORS**: `CORS_ORIGIN` của backend phải chứa đúng URL frontend. Hiện đã có `https://ticket-web-5iqotxgmrq-as.a.run.app` và `https://ticket-admin-5iqotxgmrq-as.a.run.app`, nên chỉ cần triển khai frontend vào một trong hai service này.
4. Chạy lại kịch bản kiểm thử trên URL thật: `E2E_BASE_URL=<URL frontend> E2E_MODE=api npm run e2e` (cần tài khoản `alice`, `bob`, `admin1` trên DB cloud, hoặc đặt `E2E_CUSTOMER_PASSWORD`, `E2E_ADMIN_PASSWORD`).
