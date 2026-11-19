import { config } from '../config';
import { getToken, notifyUnauthorized } from '../auth/session';
import { mockTransport } from './mock/server';

/** Lỗi thống nhất cho mọi lời gọi API. status = 0 nghĩa là không kết nối được. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** `error.details` nguyên văn từ backend (ví dụ `{ requested, available }`). */
  readonly details: unknown;
  /** Lỗi theo từng trường nhập, lấy từ `details: [{ path, message }]` của VALIDATION_ERROR. */
  readonly fieldErrors: Record<string, string>;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.fieldErrors = toFieldErrors(details);
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }

  /** Đọc một số trong `details`, ví dụ `available` hay `reserved`. */
  detailNumber(key: string): number | undefined {
    const value = (this.details as Record<string, unknown> | null)?.[key];
    return typeof value === 'number' ? value : undefined;
  }
}

function toFieldErrors(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(details)) {
    for (const item of details) {
      const path = (item as { path?: unknown })?.path;
      const message = (item as { message?: unknown })?.message;
      if (typeof path === 'string' && typeof message === 'string' && !(path in out)) out[path] = message;
    }
  }
  return out;
}

type QueryValue = string | number | boolean | undefined | null;

interface RequestOptions {
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
  /** Gửi kèm mã xác thực nếu đang đăng nhập. Mặc định: có. */
  auth?: boolean;
  /** Dùng mã xác thực này thay cho mã của phiên hiện tại. */
  token?: string;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: 'Dữ liệu gửi lên không hợp lệ.',
  401: 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn.',
  403: 'Bạn không có quyền thực hiện thao tác này.',
  404: 'Không tìm thấy dữ liệu.',
  409: 'Dữ liệu đã thay đổi. Vui lòng tải lại và thử lại.',
  422: 'Yêu cầu không thực hiện được.',
  500: 'Máy chủ gặp lỗi. Vui lòng thử lại sau.',
};

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '' && value !== false) params.set(key, String(value));
  }
  const qs = params.toString();
  return `${config.apiBaseUrl}${path}${qs ? `?${qs}` : ''}`;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // ví dụ trang lỗi HTML từ proxy
  }
}

interface ErrorBody {
  code?: string;
  message?: string;
  details?: unknown;
}

function extractError(body: unknown): ErrorBody {
  if (!body || typeof body !== 'object') return {};
  const maybe = body as { error?: unknown };
  const err = maybe.error && typeof maybe.error === 'object' ? maybe.error : body;
  return err as ErrorBody;
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, auth = true } = options;
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = options.token ?? (auth ? getToken() : null);
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let res: Response;
  try {
    const init: RequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    };
    const url = buildUrl(path, query);
    res = config.useMock ? await mockTransport(url, init) : await fetch(url, init);
  } catch {
    const timedOut = controller.signal.aborted;
    throw new ApiError(
      0,
      timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
      timedOut
        ? 'Máy chủ phản hồi quá lâu. Vui lòng thử lại.'
        : 'Không kết nối được tới máy chủ. Vui lòng kiểm tra mạng và thử lại.',
    );
  } finally {
    clearTimeout(timer);
  }

  const data = await readBody(res);
  if (!res.ok) {
    const err = extractError(data);
    if (res.status === 401 && token) notifyUnauthorized();
    const fallback = DEFAULT_MESSAGES[res.status] ?? (res.status >= 500 ? DEFAULT_MESSAGES[500] : 'Yêu cầu thất bại.');
    throw new ApiError(res.status, err.code ?? `HTTP_${res.status}`, err.message || fallback, err.details);
  }
  return data as T;
}

/** Lấy câu thông báo dễ hiểu cho người dùng từ một lỗi bất kỳ. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Đã có lỗi không mong muốn. Vui lòng thử lại.';
}

/** Lỗi "không tìm thấy": 404, hoặc 400 do mã trên đường dẫn không đúng định dạng UUID. */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || (error.status === 400 && error.code === 'VALIDATION_ERROR'));
}
