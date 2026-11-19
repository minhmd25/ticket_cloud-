import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage, isNotFound, type EventDetail } from '../../api';
import { Alert, EmptyState, ErrorState, EventStatusBadge, Icon, Loading, PageHeader } from '../../components/ui';
import { formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { EventForm } from './EventForm';
import { TicketTypeManager } from './TicketTypeManager';

const back = (
  <Link to="/admin/events" className="back-link">
    <Icon name="arrowLeft" /> Danh sách sự kiện
  </Link>
);

export function AdminEventFormPage() {
  const { id } = useParams();
  return id ? <EditEvent key={id} id={id} /> : <CreateEvent />;
}

function CreateEvent() {
  const navigate = useNavigate();
  return (
    <>
      <PageHeader back={back} title="Tạo sự kiện" subtitle="Sau khi tạo, bạn sẽ khai báo các hạng vé cho sự kiện." />
      <section className="card">
        <EventForm
          submitLabel="Tạo sự kiện"
          onCancel={() => navigate('/admin/events')}
          onCreate={async (input) => {
            const created = await api.admin.createEvent(input);
            navigate(`/admin/events/${encodeURIComponent(created.id)}/edit`, {
              replace: true,
              state: { flash: `Đã tạo sự kiện "${created.title}". Tiếp theo, hãy thêm các hạng vé.` },
            });
          }}
        />
      </section>
    </>
  );
}

function EditEvent({ id }: { id: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [flash, setFlash] = useState<string | null>((location.state as { flash?: string } | null)?.flash ?? null);
  const { data: event, error, reload, setData } = useAsync(() => api.admin.getEvent(id), [id]);

  if (error && !event) {
    return (
      <>
        <PageHeader back={back} title="Chỉnh sửa sự kiện" />
        {isNotFound(error) ? (
          <EmptyState title="Không tìm thấy sự kiện">Kiểm tra lại đường dẫn.</EmptyState>
        ) : (
          <ErrorState error={error} onRetry={reload} title="Không tải được sự kiện" />
        )}
      </>
    );
  }
  if (!event) return <Loading label="Đang tải sự kiện…" />;

  return (
    <>
      <PageHeader back={back} title="Chỉnh sửa sự kiện" subtitle={event.title} actions={<EventStatusBadge status={event.status} />} />
      {flash && (
        <Alert kind="success" onClose={() => setFlash(null)}>
          {flash}
        </Alert>
      )}

      <section className="card" aria-labelledby="info-heading">
        <h2 id="info-heading" className="section-title section-title--flush">
          Thông tin sự kiện
        </h2>
        <EventForm
          key={`${event.id}-${event.status}`}
          event={event}
          submitLabel="Lưu thay đổi"
          onCancel={() => navigate('/admin/events')}
          onUpdate={async (patch) => {
            const updated = await api.admin.updateEvent(event.id, patch);
            navigate('/admin/events', { state: { flash: `Đã lưu thay đổi cho sự kiện "${updated.title}".` } });
          }}
        />
      </section>

      <section className="card" aria-labelledby="tickets-heading">
        <h2 id="tickets-heading" className="section-title section-title--flush">
          Hạng vé
        </h2>
        <p className="muted small">
          Số lượng bán là tổng số vé mở bán của hạng. Không thể giảm xuống dưới số vé khách đã đặt.
        </p>
        <TicketTypeManager
          eventId={event.id}
          ticketTypes={event.ticketTypes}
          readOnly={event.status === 'CANCELLED'}
          onChanged={reload}
        />
      </section>

      {event.status !== 'CANCELLED' && (
        <CancelEventSection
          event={event}
          onCancelled={(updated) => {
            setData(updated);
            setFlash(
              `Đã hủy sự kiện. ${formatNumber(updated.cancelledOrders ?? 0)} đơn còn hiệu lực đã được hủy và hoàn vé.`,
            );
          }}
        />
      )}
    </>
  );
}

/** Hủy cả sự kiện: backend hủy mọi đơn còn hiệu lực, hoàn vé và báo sang Azure trong một giao dịch. */
function CancelEventSection({ event, onCancelled }: { event: EventDetail; onCancelled: (e: EventDetail) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const booked = event.ticketTypes.reduce((sum, t) => sum + t.reservedQuantity, 0);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onCancelled(await api.admin.cancelEvent(event.id, reason.trim() || undefined));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <section className="card danger-zone" aria-labelledby="cancel-heading">
      <h2 id="cancel-heading" className="section-title section-title--flush">
        Hủy sự kiện
      </h2>
      <p className="muted small">
        Khách sẽ không đặt được vé nữa, toàn bộ đơn còn hiệu lực ({formatNumber(booked)} vé) bị hủy và hoàn vé. Không mở lại
        được sau khi hủy.
      </p>
      {error && <Alert kind="error">{error}</Alert>}
      {!open ? (
        <div>
          <button type="button" className="btn btn--danger" onClick={() => setOpen(true)}>
            Hủy sự kiện này
          </button>
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Xác nhận hủy sự kiện">
          <div className="field">
            <label htmlFor="cancel-event-reason">Lý do (ghi vào các đơn bị hủy)</label>
            <input
              id="cancel-event-reason"
              value={reason}
              maxLength={500}
              placeholder="Ví dụ: Ca sĩ ốm"
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="confirm__actions">
            <button type="button" className="btn btn--danger" onClick={confirm} disabled={busy}>
              {busy ? 'Đang hủy…' : 'Xác nhận hủy sự kiện'}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setOpen(false)} disabled={busy}>
              Không hủy
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
