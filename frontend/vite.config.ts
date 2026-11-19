import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Khi chạy với backend thật, dev server chuyển tiếp /api sang backend để trình duyệt
  // coi như cùng một địa chỉ, không vướng CORS.
  const target = env.VITE_PROXY_TARGET;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: target ? { '/api': { target, changeOrigin: true, secure: true } } : undefined,
    },
    preview: {
      proxy: target ? { '/api': { target, changeOrigin: true, secure: true } } : undefined,
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      testTimeout: 20000,
    },
  };
});
