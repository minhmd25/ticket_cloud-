import jwt from 'jsonwebtoken';
import type { Config } from '../config';
import type { Queryable } from '../db';
import { AppError } from '../errors';
import { LocalAuthProvider } from './local';
import type { AuthProvider, AuthUser, Role } from './types';

function normalizeRole(raw: unknown): Role {
  if (Array.isArray(raw)) return raw.map(String).some((r) => r.toLowerCase() === 'admin') ? 'admin' : 'customer';
  return String(raw ?? '').toLowerCase() === 'admin' ? 'admin' : 'customer';
}

/**
 * MOCK - dùng khi chưa có Backend tài khoản.
 * Token dạng: "mock:<userId>:<role>"  vd  "mock:alice:customer", "mock:boss:admin"
 */
export class MockAuthProvider implements AuthProvider {
  readonly name = 'mock';
  async verify(token: string): Promise<AuthUser | null> {
    const m = /^mock:([A-Za-z0-9_.@-]{1,100})(?::(customer|admin))?$/.exec(token);
    if (!m) return null;
    return { userId: m[1], role: (m[2] as Role) ?? 'customer' };
  }
}

/**
 * JWT - Backend tài khoản phát JWT, dịch vụ này tự verify bằng secret (HS256) hoặc public key (RS256).
 * Claim: sub|userId|id -> userId ; role|roles -> role
 */
export class JwtAuthProvider implements AuthProvider {
  readonly name = 'jwt';
  constructor(private readonly key: string, private readonly algorithms: jwt.Algorithm[]) {
    if (!key) throw new Error('AUTH_MODE=jwt cần AUTH_JWT_SECRET hoặc AUTH_JWT_PUBLIC_KEY');
  }
  async verify(token: string): Promise<AuthUser | null> {
    try {
      const p = jwt.verify(token, this.key, { algorithms: this.algorithms }) as jwt.JwtPayload;
      const userId = String(p.sub ?? p.userId ?? p.id ?? '');
      if (!userId) return null;
      return { userId, role: normalizeRole(p.role ?? p.roles), email: p.email, name: p.name };
    } catch {
      return null;
    }
  }
}

/**
 * HTTP - gọi sang Backend tài khoản để kiểm tra token & quyền.
 * GET {AUTH_SERVICE_URL}{AUTH_VERIFY_PATH}  (Authorization: Bearer <token>)
 * Kỳ vọng 200 + JSON { id|userId|sub, role|roles, email?, name? } ; 401/403 => token không hợp lệ.
 */
export class HttpAuthProvider implements AuthProvider {
  readonly name = 'http';
  constructor(private readonly url: string, private readonly timeoutMs: number) {}
  async verify(token: string): Promise<AuthUser | null> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new AppError(503, 'AUTH_SERVICE_UNAVAILABLE', 'Không kết nối được dịch vụ tài khoản', String(err));
    }
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new AppError(503, 'AUTH_SERVICE_UNAVAILABLE', `Dịch vụ tài khoản trả lỗi ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const u = (body.user ?? body.data ?? body) as Record<string, unknown>;
    const userId = String(u.id ?? u.userId ?? u.sub ?? '');
    if (!userId) return null;
    return {
      userId,
      role: normalizeRole(u.role ?? u.roles),
      email: u.email as string | undefined,
      name: u.name as string | undefined,
    };
  }
}

export function createAuthProvider(cfg: Config['auth'], db?: Queryable): AuthProvider {
  switch (cfg.mode) {
    case 'local':
      if (!db) throw new Error('AUTH_MODE=local cần kết nối PostgreSQL');
      return new LocalAuthProvider(db, cfg.jwtSecret, cfg.tokenTtlSeconds);
    case 'jwt':
      return cfg.jwtPublicKey
        ? new JwtAuthProvider(cfg.jwtPublicKey, ['RS256'])
        : new JwtAuthProvider(cfg.jwtSecret, ['HS256']);
    case 'http':
      return new HttpAuthProvider(cfg.serviceUrl.replace(/\/$/, '') + cfg.verifyPath, cfg.timeoutMs);
    case 'mock':
      return new MockAuthProvider();
    default:
      throw new Error(`AUTH_MODE không hợp lệ: ${cfg.mode}`);
  }
}
