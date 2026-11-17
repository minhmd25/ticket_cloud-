import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { EmptyState, ErrorState, Icon, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

export function AdminOrderDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: order, error, reload } = useAsync(() => api.admin.getOrder(id), [id]);

  const back = (
    <button
      type="button"
      className="back-link"
      onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/admin/orders'))}
    >
      <Icon name="arrowLeft" /> Danh sách đơn
    </button>
  );

  if (error && !order) {
    return (
      <>
        <PageHeader back={back} title="Chi tiết đơn" />
        {error instanceof ApiError && error.status === 404 ? (
          <EmptyState title="Không tìm thấy đơn đặt vé">Kiểm tra lại mã đơn.</EmptyState>
        ) : (
          <ErrorState error={error} onRetry={reload} title="Không tải được đơn đặt vé" />
        )}
      </>
    );
  }
  if (!order) return <Loading label="Đang tải đơn đặt vé…" />;

  return (
    <>
      <PageHeader back={back} title={`Đơn ${order.id}`} subtitle={order.eventName} actions={<StatusBadge status={order.status} />} />
      <div className="card">
        <dl className="details">
          <div>
            <dt>Mã đơn</dt>
            <dd className="code">{order.id}</dd>
          </div>
          <div>
            <dt>Trạng thái</dt>
            <dd>
              <StatusBadge status={order.status} />
            </dd>
          </div>
          <div>
            <dt>Người đặt</dt>
            <dd>
              {order.username} <span className="muted small">(mã người dùng {order.userId})</span>
            </dd>
          </div>
          <div>
            <dt>Sự kiện</dt>
            <dd>
              <Link to={`/admin/events/${encodeURIComponent(order.eventId)}/edit`}>{order.eventName}</Link>
            </dd>
          </div>
          <div>
            <dt>Thời gian diễn ra</dt>
            <dd>{formatEventTime(order.eventStartTime)}</dd>
          </div>
          <div>
            <dt>Hạng vé</dt>
            <dd>{order.ticketTypeName}</dd>
          </div>
          <div>
            <dt>Số lượng</dt>
            <dd>{formatNumber(order.quantity)}</dd>
          </div>
          <div>
            <dt>Đơn giá</dt>
            <dd>{formatCurrency(order.unitPrice)}</dd>
          </div>
          <div>
            <dt>Thành tiền</dt>
            <dd className="cell-strong">{formatCurrency(order.totalAmount)}</dd>
          </div>
          <div>
            <dt>Ngày đặt</dt>
            <dd>{formatDateTime(order.createdAt)}</dd>
          </div>
          <div>
            <dt>Ngày hủy</dt>
            <dd>{order.cancelledAt ? formatDateTime(order.cancelledAt) : '—'}</dd>
          </div>
        </dl>
        <div className="card__footer">
          <Link to={`/admin/orders?eventId=${encodeURIComponent(order.eventId)}`} className="btn btn--secondary btn--sm">
            Các đơn khác của sự kiện này
          </Link>
        </div>
      </div>
    </>
  );
}
