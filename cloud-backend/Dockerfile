FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# trang test /dev - chỉ phục vụ khi đặt DEV_CONSOLE=true
COPY dev-console ./dev-console
EXPOSE 3000
# Cloud Run: chạy migration rồi khởi động server
CMD ["sh", "-c", "node dist/scripts/migrate.js && exec node dist/server.js"]
