import { Link } from 'react-router-dom';
import { api } from '../../api';
import { EmptyState, ErrorState, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

export function MyTicketsPage() {
  const { data, error, loading, reload } = useAsync(() => api.listMyOrders(), []);
  const orders = data ? [...data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];

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

      {error && !data ? (
        <ErrorState error={error} onRetry={reload} title="Không tải được danh sách vé" />
      ) : !data ? (
        <Loading label="Đang tải vé của bạn…" />
      ) : orders.length === 0 ? (
        <EmptyState title="Bạn chưa đặt vé nào">
          <Link to="/events">Xem các sự kiện đang mở bán</Link>
        </EmptyState>
      ) : (
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
                  <td className="code">{o.id}</td>
                  <td>
                    <div className="cell-strong">{o.eventName}</div>
                    <div className="muted small">{formatEventTime(o.eventStartTime)}</div>
                  </td>
                  <td>{o.ticketTypeName}</td>
                  <td className="num">{formatNumber(o.quantity)}</td>
                  <td className="num">{formatCurrency(o.totalAmount)}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="nowrap">{formatDateTime(o.createdAt)}</td>
                  <td>
                    <Link to={`/my-tickets/${encodeURIComponent(o.id)}`} aria-label={`Xem chi tiết đơn ${o.id}`}>
                      Chi tiết
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
