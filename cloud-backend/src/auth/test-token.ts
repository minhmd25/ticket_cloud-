import jwt from 'jsonwebtoken';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from './local';
import type { Role } from './types';

export interface TestTokenOptions {
  sub: string;
  role: Role;
  ttlMinutes: number;
  email?: string;
  name?: string;
}

/**
 * Ký JWT HS256 dùng để thử API (script `npm run token`).
 * Có `iss`/`aud` của chế độ `local` nên cả `AUTH_MODE=local` lẫn `AUTH_MODE=jwt` đều nhận.
 * Ở chế độ `local`, `sub` phải là `user_id` có trong bảng `accounts` và vai trò được đọc từ DB.
 */
export function signTestToken(opts: TestTokenOptions, secret: string): string {
  return jwt.sign(
    {
      role: opts.role,
      ...(opts.email ? { email: opts.email } : {}),
      ...(opts.name ? { name: opts.name } : {}),
    },
    secret,
    {
      algorithm: 'HS256',
      subject: opts.sub,
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: opts.ttlMinutes * 60,
    },
  );
}
