import { defineConfig } from '@playwright/test';

// Kiểm thử đầu-cuối trên Google Chrome đã cài trên máy.
//   npm run e2e       : frontend dùng backend giả trong trình duyệt
//   npm run e2e:api   : frontend gọi backend thật ở http://localhost:3000 (qua proxy của Vite)
//   E2E_BASE_URL=...  : chạy trên một bản đã triển khai, không bật dev server
//   E2E_SCREENSHOTS=1 : lưu ảnh chụp màn hình vào docs/screenshots
const externalUrl = process.env.E2E_BASE_URL;
const apiMode = process.env.E2E_MODE === 'api';
const port = apiMode ? 5175 : 5174;

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: externalUrl ?? `http://localhost:${port}`,
    channel: 'chrome',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1280, height: 860 },
    // Tắt hiệu ứng (biểu đồ, vòng xoay) để ảnh chụp và thao tác ổn định.
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: externalUrl
    ? undefined
    : {
        command: `npx vite ${apiMode ? '--mode api ' : ''}--port ${port} --strictPort`,
        url: `http://localhost:${port}`,
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
