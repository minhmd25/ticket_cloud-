import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

/** Lỗi nghiệp vụ có mã rõ ràng để frontend xử lý */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: (msg = 'Chưa đăng nhập hoặc phiên không hợp lệ') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'Không có quyền thực hiện thao tác này') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (what: string, code = 'NOT_FOUND') => new AppError(404, code, `Không tìm thấy ${what}`),
  badRequest: (msg: string, details?: unknown) => new AppError(400, 'VALIDATION_ERROR', msg, details),
  conflict: (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details),
  unprocessable: (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details),
};

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `Không có route ${req.method} ${req.path}` } });
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dữ liệu không hợp lệ',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  // JSON body sai cú pháp
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Body không phải JSON hợp lệ' } });
    return;
  }
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Dữ liệu gửi lên quá lớn' } });
    return;
  }
  // Vi phạm CHECK constraint của DB (lớp bảo vệ cuối) -> 409 thay vì 500
  if (err?.code === '23514') {
    res.status(409).json({ error: { code: 'CONSTRAINT_VIOLATION', message: 'Dữ liệu vi phạm ràng buộc', details: err.constraint } });
    return;
  }
  if (err?.code === '22P02') {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Định danh không hợp lệ' } });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống' } });
};
