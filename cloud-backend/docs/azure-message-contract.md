# Hợp đồng tích hợp GCP ↔ Azure (đã chốt với người làm Azure)

Có hai luồng:
1. **GCP gửi sang Azure**: mỗi lần đặt hoặc hủy vé, GCP gửi 1 thông điệp vào Storage Queue `ticket-events`.
2. **GCP đọc từ Azure**: backend gọi API `/stats` để lấy số vé, rồi ghép thêm doanh thu từ DB của GCP.

> Dữ liệu đơn chính thức nằm ở GCP. Azure chỉ đếm số vé để làm thống kê, **không tính doanh thu**. Nhóm đã đồng ý doanh thu lấy từ DB GCP.

---

## 1. Gửi sự kiện đặt/hủy (GCP → Azure Storage Queue)

| | |
|---|---|
| Queue | `https://stticketsinh2026.queue.core.windows.net/ticket-events` |
| Xác thực | SAS token chỉ có quyền **ghi**, **hết hạn 15/01/2027**. Đặt vào biến `AZURE_QUEUE_SAS_URL`, **không commit** |
| Thư viện | `@azure/storage-queue`: tự bọc XML và escape `&` `<`. Nội dung gửi là JSON thô, **không base64** |
| Thành công | HTTP 201. **Chỉ có nghĩa là Azure đã nhận được chữ**, chưa chắc thông điệp đúng mẫu (xem mục 3) |
| Mã nguồn | [src/outbox/azureMessage.ts](../src/outbox/azureMessage.ts), [src/outbox/publisher.ts](../src/outbox/publisher.ts) |

### Mẫu thông điệp (7 trường bắt buộc, nằm ở cấp ngoài cùng)

```json
{
  "messageId": "5f37024a-30ba-4a3f-a02a-faf9bef4703f",
  "type": "BOOKED",
  "orderId": "32a4f928-79c9-4a74-a572-d0b0d33993e0",
  "eventId": "a28e716e-9b1e-4fb3-9e5f-976613d6338f",
  "ticketTierId": "0c1d7a52-8f0e-4d0b-a1f3-5b9e2c7d4e11",
  "quantity": 3,
  "occurredAt": "2026-11-12T07:39:55.981Z"
}
```

| Trường | Giá trị lấy từ đâu trong hệ thống |
|---|---|
| `messageId` | **id (UUID) của dòng outbox**, sinh một lần trong giao dịch đặt/hủy. Mọi lần gửi lại đều dùng đúng id này |
| `type` | `BOOKED` khi tạo đơn, `CANCELLED` khi hủy đơn |
| `orderId` | UUID của đơn |
| `eventId` | UUID của sự kiện, không chứa `/ \ # ?` |
| `ticketTierId` | UUID của hạng vé, không đổi kể cả khi admin đổi tên hạng vé |
| `quantity` | Số vé của đơn, là số nguyên > 0. Khi hủy thì bằng toàn bộ số vé của đơn |
| `occurredAt` | Thời điểm ghi outbox, dạng ISO-8601 UTC (đuôi `Z`) |
Chỉ gửi đúng 7 trường. Azure xác nhận trường thêm bị bỏ qua, không được lưu. Tên hạng vé và tên sự kiện lấy từ DB GCP theo id.
Không gửi `userId` và giá sang Azure vì Azure không cần các trường này.

### Trả lời 5 câu hỏi của người làm Azure
1. **Có tạo thông điệp riêng cho hủy không?** Có. Mỗi lần hủy là một thông điệp `CANCELLED` riêng, được ghi cùng giao dịch với lúc cập nhật đơn. Hủy lần thứ hai bị từ chối (409) nên không sinh thêm thông điệp. Khi admin **hủy cả sự kiện**, mỗi đơn còn hiệu lực của sự kiện nhận một `CANCELLED` riêng, cùng mẫu 7 trường, ghi trong cùng giao dịch hủy sự kiện. Không có loại thông điệp "hủy sự kiện" riêng.
2. **Có hủy một phần không?** Không. Mỗi lần hủy là hủy cả đơn, nên `quantity` của `CANCELLED` bằng `quantity` của `BOOKED`.
3. **Có loại sự kiện nào khác không?** Không. Chỉ có `BOOKED` và `CANCELLED`, chưa có hoàn tiền hay hết hạn giữ chỗ.
4. **`messageId` lấy từ đâu?** Là id của dòng outbox, cố định qua mọi lần gửi lại.
5. **Định dạng `eventId` và `ticketTierId`?** Cả hai đều là UUID dạng `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, không chứa `/ \ # ?`.

---

## 2. Bảo đảm phía GCP

| Bảo đảm | Cách làm |
|---|---|
| Không mất thông điệp | Thông điệp được ghi vào `outbox_events` **trong cùng giao dịch** với thay đổi đơn. Worker gửi lại khi lỗi, với khoảng chờ tăng dần 5s, 10s, 20s, …, tối đa 15 phút |
| Không đếm trùng | `messageId` cố định, Azure khử trùng theo cặp `(eventId, messageId)` |
| Không gửi trùng phía GCP | Worker nhận lô bằng `FOR UPDATE SKIP LOCKED`, lease đủ dài cho cả lô và mã nhận việc `claim_token`: chỉ lượt đang giữ dòng mới được chốt SENT/FAILED. Nút "Gửi lại" bỏ qua dòng đang gửi dở. Gửi qua mạng vẫn là at-least-once (ví dụ mất kết nối sau khi Azure đã nhận), nên Azure vẫn phải khử trùng |
| Đúng thứ tự trong từng đơn | `CANCELLED` của một đơn chỉ được gửi sau khi `BOOKED` của đơn đó đã gửi thành công |
| Không gửi thông điệp sai mẫu | Xem mục 3 |
| SAS hết hạn hoặc sai | Queue trả 401/403. Thông điệp ở lại PENDING và được thử lại; quá `OUTBOX_MAX_ATTEMPTS` thì chuyển FAILED. Sau khi thay SAS mới, admin bấm "Gửi lại" (`POST /api/admin/outbox/retry`) |
| Không lộ SAS | Phần `sig=` bị che (`***`) trong mọi log và lỗi |
| Minh chứng gửi thành công | Mỗi lần queue trả thành công, ghi một dòng JSON `azure_queue_send_succeeded` kèm `httpStatus` thật (201), `eventId`, `orderId`, `messageId`, `messageType`. Gọi `/stats` hoặc `/history` thành công ghi `azure_stats_request_succeeded` (200). Xem README mục 4.5 |

## 3. Kiểm tra thông điệp TRƯỚC KHI gửi

Queue trả 201 cho **mọi** nội dung. Nếu thông điệp sai mẫu, Azure sẽ âm thầm chuyển nó vào `ticket-events-poison`. Vì vậy GCP kiểm tra trước khi gửi:

- Validator chuyển nguyên logic từ `validate-message.js` của người làm Azure sang TypeScript.
- Thông điệp sai mẫu thì đánh dấu **FAILED ngay** với lỗi `INVALID_MESSAGE: ...`, không gửi và không thử lại.
- Đã kiểm chứng bằng **89 ca** do bộ kiểm tra thật của Azure sinh ra (`tests/fixtures/azure-message-vectors.json`):
  - **0 ca** "GCP nhận nhưng Azure từ chối".
  - 11 ca GCP chặt hơn Azure, giống hệt validator gốc. Đó là id kiểu số và `occurredAt` có định dạng lạ, những dạng hệ thống không bao giờ sinh ra.

## 4. Đối soát: Azure đã thực sự xử lý chưa?

`GET {AZURE_STATS_URL}/history?orderId=<id>` trả lịch sử những gì Azure đã xử lý. Backend tìm đúng `messageId` đã gửi trong kết quả đó:
- API: `GET /api/admin/orders/:orderId/azure-sync` trả mỗi thông điệp kèm `processedByAzure: true | false | null`. Giá trị `null` nghĩa là không hỏi được Azure.
- Trang `/dev`, tab Outbox: nút "Đối soát".
- Lưu ý: số liệu chậm khoảng 1–2 phút vì Function của Azure phải khởi động từ trạng thái ngủ.

---

## 5. Đọc thống kê (GCP → Azure Function)

| | |
|---|---|
| Địa chỉ gốc | `https://func-ticket-stats-sinh.azurewebsites.net/api` (`AZURE_STATS_URL`) |
| Xác thực | Header `x-functions-key` (`AZURE_STATS_KEY`). **Chỉ backend giữ khóa này, không đưa cho frontend** |

| Mục đích | Azure | API backend cho frontend |
|---|---|---|
| Theo ngày (biểu đồ) | `/stats?groupBy=day&from&to&fillGaps=true[&eventId]` | `GET /api/admin/stats/daily?from&to&eventId` |
| Theo sự kiện | `/stats?groupBy=event[&from&to]` | `GET /api/admin/stats/events?from&to` |
| Một sự kiện | `/stats?groupBy=event&eventId=` | `GET /api/admin/stats/events/:eventId` |

Dữ liệu Azure trả về: `{ groupBy, items: [{ key, bookedTickets, cancelledTickets, bookedOrders, cancelledOrders, netTickets }], totals: {...} }`.
"Ngày" tính theo giờ Việt Nam (UTC+7).

**Backend bổ sung** vào mỗi `item` và vào `totals`:
- `bookedRevenue`, `cancelledRevenue`, `netRevenue`: doanh thu tính từ DB GCP, cùng cách tính với Azure (đặt theo ngày tạo đơn, hủy theo ngày hủy).
- `eventTitle` khi `groupBy=event`.

**Xử lý lỗi:**

| Tình huống | Backend trả |
|---|---|
| Tham số sai (from > to, quá 366 ngày, ngày không tồn tại) | Chặn ngay ở backend: `400 VALIDATION_ERROR` |
| Azure trả 400 | `400 STATS_BAD_REQUEST` kèm thông báo của Azure |
| Sai hoặc thiếu khóa (401) | `502 STATS_AUTH_FAILED` |
| Không kết nối được, quá giờ, 5xx | 503 / 504 / 502. Lỗi tạm thời được thử lại 1 lần; nếu còn dữ liệu cũ trong cache (dưới 10 phút) thì trả về với `stale: true` |
| Dữ liệu sai định dạng | `502 STATS_UPSTREAM_ERROR` |

Khi `STATS_MODE=mock`, backend giả lập **đúng API `/stats`** (kể cả `fillGaps`) và `/history` bằng dữ liệu từ DB cục bộ.

---

## 6. Chạy thử với Azure thật

```bash
# .env: AZURE_QUEUE_SAS_URL, AZURE_STATS_URL, AZURE_STATS_KEY
npm run azure:smoke
```
Script làm các bước sau:
1. Gửi 1 thông điệp `BOOKED` của sự kiện riêng tên `SMOKE-TEST`, **2 lần với cùng `messageId`**.
2. Chờ tới khi thông điệp xuất hiện trong `/history`.
3. In kết quả `/stats` của sự kiện `SMOKE-TEST`. Kỳ vọng `bookedTickets` chỉ tăng **1**, chứng tỏ cơ chế chống trùng hoạt động.

Để chạy cả hệ thống với Azure thật, đặt `PUBLISHER_MODE=azure-queue` và `STATS_MODE=http`.

**Kết quả chạy thật (12/11/2026):** smoke test và luồng đặt rồi hủy của một đơn đều được Azure xử lý trong khoảng 5 giây. Chống trùng hoạt động đúng, hàng đợi `ticket-events-poison` trống.

---

## 7. Dọn dữ liệu thử trước buổi demo

Azure khử trùng theo `messageId`. Nếu Azure đã xóa một thông điệp mà GCP lại gửi đúng thông điệp đó, Azure sẽ **đếm lại**. Ngoài ra, nếu đơn thử bị hủy *sau khi* Azure đã xóa dữ liệu, Azure sẽ nhận một `CANCELLED` mà không có `BOOKED` tương ứng.

Phía GCP đã có sẵn các bảo đảm sau:
- Thông điệp đã SENT **không bao giờ** được gửi lại, kể cả khi bấm "Gửi lại" (nút này chỉ áp dụng cho PENDING/FAILED).
- Cột `outbox_events.sent_via` ghi kênh gửi (`mock` | `azure-queue`), nên biết chính xác thông điệp nào đã tới Azure.

**Quy trình:**
1. Tắt server.
2. `npm run azure:report`: in danh sách thông điệp đã tới Azure (bảng Markdown, hoặc thêm `-- --json`). Gửi danh sách này cùng eventId `SMOKE-TEST` cho người làm Azure.
3. `npm run seed -- --reset`: xóa sạch đơn và outbox ở GCP. Từ đây không đơn thử nào có thể sinh thêm thông điệp.
4. Chờ Azure báo đã xóa xong.
5. Bật server với `PUBLISHER_MODE=azure-queue`. Các đơn mẫu do seed tạo sẽ được gửi lên Azure với `messageId` mới, nên số vé ở Azure khớp với doanh thu trong DB khi demo.
