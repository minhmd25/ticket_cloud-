import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/global-setup.ts'],
    // các file test dùng chung 1 DB test => chạy tuần tự giữa các file
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
