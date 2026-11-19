export type Role = 'customer' | 'admin';

export interface AuthUser {
  userId: string;
  role: Role;
  email?: string;
  name?: string;
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  userId: string;
  role: Role;
}

/**
 * Hợp đồng với Backend tài khoản: nhận token từ request, trả về người dùng (hoặc null nếu token không hợp lệ).
 * Ném AppError 503 nếu không liên lạc được với dịch vụ tài khoản.
 */
export interface AuthProvider {
  readonly name: string;
  verify(token: string): Promise<AuthUser | null>;
  login?(username: string, password: string): Promise<LoginResult | null>;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
