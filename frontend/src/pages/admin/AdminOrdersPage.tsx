import { Link, useSearchParams } from 'react-router-dom';
import { api, type OrderStatus } from '../../api';
import { EmptyState, ErrorState, Loading, PageHeader, Pager, StatusBadge } from '../../components/ui';
import { formatCurrency, formatDateTime, formatNumber, seatLabels, shortId, STATUS_OPTIONS } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const PAGE_SIZE = 20;

export function AdminOrdersPage() {
  const [params, setParams] = useSearchParams();
  const eventId = params.get('eventId') ?? '';
  const rawStatus = params.get('status') ?? '';
  const status = STATUS_OPTIONS.some((o) => o.value === rawStatus) ? (rawStatus as OrderStatus) : '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Danh sách để chọn sự kiện: mọi trạng thái, kể cả sự kiện đã kết thúc.
  const events = useAsync(() => api.admin.listEvents({ includePast: true, limit: 100 }), []);
  const orders = useAsync(
    () => api.admin.listOrders({ eventId: eventId || undefined, status: status || undefined, page, limit: PAGE_SIZE }),
    [eventId, status, page],
    { keepPreviousData: true },
  );

  const update = (key: 'eventId' | 'status' | 'page', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  };

  const list = orders.data?.data ?? [];
  const summary = orders.data?.summary ?? {};
  const confirmed = summary.CONFIRMED;
  const cancelled = summary.CANCELLED;
  const hasFilter = Boolean(eventId || status);
  const eventOptions = events.data?.data ?? [];

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
          <select id="filter-event" value={eventId} onChange={(e) => update('eventId', e.target.value)}>
            <option value="">Tất cả sự kiện</option>
            {eventId && !eventOptions.some((ev) => ev.id === eventId) && <option value={eventId}>Sự kiện đang chọn</option>}
            {eventOptions.map((ev) => (
              <option key={ev.id} value={String(ev.id)}>
                {ev.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--inline">
          <label htmlFor="filter-status">Trạng thái</label>
          <select id="filter-status" value={status} onChange={(e) => update('status', e.target.value)}>
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
          <p className="muted small summary-line" aria-live="polite">
            {formatNumber(orders.data.pagination.total)} đơn
            {confirmed &&
              ` · Đã xác nhận: ${formatNumber(confirmed.orders)} đơn, ${formatNumber(confirmed.tickets)} vé, ${formatCurrency(confirmed.amount)}`}
            {cancelled && ` · Đã hủy: ${formatNumber(cancelled.orders)} đơn, ${formatNumber(cancelled.tickets)} vé`}
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
                    <td className="code" title={o.id}>
                      {shortId(o.id)}
                    </td>
                    <td>{o.event.title}</td>
                    <td>
                      {o.ticketType.name}
                      {o.seats.length > 0 && <div className="muted small">Ghế {seatLabels(o.seats)}</div>}
                    </td>
                    <td className="num">{formatNumber(o.quantity)}</td>
                    <td>{o.userId}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="nowrap">{formatDateTime(o.createdAt)}</td>
                    <td>
                      <Link to={`/admin/orders/${encodeURIComponent(o.id)}`} aria-label={`Xem chi tiết đơn ${shortId(o.id)}`}>
                        Chi tiết
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            pagination={orders.data.pagination}
            onPage={(p) => update('page', p > 1 ? String(p) : '')}
            disabled={orders.loading}
          />
        </>
      )}
    </>
  );
}
