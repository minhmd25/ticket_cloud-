import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';
import { config } from '../config';
import { mockControls } from '../api/mock/server';
import { clearSession } from '../auth/session';

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
  clearSession();
  mockControls.setOffline(false);
  mockControls.reset();
});

afterEach(() => {
  cleanup();
});
