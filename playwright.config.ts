import { defineConfig } from '@playwright/test';

// Kiểm thử đầu-cuối trên trình duyệt thật (Chrome đã cài trên máy), chạy với dữ liệu giả.
// Đặt E2E_BASE_URL để chạy trên một bản đã triển khai (ví dụ container Docker) thay vì dev server.
declare const process: { env: Record<string, string | undefined> };
const externalUrl = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: externalUrl ?? 'http://localhost:5174',
    channel: 'chrome',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1280, height: 860 },
  },
  webServer: externalUrl
    ? undefined
    : {
        command: 'npx vite --port 5174 --strictPort',
        url: 'http://localhost:5174',
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
