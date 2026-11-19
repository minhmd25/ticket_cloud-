# Tài liệu API

Base URL: `http://localhost:3000/api`. Mọi request và response đều là JSON.

**Xác thực** dùng header `Authorization: Bearer <token>`. Lấy token từ `POST /auth/login` khi backend chạy `AUTH_MODE=local`. Khi chạy `AUTH_MODE=mock`, token thử có dạng `mock:<userId>:<customer|admin>`.

**Lỗi** luôn có dạng:

```json
{ "error": { "code": "SOLD_OUT", "message": "Hạng vé này đã hết", "details": { "requested": 1, "available": 0 } } }
```

**Phân trang**: query `page` (mặc định 1) và `limit` (mặc định 20, tối đa 100). Response trả kèm
`pagination: { page, limit, total, totalPages }`.

---

## 0. Đăng nhập và phiên dùng chung cho hai frontend

### `POST /auth/login`

Gửi `Content-Type: application/json`. Ví dụ dùng tài khoản mẫu chạy local.

```json
{ "username": "alice", "password": "DemoCustomer2026!" }
```

Tên đăng nhập phân biệt hoa thường, có từ 1 đến 100 ký tự thuộc nhóm chữ cái ASCII, chữ số, dấu gạch, chấm, gạch dưới hoặc `@`. Backend bỏ khoảng trắng ở hai đầu tên đăng nhập và giữ nguyên mật khẩu. Mật khẩu có từ 1 đến 256 ký tự.

**200 OK**

```json
{ "token": "<JWT>", "expiresIn": 3600, "userId": "alice", "role": "customer" }
```

`expiresIn` là số giây token có hiệu lực kể từ lúc cấp. Tài khoản quản trị nhận cùng cấu trúc với `"role": "admin"`.

**400** khi thiếu trường hoặc trường sai kiểu/định dạng.

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Vui lòng nhập tài khoản và mật khẩu hợp lệ" } }
```

**401** khi tài khoản hoặc mật khẩu sai. Hai trường hợp có cùng phản hồi.

```json
{ "error": { "code": "INVALID_CREDENTIALS", "message": "Tài khoản hoặc mật khẩu không đúng" } }
```

### `GET /me`

Gửi `Authorization: Bearer <JWT>`. **200 OK** trả mã người dùng và vai trò đang có hiệu lực.

```json
{ "userId": "alice", "role": "customer" }
```

**401** khi thiếu token, sai header, token sai hoặc token hết hạn.

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Chưa đăng nhập hoặc phiên không hợp lệ" } }
```

**403** khi dùng phiên khách hàng để gọi API quản trị.

```json
{ "error": { "code": "FORBIDDEN", "message": "Chỉ quản trị viên mới được thực hiện thao tác này" } }
```

### Xử lý trên frontend

1. Dùng cùng form đăng nhập. Điều hướng theo `role` sau khi nhận 200. `customer` vào danh sách sự kiện, `admin` vào trang quản trị. Với 400 hoặc 401 từ API đăng nhập, giữ form và hiển thị `error.message`.
2. Lưu token trong trạng thái phiên, có thể dùng `sessionStorage` để giữ phiên khi tải lại trong cùng tab. Gửi token qua header Bearer cho `/me`, `/orders` và `/admin/*`. Khi mở lại ứng dụng, gọi `/me` để cập nhật vai trò. Hai giao diện muốn dùng cùng phiên trong một tab cần chạy cùng origin.
3. Khi API được bảo vệ trả 401, xóa token và chuyển về trang đăng nhập. Khi nhận 403, giữ phiên và hiển thị lỗi quyền. Khi người dùng chọn đăng xuất, xóa token trong trạng thái phiên.
4. Khi xem hoặc hủy đơn nhận 404 `ORDER_NOT_FOUND`, hiển thị “Không tìm thấy đơn đặt vé”. Backend dùng `userId` lấy từ phiên cho toàn bộ API đặt, xem và hủy đơn của khách.

---

## 1. Công khai (không cần đăng nhập)

### `GET /events`
Danh sách sự kiện đang mở bán (PUBLISHED, chưa kết thúc).

| Query | Ý nghĩa |
|---|---|
| `category` | Lọc theo loại hình (`concert`, `sport`, `conference`, …) |
| `q` | Tìm theo tên sự kiện hoặc địa điểm |
| `from`, `to` | Khoảng thời gian bắt đầu (ISO 8601) |
| `includePast` | `true` để lấy cả sự kiện đã kết thúc |

```json
{
  "data": [{
    "id": "…", "title": "Đêm nhạc Mùa Đông 2026", "category": "concert", "venue": "Nhà hát Lớn Hà Nội",
    "startTime": "2026-12-11T12:00:00.000Z", "endTime": "…", "status": "PUBLISHED", "imageUrl": null,
    "minPrice": 350000, "maxPrice": 3000000, "totalAvailable": 348
  }],
  "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
}
```

### `GET /events/categories`
Các loại hình đang có sự kiện, dùng cho bộ lọc: `{ "data": [{ "category": "concert", "eventCount": 1 }] }`

### `GET /events/:eventId`
Chi tiết sự kiện kèm hạng vé, giá và số lượng còn lại. Trả 404 nếu sự kiện không tồn tại hoặc là DRAFT.

```json
{
  "id": "…", "title": "…", "category": "concert", "…": "…",
  "ticketTypes": [{
    "id": "…", "name": "VIP", "price": 1200000,
    "totalQuantity": 50, "availableQuantity": 49, "reservedQuantity": 1, "soldOut": false
  }]
}
```

---

## 2. Khách hàng (cần đăng nhập)

### `POST /orders`: đặt vé
```json
{ "ticketTypeId": "uuid", "quantity": 2 }
```
- Người đặt lấy từ token, giá lấy từ DB. Các trường `price`/`userId` mà client gửi kèm đều bị bỏ qua.
- Header tùy chọn `Idempotency-Key: <chuỗi>`: nếu gửi lại cùng key (ví dụ người dùng bấm hai lần), server trả về đơn cũ với mã 200 và không tạo đơn mới.
- Thành công: **201** kèm đối tượng đơn (xem bên dưới).

| Mã lỗi | HTTP | Khi nào |
|---|---|---|
| `SOLD_OUT` | 409 | Hạng vé đã hết |
| `INSUFFICIENT_TICKETS` | 409 | Số vé yêu cầu lớn hơn số còn lại; `details.available` cho biết số còn lại |
| `QUANTITY_EXCEEDS_LIMIT` | 422 | Vượt `MAX_TICKETS_PER_ORDER` |
| `EVENT_NOT_OPEN` / `EVENT_CANCELLED` / `EVENT_ALREADY_STARTED` | 409 | Sự kiện chưa mở bán, đã bị hủy hoặc đã diễn ra |
| `TICKET_TYPE_NOT_FOUND` | 404 | |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Dùng lại key cho một yêu cầu khác |

**Đối tượng đơn**
```json
{
  "id": "…", "userId": "alice", "status": "CONFIRMED", "quantity": 2,
  "unitPrice": 350000, "totalAmount": 700000, "currency": "VND",
  "event": { "id": "…", "title": "…", "category": "concert", "venue": "…", "startTime": "…", "status": "PUBLISHED" },
  "ticketType": { "id": "…", "name": "Thường" },
  "createdAt": "…", "cancelledAt": null, "cancelledBy": null, "cancelReason": null,
  "cancellationDeadline": "2026-12-10T12:00:00.000Z", "canCancel": true
}
```

### `GET /orders?status=CONFIRMED|CANCELLED`
Danh sách đơn **của người đang đăng nhập**, sắp xếp mới nhất trước.

### `GET /orders/:orderId`
Chi tiết đơn. Nếu đơn của người khác, server trả **404 `ORDER_NOT_FOUND`** để không tiết lộ đơn đó có tồn tại hay không.

### `POST /orders/:orderId/cancel`
Body tùy chọn: `{ "reason": "…" }`. Server cập nhật trạng thái và hoàn vé trong cùng một giao dịch.

| Mã lỗi | HTTP | Khi nào |
|---|---|---|
| `ORDER_ALREADY_CANCELLED` | 409 | Đơn đã hủy trước đó; vé **không** được hoàn thêm lần nữa |
| `CANCELLATION_WINDOW_CLOSED` | 422 | Còn ít hơn `CANCELLATION_DEADLINE_HOURS` giờ trước giờ diễn |
| `ORDER_NOT_FOUND` | 404 | Đơn không tồn tại hoặc là đơn của người khác |

Quy tắc hủy: khách được hủy khi còn ≥ N giờ trước giờ diễn. Admin luôn được hủy. Khi admin hủy cả sự kiện, mọi đơn còn hiệu lực được hủy tự động (xem `PATCH /admin/events/:id`), nên khách hủy lại sẽ nhận `409 ORDER_ALREADY_CANCELLED`.

---

## 3. Quản trị (role = admin)

Khách gọi các API này nhận **403 FORBIDDEN**, chưa đăng nhập nhận **401**.

| Method & path | Mô tả |
|---|---|
| `GET /admin/events?status=&category=&q=&includePast=` | Danh sách sự kiện mọi trạng thái |
| `POST /admin/events` | Tạo sự kiện, có thể kèm hạng vé |
| `GET /admin/events/:id` | Chi tiết, kể cả DRAFT |
| `PATCH /admin/events/:id` | Sửa một phần (title, description, category, venue, startTime, endTime, status, imageUrl). Response có thêm `cancelledOrders`. Xem "Hủy cả sự kiện" bên dưới |
| `POST /admin/events/:id/ticket-types` | Thêm hạng vé |
| `PATCH /admin/ticket-types/:id` | Sửa hạng vé (name, description, price, totalQuantity) |
| `GET /admin/orders?eventId=&status=&ticketTypeId=&userId=` | Tra đơn, trả kèm `summary` theo trạng thái |
| `GET /admin/orders/:id` | Chi tiết đơn bất kỳ |
| `POST /admin/orders/:id/cancel` | Hủy đơn, không bị giới hạn bởi hạn hủy |
| `GET /admin/outbox/stats` | Số sự kiện gửi Azure theo trạng thái PENDING/SENT/FAILED |
| `GET /admin/outbox?status=FAILED&limit=50` | Danh sách sự kiện outbox kèm lỗi gần nhất |
| `POST /admin/outbox/retry` | Body `{ "ids": [...] }` (bỏ trống để gửi lại tất cả). Đưa FAILED/PENDING về hàng đợi rồi gửi ngay. Bỏ qua dòng worker đang gửi dở; SENT không bao giờ gửi lại |
| `POST /admin/outbox/dispatch` | Chạy worker một lượt ngay lập tức |
| `GET /admin/stats/daily?from=&to=&eventId=` | Thống kê theo từng ngày, giờ VN. Đủ mọi ngày trong khoảng, mặc định 30 ngày gần nhất, tối đa 366 ngày |
| `GET /admin/stats/events?from=&to=` | Thống kê theo sự kiện, kèm `eventTitle` |
| `GET /admin/stats/events/:id?from=&to=` | Thống kê của một sự kiện, nằm ở trường `item` |
| `GET /admin/orders/:id/azure-sync` | Đối soát: Azure đã xử lý từng thông điệp của đơn chưa (`processedByAzure`) |

### Hủy cả sự kiện: `PATCH /admin/events/:id` với `status = CANCELLED`

```json
{ "status": "CANCELLED", "cancelReason": "Ca sĩ ốm" }
```

`cancelReason` không bắt buộc (mặc định "Sự kiện bị hủy") và chỉ dùng được cùng `status = CANCELLED`, nếu không sẽ nhận 400.
Trong **một giao dịch**, server:
1. Đổi trạng thái sự kiện thành `CANCELLED`. Từ lúc này đặt vé nhận `409 EVENT_CANCELLED`, và không mở lại sự kiện được.
2. Hủy mọi đơn `CONFIRMED` của sự kiện, với `cancelledBy` là admin và `cancelReason` như trên.
3. Hoàn vé về từng hạng vé.
4. Ghi một thông điệp `CANCELLED` sang Azure cho từng đơn, giống như khi hủy từng đơn.

Response là chi tiết sự kiện kèm `"cancelledOrders": <số đơn vừa hủy>`. Gọi lại với sự kiện đã `CANCELLED` trả `cancelledOrders: 0` và không sinh thêm bản ghi nào.
Đơn khách tự hủy cùng lúc chỉ được tính một lần, vé không bị hoàn hai lần.

**Tạo sự kiện**
```json
{
  "title": "Đêm nhạc", "description": "…", "category": "concert", "venue": "Nhà hát Lớn",
  "startTime": "2026-12-31T19:00:00+07:00", "endTime": "2026-12-31T22:00:00+07:00",
  "status": "DRAFT", "imageUrl": null,
  "ticketTypes": [{ "name": "VIP", "price": 1200000, "totalQuantity": 50 }]
}
```

Quy tắc kiểm tra dữ liệu:
- `price` ≥ 0, tối đa 2 chữ số thập phân
- `totalQuantity` là số nguyên ≥ 0
- `endTime` phải sau `startTime`
- Tên hạng vé không trùng trong cùng một sự kiện (trùng thì trả 409 `TICKET_TYPE_NAME_TAKEN`)
- `category` gồm chữ thường không dấu (ví dụ `concert`)
- Sự kiện đã CANCELLED thì không mở lại được

**Giảm số lượng vé**: nếu `totalQuantity` mới nhỏ hơn số vé đang được giữ trong các đơn CONFIRMED, server trả
`409 QUANTITY_BELOW_RESERVED` với `details: { requested, reserved }`.

**Thống kê**: số vé lấy từ Azure (chậm khoảng 1–2 phút), doanh thu lấy từ DB GCP (thời gian thực).

```json
{
  "source": "azure", "stale": false, "fetchedAt": "2026-11-12T07:40:01.000Z",
  "query": { "groupBy": "day", "from": "2026-10-14", "to": "2026-11-12", "fillGaps": true },
  "items": [{
    "key": "2026-11-12",
    "bookedTickets": 3, "cancelledTickets": 3, "bookedOrders": 1, "cancelledOrders": 1, "netTickets": 0,
    "bookedRevenue": 300000, "cancelledRevenue": 300000, "netRevenue": 0
  }],
  "totals": { "bookedTickets": 11, "…": "…", "netRevenue": 4900000 },
  "notes": { "tickets": "…", "revenue": "…" }
}
```

- Với `groupBy=day`, `key` là ngày `YYYY-MM-DD`. Với `groupBy=event`, `key` là `eventId` và có thêm `eventTitle`.
- `bookedOrders` / `cancelledOrders` là **số lần** đặt/hủy; các trường `...Tickets` là **số vé**.
- Khi Azure lỗi nhưng còn dữ liệu cũ trong cache, server trả về dữ liệu đó với `stale: true`.
- Tham số `from`/`to` có dạng `YYYY-MM-DD` và phải thỏa `from ≤ to`. Sai thì nhận 400 `VALIDATION_ERROR`.

| Mã lỗi | HTTP | Khi nào |
|---|---|---|
| `STATS_BAD_REQUEST` | 400 | Azure từ chối tham số |
| `STATS_UNAVAILABLE` | 503 | Không kết nối được Azure |
| `STATS_TIMEOUT` | 504 | Azure phản hồi quá chậm |
| `STATS_UPSTREAM_ERROR` | 502 | Azure trả lỗi 5xx hoặc dữ liệu không phải JSON |
| `STATS_AUTH_FAILED` | 502 | Sai key Azure |
| `STATS_NOT_FOUND` | 404 | Không có thống kê cho mục được hỏi |

---

## 4. Mã lỗi chung

| Mã | HTTP |
|---|---|
| `VALIDATION_ERROR` | 400. `details` là mảng `{ path, message }` |
| `INVALID_JSON` | 400 |
| `INVALID_CREDENTIALS` | 401 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `AUTH_SERVICE_UNAVAILABLE` | 503 |
| `INTERNAL_ERROR` | 500 |
