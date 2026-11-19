import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, errorMessage, isNotFound } from '../../api';
import { Alert, EmptyState, ErrorState, Icon, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { OrderDetails } from '../../components/OrderDetails';
import { formatDateTime, formatNumber, isPast, shortId } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

type Message = { kind: 'success' | 'error'; text: string } | null;

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { data: order, error, reload, setData } = useAsync(() => api.getOrder(id), [id]);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [message, setMessage] = useState<Message>(null);

  const back = (
    <Link to="/my-tickets" className="back-link">
      <Icon name="arrowLeft" /> Vé của tôi
    </Link>
  );

  if (error && !order) {
    if (isNotFound(error)) {
      return (
        <>
          {back}
          <EmptyState title="Không tìm thấy đơn đặt vé">Đơn không tồn tại hoặc không thuộc tài khoản của bạn.</EmptyState>
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

  const handleCancel = async () => {
    setCancelling(true);
    setMessage(null);
    try {
      // Chỉ cập nhật giao diện sau khi API xác nhận hủy thành công.
      setData(await api.cancelOrder(order.id, reason.trim() || undefined));
      setMessage({ kind: 'success', text: 'Đã hủy đơn thành công. Số vé đã được trả lại cho sự kiện.' });
      setReason('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'ORDER_ALREADY_CANCELLED') {
        reload();
        setMessage({ kind: 'error', text: 'Đơn này đã được hủy trước đó.' });
      } else if (err instanceof ApiError && err.code === 'CANCELLATION_WINDOW_CLOSED') {
        reload();
        setMessage({ kind: 'error', text: `Không hủy được đơn. ${err.message}.` });
      } else {
        setMessage({ kind: 'error', text: `Không hủy được đơn. ${errorMessage(err)}` });
      }
    } finally {
      setCancelling(false);
      setConfirming(false);
    }
  };

  const eventStarted = isPast(order.event.startTime);

  return (
    <>
      <PageHeader
        back={back}
        title={`Đơn ${shortId(order.id)}`}
        subtitle={order.event.title}
        actions={<StatusBadge status={order.status} />}
      />

      {message && (
        <Alert kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      <div className="card">
        <OrderDetails order={order} eventLink={`/events/${encodeURIComponent(order.event.id)}`} />

        <div className="card__footer">
          {order.canCancel && !confirming && (
            <div className="footer-row">
              <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
                Yêu cầu hủy đơn
              </button>
              <span className="note">Được hủy đến {formatDateTime(order.cancellationDeadline)}.</span>
            </div>
          )}
          {order.canCancel && confirming && (
            <div className="confirm" role="group" aria-label="Xác nhận hủy đơn">
              <p>
                Bạn chắc chắn muốn hủy đơn <strong>{shortId(order.id)}</strong> ({formatNumber(order.quantity)} vé)? Thao tác
                này không thể hoàn tác.
              </p>
              <div className="field">
                <label htmlFor="cancel-reason">Lý do hủy (không bắt buộc)</label>
                <input
                  id="cancel-reason"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={cancelling}
                />
              </div>
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
          {order.status === 'CONFIRMED' && !order.canCancel && (
            <p className="muted">
              {eventStarted
                ? 'Sự kiện đã diễn ra nên không thể hủy đơn.'
                : `Đã quá hạn hủy đơn (chỉ được hủy đến ${formatDateTime(order.cancellationDeadline)}).`}
            </p>
          )}
          {order.status === 'CANCELLED' && <p className="muted">Đơn đã được hủy.</p>}
        </div>
      </div>
    </>
  );
}
