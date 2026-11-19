import type { RequestHandler } from 'express';
import { Errors } from '../errors';
import type { AuthProvider, AuthUser } from './types';

/** Gắn req.user từ Bearer token hợp lệ. Route tự quyết định có yêu cầu đăng nhập hay không. */
export function authenticate(provider: AuthProvider): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header) return next();
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return next(Errors.unauthorized());
    try {
      const user = await provider.verify(m[1].trim());
      if (!user) return next(Errors.unauthorized());
      req.user = user;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(Errors.unauthorized());
  next();
};

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(Errors.unauthorized());
  if (req.user.role !== 'admin') return next(Errors.forbidden('Chỉ quản trị viên mới được thực hiện thao tác này'));
  next();
};

/** Dùng trong handler sau requireAuth */
export function currentUser(req: { user?: AuthUser }): AuthUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}
