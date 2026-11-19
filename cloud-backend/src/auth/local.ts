import jwt from 'jsonwebtoken';
import type { Queryable } from '../db';
import { verifyPassword } from './passwords';
import type { AuthProvider, AuthUser, LoginResult } from './types';

export const TOKEN_ISSUER = 'event-ticketing-backend';
export const TOKEN_AUDIENCE = 'event-ticketing-api';

type AccountRow = { user_id: string; role: AuthUser['role'] };

export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local';

  constructor(
    private readonly db: Queryable,
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {
    if (Buffer.byteLength(secret.trim(), 'utf8') < 32) {
      throw new Error('AUTH_MODE=local cần AUTH_JWT_SECRET ít nhất 32 byte');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new Error('AUTH_TOKEN_TTL_SECONDS phải là số nguyên dương');
    }
  }

  async login(username: string, password: string): Promise<LoginResult | null> {
    const { rows: [account] } = await this.db.query<AccountRow & { password_hash: string }>(
      'SELECT user_id, role, password_hash FROM accounts WHERE username = $1',
      [username],
    );
    const valid = await verifyPassword(password, account?.password_hash);
    if (!account || !valid) return null;

    const token = jwt.sign({}, this.secret, {
      algorithm: 'HS256',
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      subject: account.user_id,
      expiresIn: this.ttlSeconds,
    });
    return { token, expiresIn: this.ttlSeconds, userId: account.user_id, role: account.role };
  }

  async verify(token: string): Promise<AuthUser | null> {
    let claims: string | jwt.JwtPayload;
    try {
      claims = jwt.verify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
      });
    } catch {
      return null;
    }
    if (typeof claims === 'string' || typeof claims.sub !== 'string' || !claims.sub || !Number.isFinite(claims.exp)) {
      return null;
    }

    const { rows: [account] } = await this.db.query<AccountRow>(
      'SELECT user_id, role FROM accounts WHERE user_id = $1',
      [claims.sub],
    );
    return account ? { userId: account.user_id, role: account.role } : null;
  }
}
