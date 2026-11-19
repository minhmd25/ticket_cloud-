import { Link, useSearchParams } from 'react-router-dom';
import { api, type OrderStatus } from '../../api';
import { EmptyState, ErrorState, Loading, PageHeader, Pager, StatusBadge } from '../../components/ui';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber, shortId, STATUS_OPTIONS } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const PAGE_SIZE = 20;

export function MyTicketsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const rawStatus = params.get('status') ?? '';
  const status = STATUS_OPTIONS.some((o) => o.value === rawStatus) ? (rawStatus as OrderStatus) : '';

  const { data, error, loading, reload } = useAsync(
    () => api.listMyOrders({ status: status || undefined, page, limit: PAGE_SIZE }),
    [status, page],
    { keepPreviousData: true },
  );
  const orders = data?.data ?? [];

  const update = (key: 'status' | 'page', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'status') next.delete('page');
    setParams(next);
  };

  return (
    <>
      <PageHeader
        title="Vé của tôi"
        subtitle="Các đơn đặt vé của tài khoản đang đăng nhập."
        actions={
          <button type="button" className="btn btn--secondary btn--sm" onClick={reload} disabled={loading}>
            {loading && data ? 'Đang tải…' : 'Tải lại'}
          </button>
        }
      />

      <div className="filters">
        <div className="field field--inline">
          <label htmlFor="my-status">Trạng thái</label>
          <select id="my-status" value={status} onChange={(e) => update('status', e.target.value)}>
            <option value="">Tất cả</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} title="Không tải được danh sách vé" />
      ) : !data ? (
        <Loading label="Đang tải vé của bạn…" />
      ) : orders.length === 0 ? (
        <EmptyState title={status ? 'Không có đơn phù hợp' : 'Bạn chưa đặt vé nào'}>
          <Link to="/events">Xem các sự kiện đang mở bán</Link>
        </EmptyState>
      ) : (
        <>
          <div className={`table-wrap card ${loading ? 'is-refreshing' : ''}`}>
            <table className="table">
              <caption className="sr-only">Danh sách đơn đặt vé của bạn</caption>
              <thead>
                <tr>
                  <th scope="col">Mã đơn</th>
                  <th scope="col">Sự kiện</th>
                  <th scope="col">Hạng vé</th>
                  <th scope="col" className="num">
                    Số lượng
                  </th>
                  <th scope="col" className="num">
                    Thành tiền
                  </th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Ngày đặt</th>
                  <th scope="col">
                    <span className="sr-only">Thao tác</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td className="code" title={o.id}>
                      {shortId(o.id)}
                    </td>
                    <td>
                      <div className="cell-strong">{o.event.title}</div>
                      <div className="muted small">{formatEventTime(o.event.startTime)}</div>
                    </td>
                    <td>{o.ticketType.name}</td>
                    <td className="num">{formatNumber(o.quantity)}</td>
                    <td className="num">{formatCurrency(o.totalAmount)}</td>
                    <td>
                      <StatusBadge status={o.status} />
                    </td>
                    <td className="nowrap">{formatDateTime(o.createdAt)}</td>
                    <td>
                      <Link to={`/my-tickets/${encodeURIComponent(o.id)}`} aria-label={`Xem chi tiết đơn ${shortId(o.id)}`}>
                        Chi tiết
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
