# Sơ đồ ghế, đặt ghế và hàng chờ ảo

Tài liệu cho người làm frontend và cho báo cáo. Hợp đồng API đầy đủ (request, response, mã lỗi) nằm ở [API.md](API.md) mục 5 và 6.

## 1. Các quyết định đã chốt

| Câu hỏi | Quyết định | Lý do |
|---|---|---|
| Một đơn được chứa ghế của nhiều hạng vé? | **Không**, mỗi đơn một hạng vé | Giữ nguyên mẫu thông điệp gửi Azure (`ticketTierId` + `quantity`), không phải bàn lại với bên thống kê |
| Có bước giữ ghế tạm thời? | **Không** ở bản này | Đơn được xác nhận ngay, không có bước thanh toán nên không có khoảng chờ cần giữ ghế. Hàng chờ đã giới hạn số người mua cùng lúc, nên ít khi hai người tranh cùng một ghế. Muốn thêm sau thì thêm bảng `seat_holds`, không phải đổi API đã có |
| Người vào hàng trước giờ mở bán xếp thế nào? | **Ngẫu nhiên** lúc mở bán, sau đó theo thứ tự đến | Không ai có lợi vì vào thật sớm hay canh từng mili giây; lượt vào hàng rải đều trước giờ mở bán thay vì dồn vào một giây |
| Ai làm giao diện vẽ sơ đồ và trang chờ? | Minh (frontend) | Backend cung cấp API và dữ liệu mẫu (nhà hát hàng ghế cong) |
| Sơ đồ gắn với sự kiện hay địa điểm? | **Sự kiện**, có API chép sơ đồ từ sự kiện khác | Mỗi suất diễn có thể khóa ghế, đổi hạng riêng; chép giúp không phải vẽ lại |

## 2. Dữ liệu

```text
ticket_types.seating      GENERAL (bán theo số lượng, như cũ) | ASSIGNED (chọn ghế)
seat_maps                 1 sơ đồ / sự kiện: khung width x height, seat_size, decorations (JSONB), version
seat_sections             khu ghế (key, name, color)
seats                     label (khóa tự nhiên trong sự kiện), row_label, x, y, rotation, accessible, blocked, ticket_type_id
order_seats               ghế của đơn; released_at IS NULL = đang giữ
                          UNIQUE (seat_id) WHERE released_at IS NULL  => một ghế chỉ thuộc một đơn còn hiệu lực
event_queue_settings      enabled, sale_start_at, max_active, access_minutes, randomized_at, last_position
queue_entries             một dòng / (sự kiện, người dùng): WAITING | ADMITTED | COMPLETED | EXPIRED | LEFT
```

Migration: `005_seating.sql`, `006_virtual_queue.sql`. Container tự chạy khi khởi động, chỉ thêm bảng mới và cột có giá trị mặc định nên không khóa bảng lâu.

Bất biến cũ vẫn giữ: `total_quantity - available_quantity` = tổng vé của các đơn `CONFIRMED`. Với hạng `ASSIGNED`, `total_quantity` = số ghế không bị khóa của hạng, và số vé đã bán = số ghế đang được giữ.

## 3. Vì sao không bán trùng ghế

Đặt ghế nằm trong **một giao dịch** (`src/orders/service.ts`):

1. Khóa `FOR SHARE` dòng sự kiện. Lưu sơ đồ, khóa ghế, hủy sự kiện đều khóa `FOR UPDATE` cùng dòng này, nên sơ đồ không đổi giữa chừng.
2. Sự kiện bật hàng chờ: khóa dòng lượt xếp hàng của người đặt, kiểm tra `ADMITTED` và còn hạn. Hai đơn song song của cùng người chỉ một đơn dùng được lượt.
3. Kiểm tra ghế thuộc đúng hạng, không bị khóa, chưa ai đặt (để báo lỗi rõ ràng).
4. Trừ vé bằng `UPDATE ... WHERE available_quantity >= n` (khóa dòng hạng vé).
5. Tạo đơn.
6. `INSERT INTO order_seats ... ORDER BY seat_id ON CONFLICT DO NOTHING RETURNING`. Thiếu ghế nào thì báo `SEAT_TAKEN` và **hoàn tác cả đơn**. Ghế luôn được ghi theo cùng một thứ tự id nên các giao dịch không khóa chéo nhau (deadlock).
7. Ghi outbox, đánh dấu lượt xếp hàng `COMPLETED`.

Unique index ở bước 6 là lớp bảo vệ cuối: dù code có sai, database cũng không cho một ghế thuộc hai đơn còn hiệu lực. Hủy đơn hoặc hủy sự kiện đặt `released_at` trong cùng giao dịch hoàn vé.

## 4. Hàng chờ chạy thế nào

- Trước giờ mở bán, người vào hàng có `position = null`.
- Đúng giờ mở bán, lần đầu tiên worker chạy (hoặc có người vào hàng, tùy cái nào tới trước) sẽ xếp **ngẫu nhiên** vị trí 1..N cho những người đã vào trước giờ mở bán. Việc này chỉ làm một lần (`randomized_at`). Người vào sau nhận `last_position + 1`.
- Worker (`src/queue/worker.ts`, mỗi `QUEUE_TICK_MS`, mặc định 2 giây), với mỗi sự kiện đã mở bán:
  1. `ADMITTED` quá `expires_at` thành `EXPIRED`.
  2. `WAITING` không hỏi lại quá `QUEUE_STALE_SECONDS` (mặc định 120) thành `EXPIRED`.
  3. Cho người có `position` nhỏ nhất vào, tới khi đủ `max_active` người `ADMITTED`.
- Worker khóa dòng cấu hình của sự kiện bằng `FOR UPDATE SKIP LOCKED`. Nếu Cloud Run chạy nhiều instance, mỗi sự kiện chỉ một instance xử lý tại một thời điểm, không cho vào quá số chỗ (có test chạy 4 worker song song).

## 5. Hướng dẫn cho frontend

### 5.1. Trang chi tiết sự kiện

`GET /events/:id` đã có đủ thông tin để chọn luồng:

```text
queue?.enabled  ─── có ──▶ trang chờ (5.2) ──ADMITTED──▶ trang mua
       │
       └─ không ──▶ trang mua ngay

trang mua: với từng hạng vé
  seating = GENERAL   ─▶ ô nhập số lượng như hiện nay
  seating = ASSIGNED  ─▶ sơ đồ ghế (5.3), chỉ khi seatMap != null
```

### 5.2. Trang chờ

1. `POST /events/:id/queue` (201 hoặc 200 đều được).
2. Lặp: chờ `retryAfterSeconds` giây rồi `GET /events/:id/queue/me`. Dừng khi `retryAfterSeconds = null`.
3. Hiển thị theo `status`:
   - `WAITING`, `saleStarted = false`: đếm ngược tới `saleStartAt`, kèm dòng "Thứ tự sẽ được xếp ngẫu nhiên lúc mở bán" và `waitingCount` người đang chờ.
   - `WAITING`, `saleStarted = true`: "Còn `aheadOfYou` người phía trước".
   - `ADMITTED`: chuyển sang trang mua, đếm ngược tới `expiresAt`. Vẫn gọi `queue/me` theo `retryAfterSeconds` để biết khi hết hạn.
   - `COMPLETED` / `EXPIRED` / `LEFT`: thông báo, có nút "Vào hàng lại".
   - `queueEnabled = false`: chuyển thẳng sang trang mua.
4. Đếm ngược theo giờ server: `lệch = Date.parse(serverTime) - Date.now()` lúc nhận response, rồi dùng `Date.now() + lệch`.
5. Nút "Rời hàng" gọi `DELETE /events/:id/queue/me`.
6. Khi đặt vé nhận `409 QUEUE_ADMISSION_REQUIRED` hoặc `SALE_NOT_STARTED`, quay lại trang chờ.

Nếu khách đóng tab hoặc điện thoại ngủ quá `QUEUE_STALE_SECONDS`, lượt bị coi là bỏ đi. Nên ghi chú điều này trên trang chờ.

### 5.3. Vẽ sơ đồ ghế

Gợi ý dùng SVG, không cần thêm thư viện:

```tsx
<svg viewBox={`0 0 ${map.width} ${map.height}`} style={{ width: '100%', height: 'auto' }}>
  {map.decorations.map(/* vẽ theo type: 'stage' -> <rect>, 'label' -> <text> ... */)}
  {map.seats.map((s) => (
    <g key={s.id} transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}>
      <circle r={map.seatSize / 2} fill={màuTheoTrạngThái(s)} onClick={() => chọn(s)} />
    </g>
  ))}
</svg>
```

- **Màu ghế**: theo hạng vé (`ticketTypeId`) hoặc khu (`sections[].color`). Ghế trong `sold`/`blocked` của `seats/status` tô xám và không cho chọn. `accessible = true` có biểu tượng riêng.
- **Bộ nhớ đệm**: chỉ cần `fetch` bình thường. Response có `ETag` và `Cache-Control: no-cache` nên trình duyệt tự gửi `If-None-Match` và nhận 304 khi sơ đồ chưa đổi.
- **Trạng thái ghế**: gọi `GET /events/:id/seats/status` khi mở trang và mỗi 5–10 giây. Nếu `version` khác version sơ đồ đang hiển thị thì tải lại sơ đồ.
- **Chọn ghế**: chỉ cho chọn ghế cùng một hạng vé trong một đơn, tối đa `MAX_TICKETS_PER_ORDER` (10) ghế.
- **Đặt**: `POST /orders` với `{ ticketTypeId, seatIds }`, kèm `Idempotency-Key` như luồng hiện tại.
- **`409 SEAT_TAKEN`**: bỏ các ghế trong `details.seatIds` khỏi lựa chọn, tải lại `seats/status`, hiện `error.message` ("Ghế A3 vừa có người đặt...").
- **Vé của tôi**: hiện `order.seats[].label` cạnh tên hạng vé.

### 5.4. Trang quản trị

- **Tạo hạng vé theo ghế**: gửi `seating: "ASSIGNED"`, không gửi `totalQuantity`. Ô tổng số vé của hạng này chỉ để xem.
- **Nhập sơ đồ**: bản đơn giản nhất là cho admin dán hoặc tải lên file JSON đúng mẫu body của `PUT /admin/events/:id/seat-map`, xem trước bằng chính component vẽ ở 5.3 rồi lưu. Công cụ kéo thả có thể làm sau, API không đổi.
  - Khi lưu, gửi `version` của bản đang sửa. Nhận `409 SEAT_MAP_VERSION_CONFLICT` thì báo "Sơ đồ vừa bị người khác sửa", tải lại.
  - `400 VALIDATION_ERROR`: hiện danh sách `details` (ghế chồng nhau, ngoài khung, trùng nhãn...).
  - `409 SEAT_SOLD_LOCKED`: hiện `details.seats` (ghế đã bán không xóa, đổi hạng hay khóa được).
- **Khóa ghế**: bấm chọn ghế trên sơ đồ rồi gọi `PATCH /admin/events/:id/seats`.
- **Chép sơ đồ**: chọn sự kiện nguồn rồi gọi `POST .../seat-map/copy-from/:sourceEventId`. Lỗi `TICKET_TYPE_MAPPING_FAILED` cho biết cần tạo thêm hạng vé nào.
- **Hàng chờ**: form 4 trường của `PUT /admin/events/:id/queue`, kèm bảng `counts` từ `GET`. Nút "Chạy một nhịp" gọi `POST .../queue/tick`, tiện khi demo.

### 5.5. Backend giả của frontend

`frontend/src/api/mock` cần thêm dữ liệu cho các API mới để chạy `npm run dev` không cần backend. Có thể lấy sơ đồ mẫu bằng cách chạy seed backend rồi lưu response của `GET /api/events/<id nhà hát>/seat-map`.

## 6. Dữ liệu mẫu và demo trên máy

`npm run seed` (database trống) tạo thêm sự kiện **"Nhạc kịch: Những người khốn khổ (có sơ đồ ghế)"**:

- 367 ghế trên 14 hàng cong (A–N), 3 khu trái / giữa / phải. Hạng A (hàng A–D), Hạng B (E–J), Hạng C (K–N). Hai ghế đầu và cuối hàng N dành cho người khuyết tật. Sinh bằng `src/seating/theater.ts`.
- alice đã đặt ghế A3 và A4.
- Hàng chờ bật, **mở bán sau 5 phút** kể từ lúc seed, 2 người mua cùng lúc, mỗi người 10 phút.

Kịch bản thử với `AUTH_MODE=mock` (thay `<id>` bằng id sự kiện seed in ra):

```bash
API=http://localhost:3000/api
# vài khách vào hàng trước giờ mở bán
for u in u1 u2 u3 u4; do curl -s -X POST $API/events/<id>/queue -H "Authorization: Bearer mock:$u:customer"; echo; done
# admin dời giờ mở bán về hiện tại (chỉ đổi được khi chưa mở bán), rồi chạy một nhịp worker
curl -s -X PUT $API/admin/events/<id>/queue -H 'Authorization: Bearer mock:admin1:admin' -H 'Content-Type: application/json' \
  -d "{\"enabled\":true,\"saleStartAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"maxActive\":2,\"accessMinutes\":10}"
curl -s -X POST $API/admin/events/<id>/queue/tick -H 'Authorization: Bearer mock:admin1:admin'
# mỗi khách xem vị trí của mình (2 người ADMITTED, 2 người WAITING)
curl -s $API/events/<id>/queue/me -H 'Authorization: Bearer mock:u1:customer'
```

## 7. Triển khai

- Hai migration tự chạy khi container khởi động. Không cần quyền gì ngoài quyền tạo bảng mà `ticket_backend` đang dùng.
- Biến môi trường mới, đều có mặc định nên không bắt buộc đặt: `QUEUE_TICK_MS` (2000), `QUEUE_STALE_SECONDS` (120).
- Không đổi gì phía Azure: thông điệp vẫn đúng 7 trường, `quantity` = số ghế của đơn.
- Cloud Run đang chạy 1 instance, `DB_POOL_MAX=5`. Mỗi khách đang chờ gọi `queue/me` mỗi 3–30 giây (`retryAfterSeconds` tự giãn ra khi còn xa lượt), mỗi lần vài câu query nhỏ có index, đủ cho demo môn học. Muốn chịu tải lớn hơn thì tăng instance: worker hàng chờ đã an toàn khi chạy song song.
