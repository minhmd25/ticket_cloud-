// Cấu hình lấy theo thứ tự: public/config.js (lúc chạy) → biến VITE_* (lúc build).
// Nhờ vậy cùng một bản build có thể trỏ tới backend khác nhau khi triển khai trên GCP.

interface RuntimeConfig {
  API_BASE_URL?: string;
  USE_MOCK?: string | boolean;
}

declare global {
  interface Window {
    __APP_CONFIG__?: RuntimeConfig;
  }
}

const runtime: RuntimeConfig = (typeof window !== 'undefined' && window.__APP_CONFIG__) || {};

function pick(...values: Array<string | boolean | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return String(value);
  }
  return undefined;
}

export const config = {
  /** Địa chỉ backend chung, ví dụ https://backend-xxxx.a.run.app (không có / ở cuối). */
  apiBaseUrl: (pick(runtime.API_BASE_URL, import.meta.env.VITE_API_BASE_URL) ?? '').replace(/\/+$/, ''),
  /** true: mọi request đi vào backend giả trong trình duyệt (src/api/mock). */
  useMock: pick(runtime.USE_MOCK, import.meta.env.VITE_USE_MOCK) === 'true',
  /** Độ trễ giả lập của backend giả, để thấy được trạng thái đang tải. */
  mockLatencyMs: Number(import.meta.env.VITE_MOCK_LATENCY_MS ?? 350),
  /** Quá thời gian này thì coi như mất kết nối. */
  requestTimeoutMs: 15000,
};
