# Frontend · Hệ thống đặt vé đa sự kiện (Nhóm 5)

Một ứng dụng web gồm hai khu vực dùng chung một màn hình đăng nhập:

| Khu vực | Đường dẫn | Người phụ trách |
|---|---|---|
| Khách hàng: tìm sự kiện, đặt vé, vé của tôi, hủy đơn | `/events`, `/my-tickets` | Ma Đức Minh |
| Quản trị: sự kiện, hạng vé, tra cứu đơn, thống kê | `/admin/...` | Nguyễn Quang Huy |

Công nghệ: React 18, TypeScript, Vite, React Router, Recharts (biểu đồ). Kiểm thử bằng Vitest + Testing Library và Playwright.

## Chạy thử ngay (không cần backend)

Cần Node.js 20 trở lên.

```bash
cd frontend
npm install
npm run dev
```

Mở http://localhost:5173. Ứng dụng chạy bằng **dữ liệu giả** ngay trong trình duyệt (`src/api/mock`), trả lời đúng theo [hợp đồng API](docs/API-CONTRACT.md).

| Vai trò | Tài khoản | Mật khẩu |
|---|---|---|
| Khách hàng | `khach` | `khach123` |
| Quản trị viên | `admin` | `admin123` |

Thanh màu vàng ở chân trang (chỉ có ở chế độ dữ liệu giả) cho phép **giả lập mất kết nối** và **đặt lại dữ liệu mẫu**.

## Chạy với backend thật

1. Sửa địa chỉ backend trong file `.env.api` (mặc định `http://localhost:8080`).
2. Chạy `npm run dev:api`.

Backend cần bật CORS cho `http://localhost:5173` (xem mục CORS trong [API-CONTRACT.md](docs/API-CONTRACT.md)).

## Kiểm thử

```bash
npm test          # 39 test: lớp API, giao diện khách hàng, giao diện quản trị
npm run e2e       # 4 kịch bản trên Chrome thật, chụp ảnh vào docs/screenshots
npm run typecheck
```

`npm run e2e` dùng Google Chrome đã cài trên máy. Để chạy trên một bản đã triển khai:
`E2E_BASE_URL=https://frontend-xxxx.a.run.app npm run e2e` (bản đó cần bật `USE_MOCK=true`).

## Build và triển khai lên GCP (Cloud Run)

Dành cho người phụ trách GCP (Hoàng Quốc Dương). Image dùng nginx, nghe cổng `$PORT` (mặc định 8080).

```bash
# Tạo kho image (làm một lần)
gcloud artifacts repositories create nhom5 --repository-format=docker --location=asia-southeast1

# Build và đẩy image bằng Cloud Build
gcloud builds submit frontend \
  --tag asia-southeast1-docker.pkg.dev/<PROJECT_ID>/nhom5/frontend:v1

# Triển khai
gcloud run deploy frontend \
  --image asia-southeast1-docker.pkg.dev/<PROJECT_ID>/nhom5/frontend:v1 \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --set-env-vars API_BASE_URL=https://<backend>.a.run.app
```

Biến môi trường của container (đọc lúc container khởi động, **không cần build lại** khi đổi):

| Biến | Ý nghĩa |
|---|---|
| `API_BASE_URL` | Địa chỉ backend chung, không có `/` ở cuối |
| `USE_MOCK` | `true` để chạy demo bằng dữ liệu giả khi backend chưa sẵn sàng |

Frontend không chứa mật khẩu cơ sở dữ liệu hay khóa Azure; mọi thứ bí mật nằm ở backend.

Chạy thử image trên máy: `docker build -t nhom5-frontend . && docker run -p 8080:8080 -e USE_MOCK=true nhom5-frontend`.

## Cấu trúc thư mục

```text
src/
  api/            gọi API: client.ts (lỗi, token, timeout), index.ts (các hàm API), types.ts
    mock/         backend giả: dữ liệu mẫu (db.ts) và xử lý request (server.ts)
  auth/           phiên đăng nhập chung, chặn trang khi chưa đăng nhập / không có quyền
  components/     khung trang, thông báo, trạng thái tải/rỗng/lỗi
  lib/            định dạng tiền, ngày giờ (giờ Việt Nam), hook tải dữ liệu
  pages/
    LoginPage.tsx         đăng nhập (dùng chung)
    customer/             giao diện khách hàng (Ma Đức Minh)
    admin/                giao diện quản trị (Nguyễn Quang Huy)
  test/           test giao diện
e2e/              kịch bản Playwright
docs/             hợp đồng API, báo cáo, ảnh chụp màn hình
nginx/, Dockerfile  đóng gói để triển khai
```

## Tài liệu

- [Hợp đồng API](docs/API-CONTRACT.md) — gửi cho hai bạn backend chốt.
- [Báo cáo phần giao diện khách hàng](docs/bao-cao-ma-duc-minh.md)
- [Báo cáo phần giao diện quản trị](docs/bao-cao-nguyen-quang-huy.md)
# cloud_fe
