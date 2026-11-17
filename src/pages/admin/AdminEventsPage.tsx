import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Alert, CategoryBadge, EmptyState, ErrorState, Icon, Loading, PageHeader } from '../../components/ui';
import { formatEventTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

export function AdminEventsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [flash, setFlash] = useState<string | null>((location.state as { flash?: string } | null)?.flash ?? null);
  const { data, error, loading, reload } = useAsync(() => api.listEvents(), []);
  const events = data ? [...data].sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];

  const dismissFlash = () => {
    setFlash(null);
    navigate(location.pathname, { replace: true, state: null });
  };

  return (
    <>
      <PageHeader
        title="Quản lý sự kiện"
        subtitle="Tạo sự kiện mới, chỉnh sửa thông tin và khai báo hạng vé."
        actions={
          <Link to="/admin/events/new" className="btn btn--primary">
            <Icon name="plus" /> Tạo sự kiện
          </Link>
        }
      />

      {flash && (
        <Alert kind="success" onClose={dismissFlash}>
          {flash}
        </Alert>
      )}

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} title="Không tải được danh sách sự kiện" />
      ) : !data ? (
        <Loading label="Đang tải danh sách sự kiện…" />
      ) : events.length === 0 ? (
        <EmptyState title="Chưa có sự kiện nào">
          <Link to="/admin/events/new">Tạo sự kiện đầu tiên</Link>
        </EmptyState>
      ) : (
        <div className={`table-wrap card ${loading ? 'is-refreshing' : ''}`}>
          <table className="table">
            <caption className="sr-only">Danh sách sự kiện</caption>
            <thead>
              <tr>
                <th scope="col">Tên sự kiện</th>
                <th scope="col">Loại hình</th>
                <th scope="col">Thời gian</th>
                <th scope="col">Địa điểm</th>
                <th scope="col">
                  <span className="sr-only">Thao tác</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.id}>
                  <td className="cell-strong">{ev.name}</td>
                  <td>
                    <CategoryBadge category={ev.category} />
                  </td>
                  <td className="nowrap">{formatEventTime(ev.startTime)}</td>
                  <td>{ev.venue}</td>
                  <td className="actions">
                    <Link
                      to={`/admin/events/${encodeURIComponent(ev.id)}/edit`}
                      className="btn btn--secondary btn--sm"
                      aria-label={`Chỉnh sửa ${ev.name}`}
                    >
                      Chỉnh sửa
                    </Link>
                    <Link
                      to={`/admin/orders?eventId=${encodeURIComponent(ev.id)}`}
                      className="btn btn--ghost btn--sm"
                      aria-label={`Xem đơn của ${ev.name}`}
                    >
                      Đơn
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
