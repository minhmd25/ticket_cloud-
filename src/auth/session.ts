import type { User } from '../api/types';

// Phiên đăng nhập dùng chung cho cả khu vực khách hàng và quản trị.
// Lưu trong sessionStorage theo hướng dẫn của backend: tải lại trang vẫn giữ phiên,
// đóng tab thì phiên mất; mỗi tab có thể đăng nhập một tài khoản khác nhau.

export interface Session {
  token: string;
  user: User;
}

const SESSION_KEY = 'nhom5.session';

function read(): Session | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session;
    return parsed?.token && parsed?.user ? parsed : null;
  } catch {
    return null;
  }
}

let current: Session | null = read();

export function getSession(): Session | null {
  return current;
}

export function getToken(): string | null {
  return current?.token ?? null;
}

export function setSession(session: Session): void {
  current = session;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Trình duyệt chặn lưu trữ: phiên vẫn dùng được tới khi tải lại trang.
  }
}

export function clearSession(): void {
  current = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // bỏ qua
  }
}

// Khi API trả 401 cho một request có mã xác thực, báo cho AuthProvider đăng xuất.
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export function notifyUnauthorized(): void {
  unauthorizedListeners.forEach((listener) => listener());
}
