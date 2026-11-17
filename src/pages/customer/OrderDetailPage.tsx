import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, type Order } from '../../api';
import { Alert, EmptyState, ErrorState, Icon, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { formatCurrency, formatDateTime, formatEventTime, formatNumber, isPast } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

type Message = { kind: 'success' | 'error'; text: string } | null;

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { data: order, error, reload, setData } = useAsync(() => api.getOrder(id), [id]);
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const back = (
    <Link to="/my-tickets" className="back-link">
      <Icon name="arrowLeft" /> Vé của tôi
    </Link>
  );

  if (error && !order) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <>
          {back}
          <EmptyState title="Không tìm thấy đơn đặt vé">
            Đơn không tồn tại hoặc không thuộc tài khoản của bạn.
          </EmptyState>
        </>
      );
    }
    return (
      <>
        {back}
        <ErrorState error={error} onRetry={reload} title="Không tải được đơn đặt vé" />
      </>
    );
  }
  if (!order) return <Loading label="Đang tải đơn đặt vé…" />;

  const eventStarted = isPast(order.eventStartTime);
  const canCancel = order.status === 'CONFIRMED' && !eventStarted;

  const handleCancel = async () => {
    setCancelling(true);
    setMessage(null);
    try {
      const updated = await api.cancelOrder(order.id);
      // Chỉ cập nhật giao diện sau khi API xác nhận hủy thành công.
      if (updated && typeof updated === 'object' && 'status' in updated) setData(updated as Order);
      else reload();
      setMessage({ kind: 'success', text: 'Đã hủy đơn thành công. Số vé đã được trả lại cho sự kiện.' });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ALREADY_CANCELLED') {
        reload();
        setMessage({ kind: 'error', text: 'Đơn này đã được hủy trước đó.' });
      } else {
        setMessage({ kind: 'error', text: `Không hủy được đơn. ${errorMessage(err)}` });
      }
    } finally {
      setCancelling(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <PageHeader back={back} title={`Đơn ${order.id}`} subtitle={order.eventName} actions={<StatusBadge status={order.status} />} />

      {message && (
        <Alert kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

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
            <dt>Sự kiện</dt>
            <dd>
              <Link to={`/events/${encodeURIComponent(order.eventId)}`}>{order.eventName}</Link>
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
          {order.cancelledAt && (
            <div>
              <dt>Ngày hủy</dt>
              <dd>{formatDateTime(order.cancelledAt)}</dd>
            </div>
          )}
        </dl>

        <div className="card__footer">
          {canCancel && !confirming && (
            <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
              Yêu cầu hủy đơn
            </button>
          )}
          {canCancel && confirming && (
            <div className="confirm" role="group" aria-label="Xác nhận hủy đơn">
              <p>
                Bạn chắc chắn muốn hủy đơn <strong>{order.id}</strong> ({formatNumber(order.quantity)} vé)? Thao tác này
                không thể hoàn tác.
              </p>
              <div className="confirm__actions">
                <button type="button" className="btn btn--danger" onClick={handleCancel} disabled={cancelling}>
                  {cancelling ? 'Đang hủy…' : 'Xác nhận hủy'}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setConfirming(false)}
                  disabled={cancelling}
                >
                  Không hủy
                </button>
              </div>
            </div>
          )}
          {order.status === 'CONFIRMED' && eventStarted && (
            <p className="muted">Sự kiện đã diễn ra nên không thể hủy đơn.</p>
          )}
          {order.status === 'CANCELLED' && <p className="muted">Đơn đã được hủy.</p>}
        </div>
      </div>
    </>
  );
}
