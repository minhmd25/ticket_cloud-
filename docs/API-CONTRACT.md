# Hợp đồng API giữa frontend và backend

> **Trạng thái:** bản đề xuất từ nhóm frontend (Ma Đức Minh, Nguyễn Quang Huy), cần hai bạn backend xác nhận.
> - Phần **Tài khoản**: Đoàn Việt Đức
> - Phần **Sự kiện, đơn, thống kê**: Vũ Ngọc Đức
> - Phần **CORS, biến môi trường**: Hoàng Quốc Dương (GCP)
>
> Frontend đang chạy với một backend giả viết đúng theo tài liệu này (`src/api/mock/server.ts`).
> Nếu backend thật làm khác, báo nhóm frontend để sửa ở một chỗ duy nhất: `src/api/index.ts`.

## 1. Quy ước chung

| Mục | Quy ước |
|---|---|
| Địa chỉ gốc | Mọi đường dẫn bắt đầu bằng `/api/...`. Frontend ghép với `API_BASE_URL`, ví dụ `https://backend-xxxx.a.run.app/api/events`. |
| Định dạng | JSON, UTF-8. Request có body thì gửi `Content-Type: application/json`. |
| Xác thực | Header `Authorization: Bearer <token>`. Token lấy từ API đăng nhập. |
| Thời gian | Chuỗi ISO 8601 có múi giờ, ví dụ `2026-11-21T13:00:00.000Z`. Frontend tự hiển thị theo giờ Việt Nam. |
| Tiền | Số nguyên, đơn vị VND (`1500000`). |
| Mã (id) | Chuỗi hoặc số đều được, frontend chỉ dùng để hiển thị và ghép vào URL. |
| Vai trò | `customer` hoặc `admin` (viết hoa `ADMIN` cũng được). |

### CORS (cấu hình trên backend GCP)

- `Access-Control-Allow-Origin`: URL của frontend trên Cloud Run (và `http://localhost:5173` khi phát triển).
- `Access-Control-Allow-Headers`: `Authorization, Content-Type`
- `Access-Control-Allow-Methods`: `GET, POST, PUT, OPTIONS`

### Định dạng lỗi

Mọi lỗi trả về mã HTTP phù hợp và body:

```json
{
  "error": {
    "code": "INSUFFICIENT_TICKETS",
    "message": "Hạng vé \"Cự ly 42 km\" chỉ còn 5 vé.",
    "details": { "quantity": "..." }
  }
}
```

- `message` viết bằng tiếng Việt, frontend hiển thị nguyên văn cho người dùng.
- `details` không bắt buộc, chỉ dùng cho lỗi dữ liệu nhập: key là tên trường, value là câu báo lỗi. Frontend hiện câu đó ngay dưới ô nhập tương ứng.
- Không bao giờ trả mật khẩu hoặc mật khẩu đã băm.

| HTTP | `code` | Khi nào | Frontend xử lý |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | Thiếu trường, sai kiểu, giá âm, số lượng không hợp lệ | Hiện lỗi dưới từng ô theo `details` |
| 401 | `INVALID_CREDENTIALS` | Đăng nhập sai tài khoản/mật khẩu | Báo "Sai tài khoản hoặc mật khẩu" |
| 401 | `UNAUTHENTICATED`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | Thiếu, sai hoặc hết hạn token | Tự đăng xuất, về trang đăng nhập, báo "Phiên đăng nhập đã hết hạn" |
| 403 | `FORBIDDEN` | Khách gọi API quản trị; admin gọi API đặt vé | Báo không có quyền |
| 404 | `EVENT_NOT_FOUND`, `TICKET_TYPE_NOT_FOUND`, `ORDER_NOT_FOUND` | Không tồn tại, **hoặc đơn không thuộc người đang đăng nhập** | Hiện "Không tìm thấy" |
| 409 | `SOLD_OUT` | Hạng vé đã hết | Báo hết vé, tải lại số vé còn lại |
| 409 | `INSUFFICIENT_TICKETS` | Số lượng yêu cầu lớn hơn số còn lại | Hiện `message`, tải lại số vé |
| 409 | `EVENT_CLOSED` | Đặt vé cho sự kiện đã diễn ra | Báo không thể đặt |
| 409 | `ALREADY_CANCELLED` | Hủy đơn đã hủy (không được hoàn vé lần nữa) | Tải lại đơn, báo đã hủy trước đó |
| 409 | `CANCEL_NOT_ALLOWED` | Không thỏa điều kiện hủy nhóm chốt (ví dụ sự kiện đã diễn ra) | Hiện `message` |
| 409 | `QUANTITY_BELOW_BOOKED` | Admin giảm số vé mở bán xuống dưới số vé đã đặt | Hiện `message` trong khu quản lý hạng vé |
| 5xx | bất kỳ | Lỗi máy chủ | Báo lỗi chung, có nút Thử lại |

Khi không gọi được máy chủ (mất mạng, sai CORS, quá 15 giây), frontend báo "mất kết nối".

---

## 2. Tài khoản (Đoàn Việt Đức)

### `POST /api/auth/login`

Không cần token.

```json
// request
{ "username": "khach", "password": "khach123" }

// 200
{
  "token": "eyJhbGciOi...",
  "user": { "id": "u1", "username": "khach", "role": "customer", "fullName": "Nguyễn Văn An" }
}
```

Lỗi: `400 VALIDATION_ERROR` (thiếu trường, `details.username` / `details.password`), `401 INVALID_CREDENTIALS`.

> Frontend chấp nhận cả `accessToken` hoặc `access_token` thay cho `token`. Nếu không có `user`, frontend sẽ gọi thêm `GET /api/auth/me`.

### `GET /api/auth/me`

Cần token. Trả thông tin tài khoản đang đăng nhập (dùng để kiểm tra phiên khi tải lại trang).

```json
{ "id": "u1", "username": "khach", "role": "customer", "fullName": "Nguyễn Văn An" }
```

### Tài khoản mẫu cho cả nhóm

| Vai trò | Tài khoản | Mật khẩu |
|---|---|---|
| Khách hàng | `khach` | `khach123` |
| Quản trị viên | `admin` | `admin123` |

(Backend giả có thêm `khach2`, `khach3` cùng mật khẩu `khach123` để thử quyền sở hữu đơn.)

---

## 3. Sự kiện (Vũ Ngọc Đức)

### `GET /api/events?category=concert|sports|musical`

`category` không bắt buộc. Trả danh sách, sắp xếp theo thời gian diễn ra tăng dần.

```json
[
  {
    "id": "ev-101",
    "name": "Đêm nhạc Mùa Thu Hà Nội",
    "category": "concert",
    "startTime": "2026-11-21T13:00:00.000Z",
    "venue": "Cung Văn hóa Hữu nghị Việt Xô, Hà Nội"
  }
]
```

### `GET /api/events/{id}`

```json
{
  "id": "ev-101",
  "name": "Đêm nhạc Mùa Thu Hà Nội",
  "category": "concert",
  "description": "Đêm nhạc acoustic ...",
  "startTime": "2026-11-21T13:00:00.000Z",
  "venue": "Cung Văn hóa Hữu nghị Việt Xô, Hà Nội",
  "ticketTypes": [
    { "id": "tt-1011", "eventId": "ev-101", "name": "VIP", "price": 1500000, "totalQuantity": 60, "remainingQuantity": 44 }
  ]
}
```

`totalQuantity` = số vé mở bán. `remainingQuantity` = `totalQuantity` − tổng số vé của các đơn còn hiệu lực.

---

## 4. Đơn đặt vé của khách (Vũ Ngọc Đức)

Tất cả cần token. Người đặt **luôn lấy từ token**, không lấy từ body.

### Đối tượng `Order`

```json
{
  "id": "DH1073",
  "eventId": "ev-105",
  "eventName": "Giải chạy Marathon Hồ Tây",
  "eventStartTime": "2026-11-17T22:30:00.000Z",
  "ticketTypeId": "tt-1052",
  "ticketTypeName": "Cự ly 42 km",
  "quantity": 2,
  "unitPrice": 800000,
  "totalAmount": 1600000,
  "status": "CONFIRMED",
  "createdAt": "2026-11-11T16:20:00.000Z",
  "cancelledAt": null,
  "userId": "u1",
  "username": "khach"
}
```

`status`: `CONFIRMED` (đã xác nhận) hoặc `CANCELLED` (đã hủy).

### `POST /api/orders` → `201 Order`

```json
{ "ticketTypeId": "tt-1052", "quantity": 2 }
```

Giá lấy từ cơ sở dữ liệu. Lỗi: `400 VALIDATION_ERROR`, `404 TICKET_TYPE_NOT_FOUND`, `409 SOLD_OUT`, `409 INSUFFICIENT_TICKETS`, `409 EVENT_CLOSED`, `403 FORBIDDEN` (tài khoản admin).

### `GET /api/orders` → `Order[]`

Các đơn của tài khoản đang đăng nhập, mới nhất trước.

### `GET /api/orders/{id}` → `Order`

Đơn không thuộc người đang đăng nhập trả `404 ORDER_NOT_FOUND` (không lộ thông tin đơn của người khác).

### `POST /api/orders/{id}/cancel` → `200 Order` (đơn sau khi hủy)

Không có body. Lỗi: `404 ORDER_NOT_FOUND`, `409 ALREADY_CANCELLED`, `409 CANCEL_NOT_ALLOWED`.
Frontend chỉ đổi trạng thái đơn trên màn hình sau khi nhận được phản hồi thành công.

---

## 5. Quản trị (Vũ Ngọc Đức, kiểm tra quyền bằng module của Đoàn Việt Đức)

Tất cả cần token của tài khoản `admin`; tài khoản khác nhận `403 FORBIDDEN`.

### `POST /api/admin/events` → `201 EventDetail`
### `PUT /api/admin/events/{id}` → `200 EventDetail`

```json
{
  "name": "Hòa nhạc Giáng sinh",
  "category": "concert",
  "description": "Mô tả (không bắt buộc, tối đa 2000 ký tự)",
  "startTime": "2026-12-24T13:00:00.000Z",
  "venue": "Nhà hát Hòa Bình, TP. Hồ Chí Minh"
}
```

`400 VALIDATION_ERROR` với `details` theo tên trường: `name`, `category`, `startTime`, `venue`, `description`.

### `POST /api/admin/events/{eventId}/ticket-types` → `201 TicketType`
### `PUT /api/admin/ticket-types/{id}` → `200 TicketType`

```json
{ "name": "VIP", "price": 1500000, "totalQuantity": 50 }
```

- `price`: số nguyên ≥ 0. `totalQuantity`: số nguyên > 0.
- Khi sửa, nếu `totalQuantity` nhỏ hơn số vé đang được giữ trong các đơn còn hiệu lực:
  `409 QUANTITY_BELOW_BOOKED`, `message` ghi rõ số vé đã đặt, ví dụ
  "Không thể giảm số lượng xuống 5 vì đã có 20 vé được đặt trong các đơn còn hiệu lực."

### `GET /api/admin/orders?eventId=&status=` → `Order[]`

Cả hai tham số không bắt buộc. `status` là `CONFIRMED` hoặc `CANCELLED`. Mới nhất trước.

### `GET /api/admin/orders/{id}` → `Order`

---

## 6. Thống kê (backend GCP gọi sang API thống kê trên Azure của Trương Gia Sinh)

### `GET /api/admin/stats?groupBy=day|event&from=YYYY-MM-DD&to=YYYY-MM-DD`

- `from`, `to`: ngày theo **giờ Việt Nam**, tính cả hai đầu.
- `groupBy=day`: trả đủ mọi ngày trong khoảng, kể cả ngày bằng 0.
- `groupBy=event`: mỗi sự kiện có phát sinh đặt/hủy trong khoảng là một dòng.
- `booked` = tổng **số vé** của thông điệp đặt trong ngày đó; `cancelled` = tổng số vé của thông điệp hủy trong ngày đó (tính theo thời điểm hủy, không theo ngày đặt). Thông điệp gửi lại không được cộng thêm.

```json
{
  "groupBy": "day",
  "from": "2026-10-29",
  "to": "2026-11-11",
  "items": [
    { "key": "2026-11-10", "label": "10/11", "booked": 13, "cancelled": 0 },
    { "key": "2026-11-11", "label": "11/11", "booked": 15, "cancelled": 4 }
  ],
  "totals": { "booked": 212, "cancelled": 33 },
  "generatedAt": "2026-11-11T16:30:29.000Z"
}
```

Với `groupBy=event`, `key` là mã sự kiện và `label` là tên sự kiện.
Khi không gọi được Azure, backend GCP trả `502` hoặc `503` kèm `error.message`; frontend giữ số liệu lần trước và hiện cảnh báo.

---

## 7. Màn hình nào gọi API nào

| Màn hình | API |
|---|---|
| Đăng nhập (chung) | `POST /api/auth/login`, `GET /api/auth/me` |
| Danh sách sự kiện | `GET /api/events?category=` |
| Chi tiết + đặt vé | `GET /api/events/{id}`, `POST /api/orders` |
| Vé của tôi | `GET /api/orders` |
| Chi tiết đơn + hủy | `GET /api/orders/{id}`, `POST /api/orders/{id}/cancel` |
| Quản trị: danh sách sự kiện | `GET /api/events` |
| Quản trị: tạo/sửa sự kiện | `POST /api/admin/events`, `PUT /api/admin/events/{id}`, `GET /api/events/{id}` |
| Quản trị: hạng vé | `POST /api/admin/events/{id}/ticket-types`, `PUT /api/admin/ticket-types/{id}` |
| Quản trị: tra cứu đơn | `GET /api/admin/orders`, `GET /api/admin/orders/{id}` |
| Quản trị: thống kê | `GET /api/admin/stats` |
