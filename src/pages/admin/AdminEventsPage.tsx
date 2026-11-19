import { useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, type EventStatus } from '../../api';
import {
  Alert,
  CategoryBadge,
  EmptyState,
  ErrorState,
  EventStatusBadge,
  Icon,
  Loading,
  PageHeader,
  Pager,
} from '../../components/ui';
import { EVENT_STATUS_OPTIONS, formatEventTime, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const PAGE_SIZE = 20;

export function AdminEventsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [flash, setFlash] = useState<string | null>((location.state as { flash?: string } | null)?.flash ?? null);

  const page = Math.max(1, Number(params.get('page')) || 1);
  const rawStatus = params.get('status') ?? '';
  const status = EVENT_STATUS_OPTIONS.some((o) => o.value === rawStatus) ? (rawStatus as EventStatus) : '';
  const includePast = params.get('past') === '1';

  const { data, error, loading, reload } = useAsync(
    () => api.admin.listEvents({ status: status || undefined, includePast, page, limit: PAGE_SIZE }),
    [status, includePast, page],
    { keepPreviousData: true },
  );
  const events = data?.data ?? [];

  const update = (key: 'status' | 'past' | 'page', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const dismissFlash = () => {
    setFlash(null);
    navigate(location.pathname + location.search, { replace: true, state: null });
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

      <div className="filters" aria-label="Lọc sự kiện">
        <div className="field field--inline">
          <label htmlFor="event-status-filter">Trạng thái</label>
          <select id="event-status-filter" value={status} onChange={(e) => update('status', e.target.value)}>
            <option value="">Tất cả</option>
            {EVENT_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <label className="checkbox">
          <input type="checkbox" checked={includePast} onChange={(e) => update('past', e.target.checked ? '1' : '')} />
          Hiện cả sự kiện đã kết thúc
        </label>
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} title="Không tải được danh sách sự kiện" />
      ) : !data ? (
        <Loading label="Đang tải danh sách sự kiện…" />
      ) : events.length === 0 ? (
        <EmptyState title="Không có sự kiện nào">
          {status || includePast ? 'Không có sự kiện phù hợp với bộ lọc.' : <Link to="/admin/events/new">Tạo sự kiện đầu tiên</Link>}
        </EmptyState>
      ) : (
        <>
          <div className={`table-wrap card ${loading ? 'is-refreshing' : ''}`}>
            <table className="table">
              <caption className="sr-only">Danh sách sự kiện</caption>
              <thead>
                <tr>
                  <th scope="col">Tên sự kiện</th>
                  <th scope="col">Loại hình</th>
                  <th scope="col">Thời gian</th>
                  <th scope="col">Địa điểm</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col" className="num">
                    Vé còn
                  </th>
                  <th scope="col">
                    <span className="sr-only">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id}>
                    <td className="cell-strong">{ev.title}</td>
                    <td>
                      <CategoryBadge category={ev.category} />
                    </td>
                    <td className="nowrap">{formatEventTime(ev.startTime)}</td>
                    <td>{ev.venue}</td>
                    <td>
                      <EventStatusBadge status={ev.status} />
                    </td>
                    <td className="num">{formatNumber(ev.totalAvailable)}</td>
                    <td className="actions">
                      <Link
                        to={`/admin/events/${encodeURIComponent(ev.id)}/edit`}
                        className="btn btn--secondary btn--sm"
                        aria-label={`Chỉnh sửa ${ev.title}`}
                      >
                        Chỉnh sửa
                      </Link>
                      <Link
                        to={`/admin/orders?eventId=${encodeURIComponent(ev.id)}`}
                        className="btn btn--ghost btn--sm"
                        aria-label={`Xem đơn của ${ev.title}`}
                      >
                        Đơn
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager pagination={data.pagination} onPage={(p) => update('page', p > 1 ? String(p) : '')} disabled={loading} />
        </>
      )}
    </>
  );
}
