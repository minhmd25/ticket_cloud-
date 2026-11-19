import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { HomeRedirect, RequireAdmin, RequireAuth } from './auth/guards';
import { Layout } from './components/Layout';
import { EmptyState, Loading } from './components/ui';
import { LoginPage } from './pages/LoginPage';
import { EventDetailPage } from './pages/customer/EventDetailPage';
import { EventListPage } from './pages/customer/EventListPage';
import { MyTicketsPage } from './pages/customer/MyTicketsPage';
import { OrderDetailPage } from './pages/customer/OrderDetailPage';
import { AdminEventFormPage } from './pages/admin/AdminEventFormPage';
import { AdminEventsPage } from './pages/admin/AdminEventsPage';
import { AdminOrderDetailPage } from './pages/admin/AdminOrderDetailPage';
import { AdminOrdersPage } from './pages/admin/AdminOrdersPage';

// Trang thống kê dùng thư viện biểu đồ khá nặng: chỉ tải khi quản trị viên mở trang này.
const AdminDashboardPage = lazy(() =>
  import('./pages/admin/AdminDashboardPage').then((m) => ({ default: m.AdminDashboardPage })),
);

function NotFoundPage() {
  return (
    <main className="container">
      <EmptyState title="Không tìm thấy trang">
        <Link to="/">Về trang chủ</Link>
      </EmptyState>
    </main>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<HomeRedirect />} />

        {/* Giao diện khách hàng — Ma Đức Minh */}
        <Route element={<Layout variant="customer" />}>
          <Route path="events" element={<EventListPage />} />
          <Route path="events/:id" element={<EventDetailPage />} />
          <Route path="my-tickets" element={<MyTicketsPage />} />
          <Route path="my-tickets/:id" element={<OrderDetailPage />} />
        </Route>

        {/* Giao diện quản trị — Nguyễn Quang Huy */}
        <Route path="admin" element={<RequireAdmin />}>
          <Route element={<Layout variant="admin" />}>
            <Route index element={<Navigate to="events" replace />} />
            <Route path="events" element={<AdminEventsPage />} />
            <Route path="events/new" element={<AdminEventFormPage />} />
            <Route path="events/:id/edit" element={<AdminEventFormPage />} />
            <Route path="orders" element={<AdminOrdersPage />} />
            <Route path="orders/:id" element={<AdminOrderDetailPage />} />
            <Route
              path="stats"
              element={
                <Suspense fallback={<Loading label="Đang tải trang thống kê…" />}>
                  <AdminDashboardPage />
                </Suspense>
              }
            />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
