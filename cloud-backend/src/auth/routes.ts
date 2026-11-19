import { Router } from 'express';
import { z } from 'zod';
import { AppError, Errors } from '../errors';
import type { AuthProvider } from './types';

const credentials = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9_.@-]{1,100}$/),
  password: z.string().min(1).max(256),
});

export function buildLoginRoutes(provider: AuthProvider): Router {
  const router = Router();
  const login = provider.login?.bind(provider);
  if (login) {
    router.post('/login', async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const input = credentials.safeParse(req.body);
      if (!input.success) throw Errors.badRequest('Vui lòng nhập tài khoản và mật khẩu hợp lệ');
      const result = await login(input.data.username, input.data.password);
      if (!result) throw new AppError(401, 'INVALID_CREDENTIALS', 'Tài khoản hoặc mật khẩu không đúng');
      res.json(result);
    });
  }
  return router;
}
