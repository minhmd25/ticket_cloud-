#!/bin/sh
# Ghi cấu hình lúc chạy từ biến môi trường của container (Cloud Run).
set -eu
cat > /usr/share/nginx/html/config.js <<CONFIG
window.__APP_CONFIG__ = { API_BASE_URL: "${API_BASE_URL:-}", USE_MOCK: "${USE_MOCK:-}" };
CONFIG
echo "config.js: API_BASE_URL=${API_BASE_URL:-<trống>} USE_MOCK=${USE_MOCK:-<trống>}"
