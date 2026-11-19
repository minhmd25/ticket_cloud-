# Báo cáo module tài khoản và phân quyền

**Hệ thống đặt vé đa sự kiện · Bài tập lớn môn Cloud · Nhóm 5**

**Người thực hiện** Đoàn Việt Đức

## 1. Phạm vi

Module tài khoản chạy trong backend Express chung trên GCP và dùng PostgreSQL cùng với module đặt vé. Giao diện khách hàng và giao diện quản trị dùng chung API đăng nhập. Backend kiểm tra quyền trên các API quản lý sự kiện, hạng vé, đơn đặt và thống kê. Dịch vụ Azure tiếp tục nhận thông điệp đặt/hủy từ backend GCP để tổng hợp thống kê.

## 2. Thiết kế dữ liệu và phiên

Migration [`004_accounts.sql`](../migrations/004_accounts.sql) tạo bảng `accounts`.

| Trường | Kiểu | Mục đích |
|---|---|---|
| `user_id` | `VARCHAR(100)` | Khóa chính và mã ổn định dùng trong phiên, đơn vé và nhật ký thao tác |
| `username` | `VARCHAR(100)` | Tên đăng nhập duy nhất |
| `password_hash` | `TEXT` | Kết quả băm scrypt, có salt ngẫu nhiên riêng cho mỗi mật khẩu |
| `role` | `TEXT` | Vai trò được ràng buộc ở PostgreSQL, gồm `customer` và `admin` |

Backend đối chiếu mật khẩu với giá trị băm bằng phép so sánh an toàn theo thời gian. Khi đăng nhập thành công, backend cấp JWT ký HS256 với mã người dùng, bên phát hành, đối tượng nhận và thời điểm hết hạn. Thời hạn mặc định là 3.600 giây. Cấu hình scrypt dùng `N = 2^15`, `r = 8` và `p = 3`. [Node.js Crypto](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) · [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt)

## 3. Luồng xử lý và tích hợp

1. `POST /api/auth/login` nhận `username` và `password`. Backend kiểm tra đầu vào, tìm tài khoản theo truy vấn tham số hóa và xác thực mật khẩu. Phản hồi thành công chỉ gồm `token`, `expiresIn`, `userId` và `role`.
2. Frontend gửi token qua `Authorization: Bearer <token>`. Middleware kiểm tra chữ ký và hạn token, đọc tài khoản hiện tại từ PostgreSQL rồi gắn `req.user`. `GET /api/me` trả `userId` và `role` để frontend khôi phục phiên và điều hướng.
3. `requireAuth` áp dụng cho thao tác với đơn cá nhân. `requireAdmin` bảo vệ toàn bộ nhóm route `/api/admin`, bao gồm tạo/sửa sự kiện và hạng vé. Lỗi phiên trả 401 với mã `UNAUTHORIZED`, lỗi thiếu quyền trả 403 với mã `FORBIDDEN`.
4. Module đặt vé tiếp tục dùng `currentUser(req)` để lấy mã người đặt. Khi khách xem hoặc hủy, dịch vụ so sánh mã đã xác thực với `orders.user_id` và trả 404 nếu đơn thuộc tài khoản khác. Kiểu mã hiện tại tương thích với dữ liệu đơn đã có và các bộ xác thực `mock`, `jwt`, `http`.

## 4. Kiểm thử

Các ca tích hợp chạy qua Express, PostgreSQL và provider `local` trong [`tests/auth.test.ts`](../tests/auth.test.ts).

| Kịch bản | Kết quả kiểm tra |
|---|---|
| Seed hai vai trò và chạy lại seed | Tạo đúng hai tài khoản, lưu hash với salt riêng, giữ mật khẩu khi chạy lại |
| Đăng nhập đúng và lấy hồ sơ | 200 cho cả hai vai trò, payload đúng cấu trúc đã công bố |
| Thiếu trường, sai tài khoản hoặc sai mật khẩu | 400 cho đầu vào thiếu/sai định dạng, cùng lỗi 401 cho tài khoản và mật khẩu sai |
| Truy cập với phiên thiếu, sai hoặc hết hạn | 401 trên API yêu cầu đăng nhập |
| Khách và quản trị gọi API quản trị | Khách nhận 403, quản trị tạo/sửa sự kiện và chỉnh hạng vé thành công |
| Vai trò đổi hoặc tài khoản bị xóa | Middleware áp dụng vai trò hiện tại và từ chối token của tài khoản đã xóa |
| Đặt, xem và hủy đơn | Mã người đặt lấy từ phiên. Khách khác nhận 404. Chủ đơn xem và hủy được |

`npm run typecheck` và `npm run build` thành công. Bộ test trên PostgreSQL 16 đạt **62/62** với `npm test -- --pool=threads`, gồm 7 ca tài khoản. Kiểm tra thêm bằng cách chạy seed, khởi động server đã build, đăng nhập bằng hai tài khoản mẫu, gọi `/api/me` và kiểm tra quyền quản trị cùng các đơn mẫu của `alice`.

## 5. Bàn giao

- **Frontend khách hàng và quản trị** dùng chung hợp đồng JSON, Bearer token và cách xử lý 401/403. [Tài liệu API có request và response mẫu](API.md#0-đăng-nhập-và-phiên-dùng-chung-cho-hai-frontend)
- **Backend đặt vé** dùng `req.user.userId` đã xác thực để lưu và kiểm tra chủ đơn. Tài khoản mẫu `alice` dùng cùng mã với các đơn mẫu có sẵn.
- **Triển khai GCP** cấu hình `AUTH_MODE=local`, khóa `AUTH_JWT_SECRET` trong Secret Manager, TTL và danh sách origin của hai frontend. Container chạy migration khi khởi động. Job seed nhận hai mật khẩu demo từ Secret Manager. [Hướng dẫn chạy và cấu hình triển khai](../../README.md#7-triển-khai-lên-gcp-cloud-run--cloud-sql)

Kết quả trên được kiểm tra cục bộ. Bước tích hợp hai giao diện và chạy thử trên URL Cloud Run thuộc đợt bàn giao của nhóm. [Bảng phân công Nhóm 5](https://docs.google.com/spreadsheets/d/1J7uSD8GY6_0IlaUtZk8fHN6T4O6KUL6dZINfPs9aJj0/edit#gid=1096500465)
