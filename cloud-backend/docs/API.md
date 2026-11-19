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
    "id": "…", "name": "VIP", "price": 1200000, "seating": "ASSIGNED",
    "totalQuantity": 50, "availableQuantity": 49, "reservedQuantity": 1, "soldOut": false
  }],
  "seatMap": { "version": 3 },
  "queue": { "enabled": true, "saleStartAt": "2026-12-01T13:00:00.000Z", "maxActive": 200, "accessMinutes": 10 }
}
```

- `seating`: `GENERAL` là vé bán theo số lượng như cũ. `ASSIGNED` là vé chọn ghế trên sơ đồ (xem mục 5).
- `seatMap`: `null` nếu sự kiện chưa có sơ đồ ghế.
- `queue`: `null` nếu sự kiện không dùng hàng chờ. Khi `enabled = true`, khách phải xếp hàng trước khi đặt vé (xem mục 6).

### `GET /events/:eventId/seat-map` và `GET /events/:eventId/seats/status`
Sơ đồ ghế và trạng thái ghế cho khách. Xem mục 5.

---

## 2. Khách hàng (cần đăng nhập)

### `POST /orders`: đặt vé
Vé thường (hạng `GENERAL`):
```json
{ "ticketTypeId": "uuid", "quantity": 2 }
```
Vé chọn ghế (hạng `ASSIGNED`): gửi danh sách ghế, `quantity` có thể bỏ, nếu gửi thì phải bằng số ghế.
```json
{ "ticketTypeId": "uuid", "seatIds": ["uuid-ghế-A3", "uuid-ghế-A4"] }
```
- Người đặt lấy từ token, giá lấy từ DB. Các trường `price`/`userId` mà client gửi kèm đều bị bỏ qua.
- **Mỗi đơn chỉ gồm ghế của một hạng vé.** Muốn mua ghế ở hai hạng thì đặt hai đơn.
- Đặt ghế theo nguyên tắc **đủ hết hoặc không**: chỉ cần một ghế đã có người đặt là cả đơn bị từ chối (`409 SEAT_TAKEN`) và không giữ ghế nào.
- Không có bước giữ ghế tạm thời: ghế thuộc về người đặt thành công trước.
- Sự kiện bật hàng chờ: khách phải ở trạng thái `ADMITTED` (mục 6). Đặt thành công thì lượt xếp hàng chuyển `COMPLETED`.
- Header tùy chọn `Idempotency-Key: <chuỗi>`: nếu gửi lại cùng key (ví dụ người dùng bấm hai lần), server trả về đơn cũ với mã 200 và không tạo đơn mới. Với vé chọn ghế, "cùng yêu cầu" nghĩa là cùng hạng vé và cùng tập ghế (thứ tự không quan trọng).
- Thành công: **201** kèm đối tượng đơn (xem bên dưới).

| Mã lỗi | HTTP | Khi nào |
|---|---|---|
| `SOLD_OUT` | 409 | Hạng vé đã hết |
| `INSUFFICIENT_TICKETS` | 409 | Số vé yêu cầu lớn hơn số còn lại; `details.available` cho biết số còn lại |
| `QUANTITY_EXCEEDS_LIMIT` | 422 | Vượt `MAX_TICKETS_PER_ORDER` (tính cả số ghế) |
| `EVENT_NOT_OPEN` / `EVENT_CANCELLED` / `EVENT_ALREADY_STARTED` | 409 | Sự kiện chưa mở bán, đã bị hủy hoặc đã diễn ra |
| `TICKET_TYPE_NOT_FOUND` | 404 | |
| `IDEMPOTENCY_KEY_REUSED` | 422 | Dùng lại key cho một yêu cầu khác |
| `SEATS_REQUIRED` | 422 | Hạng vé `ASSIGNED` mà không gửi `seatIds` |
| `SEATS_NOT_ALLOWED` | 422 | Hạng vé `GENERAL` mà lại gửi `seatIds` |
| `SEATS_NOT_FOUND` | 422 | Có ghế không thuộc sơ đồ của sự kiện; `details.seatIds` |
| `SEAT_TICKET_TYPE_MISMATCH` | 422 | Có ghế thuộc hạng vé khác; `details.labels` |
| `SEAT_BLOCKED` | 409 | Có ghế bị admin khóa; `details.seatIds`, `details.labels` |
| `SEAT_TAKEN` | 409 | Có ghế vừa bị người khác đặt; `details.seatIds`, `details.labels`. Frontend tải lại trạng thái ghế và cho khách chọn lại |
| `SALE_NOT_STARTED` | 409 | Sự kiện bật hàng chờ và chưa tới giờ mở bán; `details.saleStartAt` |
| `QUEUE_ADMISSION_REQUIRED` | 409 | Sự kiện bật hàng chờ mà khách chưa tới lượt, hết giờ mua hoặc đã dùng lượt; `details.queueStatus` (`null`, `WAITING`, `EXPIRED`, `COMPLETED`, `LEFT`) |

Lỗi `400 VALIDATION_ERROR` khi thiếu cả `quantity` lẫn `seatIds`, `seatIds` rỗng hoặc trùng, hoặc `quantity` khác số ghế.

**Đối tượng đơn**
```json
{
  "id": "…", "userId": "alice", "status": "CONFIRMED", "quantity": 2,
  "unitPrice": 350000, "totalAmount": 700000, "currency": "VND",
  "event": { "id": "…", "title": "…", "category": "concert", "venue": "…", "startTime": "…", "status": "PUBLISHED" },
  "ticketType": { "id": "…", "name": "Thường" },
  "seats": [{ "id": "…", "label": "A3" }, { "id": "…", "label": "A4" }],
  "createdAt": "…", "cancelledAt": null, "cancelledBy": null, "cancelReason": null,
  "cancellationDeadline": "2026-12-10T12:00:00.000Z", "canCancel": true
}
```
`seats` là `[]` với vé thường. Đơn đã hủy vẫn giữ danh sách ghế đã đặt để hiển thị lịch sử, nhưng các ghế đó đã được trả lại để bán tiếp.

### `GET /orders?status=CONFIRMED|CANCELLED`
Danh sách đơn **của người đang đăng nhập**, sắp xếp mới nhất trước.

### `GET /orders/:orderId`
Chi tiết đơn. Nếu đơn của người khác, server trả **404 `ORDER_NOT_FOUND`** để không tiết lộ đơn đó có tồn tại hay không.

### `POST /orders/:orderId/cancel`
Body tùy chọn: `{ "reason": "…" }`. Server cập nhật trạng thái, hoàn vé và trả ghế (nếu có) trong cùng một giao dịch.

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
| `POST /admin/events/:id/ticket-types` | Thêm hạng vé. `seating` = `GENERAL` (mặc định) hoặc `ASSIGNED` |
| `PATCH /admin/ticket-types/:id` | Sửa hạng vé (name, description, price, totalQuantity, seating) |
| `GET /admin/events/:id/seat-map` | Sơ đồ ghế, kể cả sự kiện DRAFT (mục 5) |
| `PUT /admin/events/:id/seat-map` | Lưu toàn bộ sơ đồ ghế (mục 5) |
| `PATCH /admin/events/:id/seats` | Khóa / mở khóa ghế (mục 5) |
| `POST /admin/events/:id/seat-map/copy-from/:sourceEventId` | Chép sơ đồ từ sự kiện khác (mục 5) |
| `GET /admin/events/:id/seats/status` | Trạng thái ghế, kể cả sự kiện DRAFT |
| `GET` / `PUT /admin/events/:id/queue` | Xem / sửa cấu hình hàng chờ, kèm số người theo trạng thái (mục 6) |
| `POST /admin/events/:id/queue/tick` | Chạy worker hàng chờ một nhịp ngay, dùng khi demo |
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

**Hạng vé theo ghế** (`seating = ASSIGNED`):
- Tạo hạng: `{ "name": "Hạng A", "price": 1500000, "seating": "ASSIGNED" }`. Không gửi `totalQuantity` (hoặc gửi 0). Hạng mới có 0 vé cho tới khi được gán ghế trên sơ đồ.
- `totalQuantity` = số ghế **không bị khóa** của hạng, backend tự tính lại mỗi khi lưu sơ đồ hoặc khóa/mở ghế. Sửa tay thì nhận `409 SEAT_MANAGED_QUANTITY`.
- Đổi `seating` chỉ được khi hạng chưa có đơn (`409 TICKET_TYPE_HAS_ORDERS`). Đổi từ `ASSIGNED` sang `GENERAL` cần gỡ hết ghế của hạng khỏi sơ đồ trước (`409 TICKET_TYPE_HAS_SEATS`). Sau khi đổi, tổng vé về 0, có thể gửi kèm `totalQuantity` trong cùng request khi đổi sang `GENERAL`.

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
| `PAYLOAD_TOO_LARGE` | 413. Body vượt 100 KB (riêng `PUT /admin/events/:id/seat-map` cho phép 2 MB) |
| `INVALID_CREDENTIALS` | 401 |
| `UNAUTHORIZED` | 401 |
| `FORBIDDEN` | 403 |
| `AUTH_SERVICE_UNAVAILABLE` | 503 |
| `INTERNAL_ERROR` | 500 |

---

## 5. Sơ đồ ghế

Thiết kế và hướng dẫn vẽ sơ đồ ở frontend: [GHE-VA-HANG-CHO.md](GHE-VA-HANG-CHO.md).

- Mỗi sự kiện có tối đa **một** sơ đồ. Ghế là các điểm tọa độ tự do `(x, y)` kèm góc xoay, không bắt buộc theo lưới, nên vẽ được hàng ghế cong, khán đài lệch...
- Tọa độ tính trên một khung `width × height` (đơn vị tùy ý; frontend co giãn khi vẽ, ví dụ dùng SVG `viewBox="0 0 width height"`). Trục y hướng xuống.
- Mỗi ghế là hình tròn đường kính `seatSize` (mặc định 24) có tâm tại `(x, y)`. `rotation` tính bằng độ, chiều kim đồng hồ, 0 là ghế quay mặt lên trên (về phía y nhỏ).
- **Nhãn ghế** (`label`, ví dụ `C12`) không trùng trong một sự kiện và là khóa để nhận ra ghế giữa các lần lưu: lưu lại sơ đồ giữ nguyên `id` của ghế cùng nhãn.
- Ghế chỉ được gán cho hạng vé `seating = ASSIGNED` của chính sự kiện đó.

### `GET /events/:eventId/seat-map` (công khai)

Chỉ sự kiện `PUBLISHED`. Response có header `ETag: W/"seat-map-v<version>"` và `Cache-Control: no-cache`.
Gửi lại header `If-None-Match` với ETag đã có thì nhận **304** (không có body) khi sơ đồ chưa đổi.

```json
{
  "eventId": "…", "version": 3, "width": 1200, "height": 782, "seatSize": 24,
  "sections": [{ "key": "giua", "name": "Khu giữa", "color": "#F58518" }],
  "decorations": [{ "type": "stage", "x": 400, "y": 0, "width": 400, "height": 60, "label": "SÂN KHẤU" }],
  "seats": [{
    "id": "…", "label": "A1", "row": "A", "section": "trai", "ticketTypeId": "…",
    "x": 436.17, "y": 174.72, "rotation": 55, "accessible": false, "blocked": false
  }],
  "updatedAt": "…"
}
```

- `section` là `key` của khu (hoặc `null`). `decorations` là các hình trang trí do admin tự đặt, backend chỉ lưu lại (mỗi phần tử bắt buộc có `type`, các trường khác tùy frontend thống nhất).
- Lỗi: `404 EVENT_NOT_FOUND` (sự kiện không có hoặc chưa công khai), `404 SEAT_MAP_NOT_FOUND` (chưa có sơ đồ).

### `GET /events/:eventId/seats/status` (công khai)

Trạng thái ghế, đổi liên tục nên `Cache-Control: no-store`. Frontend gọi lại định kỳ (khoảng 5–10 giây) khi đang mở trang chọn ghế, và gọi ngay sau khi nhận `SEAT_TAKEN`.

```json
{ "eventId": "…", "version": 3, "sold": ["id-ghế", "…"], "blocked": ["id-ghế"] }
```

- Ghế không nằm trong `sold` lẫn `blocked` là ghế còn trống.
- `version` khác version của sơ đồ đang hiển thị thì tải lại sơ đồ.

### `PUT /admin/events/:eventId/seat-map`

Lưu **toàn bộ** sơ đồ (thay thế bản cũ). Body tối đa 2 MB, tối đa 5000 ghế.

```json
{
  "version": 0,
  "width": 1200, "height": 800, "seatSize": 24,
  "sections": [{ "key": "giua", "name": "Khu giữa", "color": "#F58518" }],
  "seats": [
    { "label": "A1", "row": "A", "section": "giua", "ticketTypeId": "…", "x": 100, "y": 200, "rotation": 0, "accessible": false, "blocked": false }
  ],
  "decorations": [{ "type": "stage", "x": 400, "y": 0, "width": 400, "height": 60, "label": "SÂN KHẤU" }]
}
```

| Trường | Ràng buộc |
|---|---|
| `version` | Version hiện tại mà admin đang sửa, `0` nếu sự kiện chưa có sơ đồ. Sai thì nhận `409 SEAT_MAP_VERSION_CONFLICT` với `details: { currentVersion, yourVersion }`: có người khác vừa sửa, tải lại rồi sửa tiếp |
| `width`, `height` | Số nguyên 100–20000 |
| `seatSize` | Số > 0, tối đa 500. Mặc định 24 |
| `sections[]` | Tối đa 100. `key` gồm chữ không dấu, số, `-`, `_` (tối đa 50 ký tự), không trùng. `color` dạng `#RRGGBB`, tùy chọn |
| `seats[]` | Tối đa 5000. `label` 1–20 ký tự, không trùng. `row` tối đa 20 ký tự. `section` phải là một `key` có trong `sections`. `rotation` từ -360 đến 360. `accessible`, `blocked` mặc định `false` |
| `decorations[]` | Tối đa 200 phần tử, mỗi phần tử có `type` (1–30 ký tự), tổng dung lượng tối đa khoảng 200 KB |

Backend kiểm tra thêm:
- Mỗi ghế (hình tròn đường kính `seatSize`) nằm trọn trong khung.
- Không hai ghế nào chồng nhau (khoảng cách tâm nhỏ hơn `seatSize`). Hai ghế sát nhau vừa đúng bằng đường kính thì hợp lệ.

Vi phạm thì nhận `400 VALIDATION_ERROR`, `details` là danh sách tối đa 20 lỗi `{ path, message }`, ví dụ `{ "path": "seats.12", "message": "Ghế \"B3\" chồng lên ghế \"B2\"" }`.

| Mã lỗi | HTTP | Khi nào |
|---|---|---|
| `INVALID_SEAT_TICKET_TYPE` | 422 | Ghế gán cho hạng vé không phải `ASSIGNED` hoặc của sự kiện khác; `details.seats` |
| `SEAT_SOLD_LOCKED` | 409 | Xóa, đổi hạng hoặc khóa ghế đã có người đặt; `details.seats: [{ label, reason }]`. **Dời vị trí** ghế đã bán thì được |
| `SEAT_MAP_VERSION_CONFLICT` | 409 | Xem trên |
| `EVENT_CANCELLED` | 409 | Sự kiện đã hủy |

Thành công: **200**, body giống `GET` (đã có `id` của từng ghế), header `ETag` mới. Tổng vé của các hạng `ASSIGNED` được tính lại ngay.

### `PATCH /admin/events/:eventId/seats`

Khóa hoặc mở khóa nhiều ghế, không cần gửi lại cả sơ đồ.

```json
{ "seatIds": ["…", "…"], "blocked": true }
```

Response: `{ "version": 4, "changed": 2 }`. `changed = 0` (ghế đã ở trạng thái đó) thì version không tăng.
Lỗi: `422 SEATS_NOT_FOUND` (ghế không thuộc sự kiện), `409 SEAT_SOLD_LOCKED` (khóa ghế đã bán), `404 SEAT_MAP_NOT_FOUND`.

### `POST /admin/events/:eventId/seat-map/copy-from/:sourceEventId`

Chép sơ đồ của sự kiện khác (ví dụ cùng nhà hát, suất diễn khác). Body: `{ "version": <version hiện tại của sự kiện đích, 0 nếu chưa có> }`.
Hạng vé được ghép **theo tên**: sự kiện đích phải có hạng `ASSIGNED` trùng tên với mọi hạng mà ghế nguồn đang dùng, nếu không nhận `422 TICKET_TYPE_MAPPING_FAILED` với `details.missing` là danh sách tên còn thiếu. Ghế ở sự kiện đích có `id` mới. Các kiểm tra còn lại giống `PUT`.

---

## 6. Hàng chờ ảo

Thiết kế chi tiết: [GHE-VA-HANG-CHO.md](GHE-VA-HANG-CHO.md).

- Bật cho từng sự kiện. Trước `saleStartAt` không ai đặt được vé.
- **Người vào hàng trước giờ mở bán được xếp ngẫu nhiên** đúng lúc mở bán. Người vào sau giờ mở bán đứng tiếp theo thứ tự đến.
- Worker cho người đứng đầu vào (`ADMITTED`) sao cho cùng lúc có tối đa `maxActive` người đang mua. Mỗi người được mua trong `accessMinutes` phút, đặt xong một đơn thì lượt kết thúc (`COMPLETED`) và nhường chỗ cho người kế.
- Người đang chờ phải hỏi lại trạng thái định kỳ. Quá `QUEUE_STALE_SECONDS` giây (mặc định 120) không hỏi lại thì bị coi là đã bỏ đi (`EXPIRED`).
- Mỗi người chỉ có một lượt cho mỗi sự kiện. Vào lại sau khi lượt cũ đã kết thúc (`COMPLETED`, `EXPIRED`, `LEFT`) thì đứng cuối hàng.

| Trạng thái | Ý nghĩa | Frontend |
|---|---|---|
| `WAITING` | Đang chờ. `position = null` khi chưa tới giờ mở bán | Hiện trang chờ, gọi lại `GET .../queue/me` sau `retryAfterSeconds` |
| `ADMITTED` | Tới lượt, được mua tới `expiresAt` | Chuyển sang trang chọn vé/ghế, hiện đồng hồ đếm ngược |
| `COMPLETED` | Đã đặt xong một đơn | Ngừng hỏi lại. Muốn mua thêm thì vào hàng lại |
| `EXPIRED` | Hết giờ mua, hoặc bỏ trang chờ quá lâu | Báo hết lượt, cho nút vào hàng lại |
| `LEFT` | Khách tự rời hàng | Như trên |

### `POST /events/:eventId/queue` (đăng nhập)

Vào hàng. **201** khi tạo lượt mới (hoặc vào lại sau khi lượt cũ đã kết thúc), **200** khi đang có lượt `WAITING`/`ADMITTED` (trả lại lượt đó). Body là đối tượng lượt xếp hàng (xem dưới).

| Mã lỗi | HTTP | Khi nào |
|---|---|---|
| `EVENT_NOT_FOUND` | 404 | Sự kiện không có hoặc chưa công khai |
| `EVENT_ALREADY_STARTED` | 409 | Sự kiện đã diễn ra |
| `QUEUE_NOT_ENABLED` | 409 | Sự kiện không dùng hàng chờ: đặt vé trực tiếp |

### `GET /events/:eventId/queue/me` (đăng nhập)

Trạng thái lượt của tôi. Mỗi lần gọi cũng là một "nhịp tim" giữ chỗ trong hàng. `404 QUEUE_ENTRY_NOT_FOUND` nếu chưa vào hàng.

```json
{
  "eventId": "…",
  "status": "WAITING",
  "queueEnabled": true,
  "position": 37,
  "aheadOfYou": 12,
  "waitingCount": 140,
  "saleStartAt": "2026-12-01T13:00:00.000Z",
  "saleStarted": true,
  "admittedAt": null,
  "expiresAt": null,
  "retryAfterSeconds": 5,
  "serverTime": "2026-12-01T13:00:41.123Z"
}
```

- `aheadOfYou`: số người còn chờ phía trước, chỉ có khi `WAITING` và đã có vị trí.
- `retryAfterSeconds`: bao lâu nữa gọi lại. `null` nghĩa là ngừng hỏi (lượt đã kết thúc, hoặc `queueEnabled = false` khi admin tắt hàng chờ: khi đó chuyển thẳng sang trang mua).
- `serverTime`: giờ server, dùng để đếm ngược tới `saleStartAt` / `expiresAt` không phụ thuộc đồng hồ máy khách.
- Response luôn có `Cache-Control: no-store`.

### `DELETE /events/:eventId/queue/me` (đăng nhập)

Rời hàng, trạng thái thành `LEFT`. Gọi lại khi lượt đã kết thúc thì trả trạng thái hiện tại, không lỗi. `404 QUEUE_ENTRY_NOT_FOUND` nếu chưa từng vào hàng.

### `PUT /admin/events/:eventId/queue`

```json
{ "enabled": true, "saleStartAt": "2026-12-01T20:00:00+07:00", "maxActive": 200, "accessMinutes": 10 }
```

| Trường | Ràng buộc |
|---|---|
| `enabled` | Tắt thì mọi người đặt vé trực tiếp, các lượt đang có được giữ nguyên |
| `saleStartAt` | ISO 8601 có múi giờ. **Không đổi được sau khi đã mở bán** (`409 QUEUE_ALREADY_STARTED`) |
| `maxActive` | 1–10000 người mua cùng lúc |
| `accessMinutes` | 1–120 phút cho mỗi lượt mua |

### `GET /admin/events/:eventId/queue`

```json
{
  "eventId": "…", "enabled": true, "saleStartAt": "…", "maxActive": 200, "accessMinutes": 10,
  "randomizedAt": "…",
  "counts": { "WAITING": 140, "ADMITTED": 200, "COMPLETED": 35, "EXPIRED": 4, "LEFT": 2 },
  "updatedAt": "…"
}
```

`randomizedAt` là lúc đã xếp ngẫu nhiên những người vào trước giờ mở bán (`null` khi chưa mở bán). `404 QUEUE_NOT_CONFIGURED` nếu sự kiện chưa cấu hình hàng chờ.

### `POST /admin/events/:eventId/queue/tick`

Chạy worker hàng chờ một nhịp ngay cho sự kiện này, khỏi chờ `QUEUE_TICK_MS`. Dùng khi demo.
Response: `{ "tick": { "events": 1, "admitted": 2, "expired": 0, "dropped": 0 }, "settings": { …như GET… } }`.
