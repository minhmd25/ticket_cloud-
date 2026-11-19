import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { config } from '../config';
import { mockControls } from '../api/mock/server';
import { clearSession } from '../auth/session';

// Chờ tối đa 3 giây cho findBy/waitFor, tránh lỗi ngẫu nhiên khi máy bận chạy nhiều test song song.
configure({ asyncUtilTimeout: 3000 });

// Test chạy với backend giả, không độ trễ.
config.useMock = true;
config.mockLatencyMs = 0;

// Recharts cần ResizeObserver, jsdom không có sẵn.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  clearSession();
  mockControls.setOffline(false);
  mockControls.dropNextResponse = null;
  mockControls.reset();
});

afterEach(() => {
  cleanup();
});
