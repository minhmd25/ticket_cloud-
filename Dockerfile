# ---- Bước 1: build bản tĩnh ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Bước 2: phục vụ bằng nginx (Cloud Run lắng nghe cổng $PORT, mặc định 8080) ----
FROM nginx:1.27-alpine
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/40-app-config.sh /docker-entrypoint.d/40-app-config.sh
RUN chmod +x /docker-entrypoint.d/40-app-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
# API_BASE_URL: địa chỉ backend chung. USE_MOCK=true: chạy demo bằng dữ liệu giả.
ENV PORT=8080 \
    API_BASE_URL="" \
    USE_MOCK=""
EXPOSE 8080
