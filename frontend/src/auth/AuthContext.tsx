import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, type User } from '../api';
import { clearSession, getSession, onUnauthorized, setSession } from './session';

type Status = 'checking' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: Status;
  user: User | null;
  /** true khi bị đăng xuất vì phiên hết hạn hoặc mã xác thực không còn hợp lệ. */
  sessionExpired: boolean;
  login: (username: string, password: string) => Promise<User>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => getSession()?.user ?? null);
  const [status, setStatus] = useState<Status>(() => (getSession() ? 'checking' : 'anonymous'));
  const [sessionExpired, setSessionExpired] = useState(false);

  const signOut = useCallback((expired: boolean) => {
    clearSession();
    setUser(null);
    setStatus('anonymous');
    setSessionExpired(expired);
  }, []);

  // API trả 401 ở bất kỳ đâu → đăng xuất và báo phiên hết hạn.
  useEffect(() => onUnauthorized(() => signOut(true)), [signOut]);

  // Có phiên đã lưu: hỏi lại backend xem mã xác thực còn dùng được không.
  useEffect(() => {
    if (status !== 'checking') return;
    let active = true;
    api.me().then(
      (fresh) => {
        if (!active) return;
        const session = getSession();
        if (session) setSession({ ...session, user: fresh });
        setUser(fresh);
        setStatus('authenticated');
      },
      (error: unknown) => {
        if (!active) return;
        if (error instanceof ApiError && error.status === 401) signOut(true);
        // Lỗi mạng: tạm tin phiên đã lưu, các API sau sẽ tự báo lỗi nếu cần.
        else setStatus('authenticated');
      },
    );
    return () => {
      active = false;
    };
  }, [status, signOut]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    setSession(res);
    setUser(res.user);
    setStatus('authenticated');
    setSessionExpired(false);
    return res.user;
  }, []);

  const logout = useCallback(() => signOut(false), [signOut]);

  const value = useMemo(
    () => ({ status, user, sessionExpired, login, logout }),
    [status, user, sessionExpired, login, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth phải dùng bên trong <AuthProvider>');
  return ctx;
}

/** Trang mặc định sau khi đăng nhập theo vai trò. */
export function homePathFor(user: User | null): string {
  return user?.role === 'admin' ? '/admin' : '/events';
}
