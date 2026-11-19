# Báo cáo: API quản lý sự kiện và đặt vé

**Phạm vi phụ trách**: backend sự kiện, hạng vé, đặt/hủy và tra cứu đơn trên GCP; gửi sự kiện đơn sang Azure và đọc thống kê từ Azure.
**Kết quả**: hoàn thành toàn bộ 12 hạng mục được giao. Có **74 test tích hợp chạy trên PostgreSQL thật, tất cả đều đạt** (gồm 8 test của module tài khoản do Việt Đức làm, xem [BAO-CAO-TAI-KHOAN.md](BAO-CAO-TAI-KHOAN.md)). Đã tích hợp theo hợp đồng thật với phần Azure (Storage Queue + API thống kê) và đã triển khai lên Cloud Run + Cloud SQL (Dương phụ trách hạ tầng).

---

## 1. Công nghệ và kiến trúc

| Thành phần | Lựa chọn | Lý do |
|---|---|---|
| Ngôn ngữ | Node.js 22 + TypeScript | Kiểu tĩnh giúp tránh lỗi, dễ bàn giao |
| Web framework | Express 5 | Gọn, tự bắt lỗi trong handler async |
| CSDL | PostgreSQL 16 (Cloud SQL trên GCP) | Giao dịch ACID, khóa dòng, ràng buộc CHECK; đây là điều kiện cần cho đặt vé đồng thời |
| Kiểm tra dữ liệu | Zod | Khai báo quy tắc một lần, sinh thông báo lỗi chi tiết |
| Kiểm thử | Vitest + Supertest | Gọi HTTP thật vào app, dùng DB thật |
| Triển khai | Docker → Cloud Run + Cloud SQL | |

```
Frontend ──HTTP──▶ API (Cloud Run) ──SQL──▶ PostgreSQL (Cloud SQL)   ← dữ liệu đơn chính thức
                    │   │                         ▲
                    │   └─ Backend tài khoản      │ outbox_events (cùng giao dịch)
                    │      (kiểm tra token/quyền)  │
                    │                    Outbox worker ──POST──▶ Azure (thống kê)
                    └──────────── GET thống kê ◀────────────────── Azure
```

---

## 2. Thiết kế dữ liệu

| Bảng | Nội dung chính | Ràng buộc quan trọng |
|---|---|---|
| `events` | tiêu đề, **loại hình (category)**, địa điểm, thời gian, trạng thái DRAFT/PUBLISHED/CANCELLED | `end_time > start_time` |
| `ticket_types` | thuộc 1 sự kiện; tên, **giá**, `total_quantity`, `available_quantity` | `price ≥ 0`; `0 ≤ available ≤ total`; tên không trùng trong cùng sự kiện |
| `orders` | **người đặt (user_id)**, **sự kiện**, **hạng vé**, **số lượng**, đơn giá chốt, thành tiền, **trạng thái** CONFIRMED/CANCELLED, thông tin hủy | `quantity > 0`; trạng thái CANCELLED phải đi cùng `cancelled_at`; `(user_id, idempotency_key)` là duy nhất |
| `outbox_events` | sự kiện cần gửi sang Azure: payload JSON, trạng thái PENDING/SENT/FAILED, số lần thử, lỗi gần nhất, thời điểm thử lại, kênh đã gửi (`sent_via`), lease và mã nhận việc của worker (`locked_until`, `claim_token`) | |

**Bất biến**: `total_quantity − available_quantity` = tổng số vé trong các đơn CONFIRMED (số vé đang được giữ).
Test kiểm tra bất biến này cả khi đặt và hủy chạy song song.

---

## 3. Đối chiếu yêu cầu và cách thực hiện

| # | Yêu cầu | Cách làm | Mã nguồn |
|---|---|---|---|
| 1 | Thiết kế dữ liệu sự kiện, hạng vé, đơn | 4 bảng như mục 2; mỗi đơn liên kết người đặt, sự kiện, hạng vé, số lượng, trạng thái. Migration không cần quyền tạo extension (chạy được với user thường trên Cloud SQL) | `migrations/*.sql` |
| 2 | Danh sách sự kiện lọc theo loại hình; chi tiết kèm hạng vé, giá, số còn lại | `GET /api/events?category=…` (kèm giá thấp/cao nhất, tổng vé còn), `GET /api/events/:id` | `src/events/service.ts` |
| 3 | API quản trị tạo/sửa sự kiện và hạng vé, gọi kiểm tra quyền của Backend tài khoản | Nhóm `/api/admin/*` có middleware `requireAdmin`. Quyền lấy qua adapter `AuthProvider` (local / mock / JWT / gọi HTTP sang Backend tài khoản), đổi chế độ bằng cấu hình. Chế độ `local` (Việt Đức) đăng nhập ngay trong backend và đọc vai trò từ bảng `accounts` | `src/auth/*`, `src/routes.ts` |
| 4 | Validate giá không âm, số lượng hợp lệ; không giảm vé dưới số đang giữ | Schema Zod kèm CHECK trong DB. Khi giảm số lượng, server dùng **một câu UPDATE có điều kiện** `new_total ≥ total − available` nên an toàn cả khi có đơn đặt chạy song song. Vi phạm thì trả `409 QUANTITY_BELOW_RESERVED` | `src/events/schemas.ts`, `updateTicketType()` |
| 5 | Đặt vé: người đặt từ phiên, giá từ DB | `user_id` lấy từ token; `unit_price` lấy từ `RETURNING price` của chính câu trừ vé; mọi giá trị giá/userId do client gửi lên đều bị bỏ qua | `src/orders/service.ts#create` |
| 6 | Một giao dịch: kiểm tra số còn, trừ vé, tạo đơn; lỗi thì hoàn tác toàn bộ | `withTransaction()`: BEGIN → trừ vé → INSERT đơn → INSERT outbox → COMMIT. Có lỗi thì ROLLBACK | `src/db.ts` |
| 7 | Hai yêu cầu đồng thời không làm vé âm; báo lỗi rõ khi hết hoặc thiếu vé | `UPDATE … SET available = available − q WHERE available ≥ q`. Postgres khóa dòng, request sau chờ rồi đánh giá lại điều kiện trên giá trị mới nhất. CHECK `available ≥ 0` là lớp bảo vệ cuối. Lỗi trả `SOLD_OUT` hoặc `INSUFFICIENT_TICKETS` (kèm số còn lại) | `create()` |
| 8 | Danh sách/chi tiết đơn của khách; admin tra theo sự kiện, trạng thái; kiểm tra quyền từng đơn | `GET /api/orders`, `GET /api/orders/:id` (chỉ chủ đơn hoặc admin; người khác nhận 404 để không lộ đơn), `GET /api/admin/orders?eventId&status` kèm bảng tổng hợp | `getForUser()`, `adminList()` |
| 9 | Hủy theo điều kiện nhóm chốt; hoàn vé cùng giao dịch; hủy lặp lại không hoàn vé | Khách được hủy khi còn ≥ N giờ (cấu hình được, mặc định 24) trước giờ diễn; admin thì không giới hạn. Server khóa đơn bằng `SELECT … FOR UPDATE`, lần hủy thứ hai thấy CANCELLED nên trả `409` và không hoàn vé. **Hủy cả sự kiện**: trong cùng giao dịch, hủy mọi đơn còn hiệu lực, hoàn vé từng hạng và ghi một `CANCELLED` sang Azure cho từng đơn; gọi lại không sinh thêm bản ghi | `cancel()`, `EventService.update()` |
| 10 | Lưu sự kiện đặt/hủy cùng lúc với thay đổi đơn; gửi lại phần chưa gửi được sang Azure | **Transactional Outbox**: ghi `outbox_events` trong cùng giao dịch. Worker định kỳ gửi; lỗi thì backoff tăng dần, quá số lần thì chuyển FAILED; admin có API xem và gửi lại. Nhiều worker chạy song song không gửi trùng (`FOR UPDATE SKIP LOCKED`, lease đủ dài cho cả lô, mã nhận việc `claim_token`; nút "Gửi lại" không đụng dòng đang gửi dở); giữ thứ tự sự kiện trong từng đơn. Mỗi lần gửi thành công ghi một dòng log JSON kèm HTTP 201 thật làm minh chứng. Gửi vào **Azure Storage Queue `ticket-events`** qua SAS URL. `messageId` là id dòng outbox, cố định khi gửi lại. **Thông điệp được kiểm tra trước khi gửi** bằng validator của Azure (kiểm chứng 89 ca, 0 ca lỏng hơn Azure); sai mẫu thì chuyển FAILED ngay | `src/outbox/*` |
| 11 | API cho frontend đọc thống kê từ Azure; thống nhất mẫu thông điệp; xử lý lỗi kết nối | `GET /api/admin/stats/daily` và `/stats/events`: **số vé** lấy từ API `/stats` của Azure, **doanh thu** lấy từ DB GCP (nhóm đã thống nhất). Có timeout, thử lại 1 lần, cache 30 giây, trả dữ liệu cũ (`stale: true`) khi Azure lỗi, mã lỗi 400/502/503/504. Khóa Azure chỉ nằm ở backend. Có **đối soát** qua `/history` để biết Azure đã thực sự xử lý thông điệp. Hợp đồng ghi trong `docs/azure-message-contract.md` | `src/stats/client.ts` |
| 12 | Kiểm thử các tình huống | 74 test, xem mục 4 | `tests/*` |

Phần làm thêm:
- **Idempotency-Key** chống tạo hai đơn khi người dùng bấm "Đặt vé" hai lần
- Giới hạn số vé mỗi đơn
- Không cho đặt vé sự kiện DRAFT, đã hủy hoặc đã diễn ra
- Dữ liệu mẫu (seed) và Dockerfile cho Cloud Run

---

## 4. Kết quả kiểm thử

Lệnh `npm test` trả kết quả: **9 file, 74/74 test đạt**. Chạy lặp lại 3 lần đều đạt, không có test chập chờn. Cloud Build của Dương cũng chạy bộ test trên PostgreSQL 16 tạm trước khi đẩy image.

| Tình huống yêu cầu | Test | Kết quả |
|---|---|---|
| Đặt vượt số lượng | Còn 2 vé, đặt 3 vé: nhận `409 INSUFFICIENT_TICKETS`, số vé và số đơn không đổi | ✅ |
| Hai khách đặt vé cuối | 2 request song song tranh 1 vé: đúng một 201 và một 409 `SOLD_OUT`, còn 0 vé | ✅ |
| (mở rộng) | 50 request song song tranh 10 vé: bán đúng 10 vé, không âm, khớp tổng các đơn | ✅ |
| Hoàn tác giao dịch | Dùng trigger giả lập lỗi ghi outbox: nhận 500, vé không bị trừ, không có đơn | ✅ |
| Xem đơn của người khác | Bob xem đơn của Alice: 404; Alice và admin xem được | ✅ |
| Hủy đơn của người khác | Bob hủy đơn của Alice: 404, đơn và vé giữ nguyên | ✅ |
| Hủy hai lần | Lần 2 nhận `409 ORDER_ALREADY_CANCELLED`, số vé không tăng thêm | ✅ |
| (mở rộng) | 10 lệnh hủy song song: đúng 1 thành công, chỉ hoàn vé 1 lần, chỉ có 1 sự kiện ORDER_CANCELLED | ✅ |
| Gửi sự kiện thất bại | Azure lỗi: đơn vẫn tạo được, sự kiện ở PENDING kèm lỗi và lịch thử lại; khi Azure hồi phục thì chuyển SENT | ✅ |
| (mở rộng) | Quá số lần thử thì FAILED, admin gửi lại thành công; 3 worker song song không gửi trùng; CANCELLED không bị gửi trước CREATED | ✅ |
| Validate quản trị | Giá âm, số lượng âm/lẻ, giờ sai: 400; giảm vé dưới số đang giữ: 409; khách gọi API admin: 403 | ✅ |
| Hạn hủy | Còn dưới 24 giờ: 422; admin vẫn hủy được | ✅ |
| Hủy cả sự kiện | Mọi đơn còn hiệu lực bị hủy, hoàn đúng vé từng hạng, mỗi đơn có đúng một `CANCELLED` trong outbox; đơn đã hủy trước và đơn của sự kiện khác không bị ảnh hưởng; gọi lại không sinh thêm bản ghi; không mở lại được | ✅ |
| (mở rộng) | 20 khách đặt vé song song với lệnh hủy sự kiện: không đơn nào còn hiệu lực, vé không lệch; 6 khách tự hủy song song với lệnh hủy sự kiện: vé hoàn đúng 1 lần | ✅ |
| Lease outbox | Bấm "Gửi lại" khi worker đang gửi: không đụng dòng đó, không gửi trùng; lease hết hạn và lượt khác đã gửi xong: kết quả lỗi đến muộn không ghi đè SENT | ✅ |
| Log minh chứng | Ghi đúng HTTP 201 (queue) và 200 (`/stats`, `/history`) Azure trả về; không ghi khi lỗi hoặc trả cache; không chứa SAS hay khóa | ✅ |
| Cấu hình GCP (Dương bổ sung) | CORS nhiều origin, thử lại khi quá giờ, giới hạn số lần thử, sai khóa không thử lại, giới hạn pool kết nối | ✅ |
| Migration | Cài mới bằng user không phải superuser (không có `pgcrypto`); nâng cấp DB đã có `001`/`002` và dữ liệu chỉ áp dụng `003`, không mất dòng nào | ✅ (chạy tay) |
| Thống kê Azure | Không kết nối được: 503; quá giờ: 504; Azure 5xx: 502; sai hoặc thiếu khóa: 502; Azure trả 400: 400; sai định dạng: 502; Azure lỗi nhưng có cache: trả `stale: true`; ghép đúng doanh thu từ DB; tham số sai bị chặn trước khi gọi Azure | ✅ |
| Mẫu thông điệp Azure | Validator đối chiếu 89 ca của Azure: 0 ca "mình nhận nhưng Azure từ chối"; thông điệp sai mẫu chuyển FAILED ngay, không gửi; `messageId` giữ nguyên qua các lần thử lại | ✅ |
| Tài khoản và phân quyền (Việt Đức) | Đăng nhập đúng/sai, thiếu trường, phiên thiếu/sai/hết hạn, khách gọi API quản trị, khách chỉ thấy đơn của mình; token của `npm run token` được nhận ở cả chế độ `local` và `jwt`, vai trò vẫn lấy từ DB | ✅ |
| Gửi qua Storage Queue | Dùng server queue giả lập kiểm tra dữ liệu thật gửi đi: JSON thô, không base64; `&` `<` được escape; đúng đường dẫn `/messages`; SAS lỗi 403 thì thử lại và không lộ chữ ký | ✅ |

Ngoài ra đã chạy thử server thật (bản build production) với dữ liệu seed. Hai request đồng thời tranh vé VVIP cuối cho kết quả một 201 và một 409; worker gửi đủ 5 sự kiện sang mock Azure theo đúng thứ tự.

---

## 5. Bàn giao

- Mã nguồn và hướng dẫn khởi tạo dữ liệu: `README.md` (docker compose, migrate, seed; seed lên Cloud SQL ở mục 4.3)
- Tài liệu API cho frontend: `docs/API.md`
- Hợp đồng với Azure: `docs/azure-message-contract.md`
- Bản chạy trên GCP: service Cloud Run `ticket-api` (`https://ticket-api-5iqotxgmrq-as.a.run.app`, API dưới `/api`), Cloud SQL `ticket-db`, region `asia-southeast1`. Cấu hình ở `README.md` mục 4.1; Dương build, deploy và kiểm tra bằng script trong `ticket-cloud`

### Kiểm thử tích hợp với Azure thật (12/11/2026, `npm run azure:smoke`)

| Bước | Kết quả |
|---|---|
| Gửi 1 thông điệp `BOOKED` (sự kiện riêng `SMOKE-TEST`) vào Storage Queue, gửi 2 lần với cùng `messageId` | Cả 2 lần trả **HTTP 201** |
| Hỏi `/history?orderId=…` | Azure đã xử lý sau khoảng **5 giây**; `count: 1`, tức lần gửi lại đã bị bỏ qua |
| Hỏi `/stats?groupBy=event&eventId=SMOKE-TEST` | **HTTP 200**, `bookedTickets: 1` (không phải 2), nên **cơ chế chống trùng theo `messageId` hoạt động** |
| Định dạng phản hồi `/stats` | Khớp schema backend đang kiểm tra (`groupBy`, `items`, `totals`) |

## 6. Việc còn phụ thuộc thành viên khác

| Việc | Phụ thuộc | Hiện trạng |
|---|---|---|
| Xác thực thật | Backend tài khoản phải phát JWT HS256 bằng cùng secret `ticket-jwt-secret`, claim `sub` (hoặc `userId`/`id`) và `role` | Bản cloud đang chạy `AUTH_MODE=jwt`; token test tạo bằng `npm run token`. Module đăng nhập của Việt Đức đã ghép vào backend (`AUTH_MODE=local`, migration `004_accounts.sql`). **Đang chờ Dương xác nhận** việc chuyển bản cloud sang `local`. Nếu họ dùng RS256 hoặc endpoint verify thì chỉ cần đổi cấu hình (`AUTH_JWT_PUBLIC_KEY` hoặc `AUTH_MODE=http`) |
| Gửi sự kiện sang Azure | SAS token do người làm Azure cấp | **Đã tích hợp và chạy thử với Azure thật thành công** (`PUBLISHER_MODE=azure-queue`). SAS hiện tại hết hạn ngày 15/01/2027, cần xin token mới trước ngày đó |
| Thống kê | `x-functions-key` do người làm Azure cấp | **Đã tích hợp và chạy thử với Azure thật thành công**: `/stats` và `/history` (`STATS_MODE=http`). Chế độ mock giả lập đúng API này |
| Thanh toán | Chưa thuộc phạm vi; đơn được xác nhận ngay khi đặt | Nếu cần, có thể thêm trạng thái PENDING_PAYMENT kèm thời hạn giữ vé |
