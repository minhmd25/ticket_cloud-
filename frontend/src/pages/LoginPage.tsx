import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, errorMessage, type User } from '../api';
import { homePathFor, useAuth } from '../auth/AuthContext';
import { MockFooter } from '../components/Layout';
import { Alert, FieldError, Icon } from '../components/ui';
import { config } from '../config';
import { DEMO_PASSWORDS } from '../api/mock/db';

interface Errors {
  username?: string;
  password?: string;
}

function validate(username: string, password: string): Errors {
  const errors: Errors = {};
  if (!username.trim()) errors.username = 'Vui lòng nhập tài khoản.';
  if (!password) errors.password = 'Vui lòng nhập mật khẩu.';
  return errors;
}

/** Chỉ quay lại trang cũ nếu vai trò được phép vào trang đó. */
function redirectTarget(user: User, from: unknown): string {
  if (typeof from !== 'string' || !from.startsWith('/') || from.startsWith('/login')) return homePathFor(user);
  if (from.startsWith('/admin') && user.role !== 'admin') return homePathFor(user);
  return from;
}

export function LoginPage() {
  const { status, user, login, sessionExpired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from;

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === 'authenticated' && user && !submitting) {
    return <Navigate to={homePathFor(user)} replace />;
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validate(username, password);
    setErrors(found);
    setFormError(null);
    if (found.username || found.password) return;

    setSubmitting(true);
    try {
      const loggedIn = await login(username.trim(), password);
      navigate(redirectTarget(loggedIn, from), { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVALID_CREDENTIALS') {
        setFormError('Sai tài khoản hoặc mật khẩu. Vui lòng kiểm tra lại.');
      } else if (error instanceof ApiError && error.code === 'ROUTE_NOT_FOUND') {
        setFormError('Backend chưa bật chức năng đăng nhập (cần chạy với AUTH_MODE=local).');
      } else {
        setFormError(errorMessage(error));
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="login">
      <div className="login__panel card">
        <div className="login__brand">
          <Icon name="ticket" className="brand__icon brand__icon--lg" />
          <div>
            <h1>Đăng nhập</h1>
            <p>Hệ thống đặt vé đa sự kiện · dùng chung cho khách hàng và quản trị viên</p>
          </div>
        </div>

        {sessionExpired && !formError && (
          <Alert kind="warning">Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.</Alert>
        )}
        {formError && <Alert kind="error">{formError}</Alert>}

        <form className="form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="username">Tài khoản</label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={Boolean(errors.username)}
              aria-describedby={errors.username ? 'username-error' : undefined}
              autoFocus
            />
            <FieldError id="username-error" message={errors.username} />
          </div>
          <div className="field">
            <label htmlFor="password">Mật khẩu</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'password-error' : undefined}
            />
            <FieldError id="password-error" message={errors.password} />
          </div>
          <button type="submit" className="btn btn--primary btn--block" disabled={submitting}>
            {submitting ? 'Đang đăng nhập…' : 'Đăng nhập'}
          </button>
        </form>

        {config.useMock && (
          <div className="login__hint">
            <p>Tài khoản mẫu (dữ liệu giả):</p>
            <ul>
              <li>
                Khách hàng: <code>alice</code> hoặc <code>bob</code> / <code>{DEMO_PASSWORDS.customer}</code>
              </li>
              <li>
                Quản trị viên: <code>admin1</code> / <code>{DEMO_PASSWORDS.admin}</code>
              </li>
            </ul>
          </div>
        )}
      </div>
      {config.useMock && <MockFooter />}
    </div>
  );
}
