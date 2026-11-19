import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { config } from '../config';
import { mockControls } from '../api/mock/server';
import { Icon } from './ui';

const CUSTOMER_NAV = [
  { to: '/events', label: 'Sự kiện' },
  { to: '/my-tickets', label: 'Vé của tôi' },
];

const ADMIN_NAV = [
  { to: '/admin/events', label: 'Sự kiện' },
  { to: '/admin/orders', label: 'Đơn đặt vé' },
  { to: '/admin/stats', label: 'Thống kê' },
];

export function Layout({ variant, children }: { variant: 'customer' | 'admin'; children?: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const nav = variant === 'admin' ? ADMIN_NAV : CUSTOMER_NAV;

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className={`app app--${variant}`}>
      <a className="skip-link" href="#main">
        Bỏ qua tới nội dung chính
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Link to={variant === 'admin' ? '/admin' : '/events'} className="brand">
            <Icon name="ticket" className="brand__icon" />
            <span>
              Đặt vé sự kiện
              {variant === 'admin' && <span className="brand__area">Quản trị</span>}
            </span>
          </Link>
          <nav className="topnav" aria-label={variant === 'admin' ? 'Điều hướng quản trị' : 'Điều hướng chính'}>
            {nav.map((item) => (
              <NavLink key={item.to} to={item.to} className="topnav__link">
                {item.label}
              </NavLink>
            ))}
            {variant === 'customer' && user?.role === 'admin' && (
              <NavLink to="/admin" className="topnav__link">
                Khu vực quản trị
              </NavLink>
            )}
          </nav>
          <div className="usermenu">
            <span className="usermenu__name">
              {user?.username}
              <span className="usermenu__role">{user?.role === 'admin' ? 'Quản trị viên' : 'Khách hàng'}</span>
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={handleLogout}>
              Đăng xuất
            </button>
          </div>
        </div>
      </header>
      <main id="main" className="container">
        {children ?? <Outlet />}
      </main>
      {config.useMock && <MockFooter />}
    </div>
  );
}

/** Thanh công cụ chỉ hiện khi chạy bằng dữ liệu giả: giả lập mất mạng, đặt lại dữ liệu mẫu. */
export function MockFooter() {
  const [offline, setOffline] = useState(mockControls.offline);
  const toggleOffline = () => {
    mockControls.setOffline(!offline);
    setOffline(!offline);
  };
  const reset = () => {
    if (window.confirm('Đặt lại toàn bộ dữ liệu mẫu? Các đơn và sự kiện bạn vừa tạo sẽ mất.')) {
      mockControls.reset();
      window.location.reload();
    }
  };
  return (
    <footer className="mockbar">
      <span>
        <strong>Chế độ dữ liệu giả</strong> · chưa nối backend thật
      </span>
      <label className="mockbar__toggle">
        <input type="checkbox" checked={offline} onChange={toggleOffline} />
        Giả lập mất kết nối
      </label>
      <button type="button" className="btn btn--ghost btn--sm" onClick={reset}>
        Đặt lại dữ liệu mẫu
      </button>
    </footer>
  );
}
