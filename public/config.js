// Cấu hình lúc chạy. Khi triển khai bằng Docker, file này được ghi đè từ biến môi trường
// API_BASE_URL và USE_MOCK (xem nginx/40-app-config.sh). Để trống thì dùng giá trị lúc build.
window.__APP_CONFIG__ = window.__APP_CONFIG__ || {};
