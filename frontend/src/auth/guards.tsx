import { Link, Navigate, Outlet, useLocation } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { Loading } from '../components/ui';
import { homePathFor, useAuth } from './AuthContext';

/** Chỉ cho vào khi đã đăng nhập; chưa đăng nhập thì chuyển tới trang đăng nhập. */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'checking') {
    return (
      <div className="fullscreen-center">
        <Loading label="Đang kiểm tra phiên đăng nhập…" />
      </div>
    );
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** Chỉ tài khoản quản trị mới vào được khu vực /admin. */
export function RequireAdmin() {
  const { user } = useAuth();
  if (user?.role !== 'admin') {
    return (
      <Layout variant="customer">
        <section className="no-access card" role="alert">
          <h1>Không có quyền truy cập</h1>
          <p>
            Tài khoản <strong>{user?.username}</strong> không có quyền vào khu vực quản trị. Vui lòng đăng nhập bằng tài
            khoản quản trị viên nếu bạn cần quản lý sự kiện.
          </p>
          <Link className="btn btn--primary" to="/events">
            Về trang sự kiện
          </Link>
        </section>
      </Layout>
    );
  }
  return <Outlet />;
}

export function HomeRedirect() {
  const { user } = useAuth();
  return <Navigate to={homePathFor(user)} replace />;
}
