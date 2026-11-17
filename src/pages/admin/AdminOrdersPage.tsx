import { Link, useSearchParams } from 'react-router-dom';
import { api, type OrderStatus } from '../../api';
import { EmptyState, ErrorState, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { formatDateTime, formatNumber, STATUS_OPTIONS } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

export function AdminOrdersPage() {
  const [params, setParams] = useSearchParams();
  const eventId = params.get('eventId') ?? '';
  const rawStatus = params.get('status') ?? '';
  const status = STATUS_OPTIONS.some((o) => o.value === rawStatus) ? (rawStatus as OrderStatus) : '';

  const events = useAsync(() => api.listEvents(), []);
  const orders = useAsync(
    () => api.admin.listOrders({ eventId: eventId || undefined, status: status || undefined }),
    [eventId, status],
    { keepPreviousData: true },
  );

  const updateFilter = (key: 'eventId' | 'status', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  const list = orders.data ?? [];
  const totalTickets = list.reduce((sum, o) => sum + o.quantity, 0);
  const hasFilter = Boolean(eventId || status);

  return (
    <>
      <PageHeader
        title="Tra cứu đơn đặt vé"
        subtitle="Lọc đơn theo sự kiện và trạng thái, mở từng đơn để xem chi tiết."
        actions={
          <button type="button" className="btn btn--secondary btn--sm" onClick={orders.reload} disabled={orders.loading}>
            {orders.loading && orders.data ? 'Đang tải…' : 'Tải lại'}
          </button>
        }
      />

      <div className="filters" role="search" aria-label="Lọc đơn đặt vé">
        <div className="field field--inline">
          <label htmlFor="filter-event">Sự kiện</label>
          <select id="filter-event" value={eventId} onChange={(e) => updateFilter('eventId', e.target.value)}>
            <option value="">Tất cả sự kiện</option>
            {(events.data ?? []).map((ev) => (
              <option key={ev.id} value={String(ev.id)}>
                {ev.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--inline">
          <label htmlFor="filter-status">Trạng thái</label>
          <select id="filter-status" value={status} onChange={(e) => updateFilter('status', e.target.value)}>
            <option value="">Tất cả trạng thái</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {hasFilter && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setParams({})}>
            Xóa bộ lọc
          </button>
        )}
      </div>

      {orders.error && !orders.data ? (
        <ErrorState error={orders.error} onRetry={orders.reload} title="Không tải được danh sách đơn" />
      ) : !orders.data ? (
        <Loading label="Đang tải danh sách đơn…" />
      ) : list.length === 0 ? (
        <EmptyState title="Không có đơn nào">
          {hasFilter ? 'Không có đơn phù hợp với bộ lọc hiện tại.' : 'Chưa có khách nào đặt vé.'}
        </EmptyState>
      ) : (
        <>
          <p className="muted small" aria-live="polite">
            {formatNumber(list.length)} đơn · {formatNumber(totalTickets)} vé
          </p>
          <div className={`table-wrap card ${orders.loading ? 'is-refreshing' : ''}`}>
            <table className="table">
              <caption className="sr-only">Danh sách đơn đặt vé</caption>
              <thead>
                <tr>
                  <th scope="col">Mã đơn</th>
                  <th scope="col">Sự kiện</th>
                  <th scope="col">Hạng vé</th>
                  <th scope="col" className="num">
                    Số lượng
                  </th>
                  <th scope="col">Người đặt</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Ngày đặt</th>
                  <th scope="col">
                    <span className="sr-only">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((o) => (
                  <tr key={o.id}>
                    <td className="code">{o.id}</td>
                    <td>{o.eventName}</td>
                    <td>{o.ticketTypeName}</td>
                    <td className="num">{formatNumber(o.quantity)}</td>
                    <td>{o.username}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="nowrap">{formatDateTime(o.createdAt)}</td>
                    <td>
                      <Link to={`/admin/orders/${encodeURIComponent(o.id)}`} aria-label={`Xem chi tiết đơn ${o.id}`}>
                        Chi tiết
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
