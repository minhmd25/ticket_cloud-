import { Link, useSearchParams } from 'react-router-dom';
import { api, type Order, type OrderStatus } from '../../api';
import { categoryIcon, EmptyState, ErrorState, Icon, Loading, PageHeader, Pager, StatusBadge } from '../../components/ui';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber, isPast, seatLabels, shortId, STATUS_OPTIONS } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const PAGE_SIZE = 20;

const FILTERS: Array<{ value: OrderStatus | ''; label: string }> = [{ value: '', label: 'Tất cả' }, ...STATUS_OPTIONS];

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
            <Icon name="refresh" className={loading && data ? 'spin' : ''} />
            {loading && data ? 'Đang tải…' : 'Tải lại'}
          </button>
        }
      />

      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Lọc theo trạng thái">
          {FILTERS.map((f) => (
            <button
              key={f.value || 'all'}
              type="button"
              className="segmented__item"
              aria-pressed={status === f.value}
              onClick={() => update('status', f.value)}
            >
              {f.label}
            </button>
          ))}
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
          <ul className={`ticket-list ${loading ? 'is-refreshing' : ''}`} aria-label="Danh sách đơn đặt vé của bạn">
            {orders.map((o) => (
              <TicketCard key={o.id} order={o} />
            ))}
          </ul>
          <Pager pagination={data.pagination} onPage={(p) => update('page', p > 1 ? String(p) : '')} disabled={loading} />
        </>
      )}
    </>
  );
}

function TicketCard({ order: o }: { order: Order }) {
  const past = isPast(o.event.startTime);
  return (
    <li className={`ticket ticket--${o.status.toLowerCase()} ${past ? 'is-past' : ''}`}>
      <div className={`ticket__art cover--${o.event.category}`} aria-hidden="true">
        <Icon name={categoryIcon(o.event.category)} />
      </div>
      <div className="ticket__main">
        <h2 className="ticket__title">{o.event.title}</h2>
        <p className="meta">
          <Icon name="calendar" />
          {formatEventTime(o.event.startTime)}
          {past && <span className="tag tag--plain">Đã diễn ra</span>}
        </p>
        <p className="meta">
          <Icon name="pin" />
          {o.event.venue}
        </p>
        <p className="ticket__tier">
          <strong>{formatNumber(o.quantity)} vé</strong> {o.ticketType.name}
          {o.seats.length > 0 && <span className="ticket__seats"> · Ghế {seatLabels(o.seats)}</span>}
        </p>
      </div>
      <div className="ticket__stub">
        <span className="ticket__code" title={o.id}>
          {shortId(o.id)}
        </span>
        <StatusBadge status={o.status} />
        <span className="ticket__amount">{formatCurrency(o.totalAmount)}</span>
        <span className="muted small">Đặt {formatDateTime(o.createdAt)}</span>
        <Link
          to={`/my-tickets/${encodeURIComponent(o.id)}`}
          className="btn btn--secondary btn--sm stretched-link"
          aria-label={`Xem chi tiết đơn ${shortId(o.id)}`}
        >
          Chi tiết
        </Link>
      </div>
    </li>
  );
}
