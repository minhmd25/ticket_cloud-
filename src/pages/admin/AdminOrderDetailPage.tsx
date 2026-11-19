import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage, isNotFound } from '../../api';
import { OrderDetails } from '../../components/OrderDetails';
import { Alert, EmptyState, ErrorState, Icon, Loading, PageHeader, StatusBadge } from '../../components/ui';
import { formatNumber, shortId } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

export function AdminOrderDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data: order, error, reload, setData } = useAsync(() => api.admin.getOrder(id), [id]);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

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
        {isNotFound(error) ? (
          <EmptyState title="Không tìm thấy đơn đặt vé">Kiểm tra lại mã đơn.</EmptyState>
        ) : (
          <ErrorState error={error} onRetry={reload} title="Không tải được đơn đặt vé" />
        )}
      </>
    );
  }
  if (!order) return <Loading label="Đang tải đơn đặt vé…" />;

  // Quản trị viên hủy đơn: không bị giới hạn bởi hạn hủy của khách.
  const cancel = async () => {
    setBusy(true);
    setMessage(null);
    try {
      setData(await api.admin.cancelOrder(order.id, reason.trim() || undefined));
      setMessage({ kind: 'success', text: 'Đã hủy đơn và hoàn vé cho sự kiện.' });
      setConfirming(false);
    } catch (err) {
      setMessage({ kind: 'error', text: `Không hủy được đơn. ${errorMessage(err)}` });
      reload();
    } finally {
      setBusy(false);
    }
  };

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
        <OrderDetails order={order} eventLink={`/admin/events/${encodeURIComponent(order.event.id)}/edit`} showBuyer />
        <div className="card__footer footer-row">
          <Link to={`/admin/orders?eventId=${encodeURIComponent(order.event.id)}`} className="btn btn--secondary btn--sm">
            Các đơn khác của sự kiện này
          </Link>
          {order.status === 'CONFIRMED' && !confirming && (
            <button type="button" className="btn btn--danger btn--sm" onClick={() => setConfirming(true)}>
              Hủy đơn này
            </button>
          )}
        </div>
        {order.status === 'CONFIRMED' && confirming && (
          <div className="confirm" role="group" aria-label="Xác nhận hủy đơn">
            <p>
              Hủy đơn <strong>{shortId(order.id)}</strong> của <strong>{order.userId}</strong> ({formatNumber(order.quantity)}{' '}
              vé)? Vé sẽ được hoàn lại cho sự kiện.
            </p>
            <div className="field">
              <label htmlFor="admin-cancel-reason">Lý do (khách sẽ thấy)</label>
              <input
                id="admin-cancel-reason"
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
            </div>
            <div className="confirm__actions">
              <button type="button" className="btn btn--danger" onClick={cancel} disabled={busy}>
                {busy ? 'Đang hủy…' : 'Xác nhận hủy'}
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => setConfirming(false)} disabled={busy}>
                Không hủy
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
