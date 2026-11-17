import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { Alert, EmptyState, ErrorState, Icon, Loading, PageHeader } from '../../components/ui';
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
  return id ? <EditEvent id={id} /> : <CreateEvent />;
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
          onSubmit={async (input) => {
            const created = await api.admin.createEvent(input);
            navigate(`/admin/events/${encodeURIComponent(created.id)}/edit`, {
              replace: true,
              state: { flash: `Đã tạo sự kiện "${created.name}". Tiếp theo, hãy thêm các hạng vé.` },
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
  const { data: event, error, reload } = useAsync(() => api.getEvent(id), [id]);

  if (error && !event) {
    return (
      <>
        <PageHeader back={back} title="Chỉnh sửa sự kiện" />
        {error instanceof ApiError && error.status === 404 ? (
          <EmptyState title="Không tìm thấy sự kiện">Sự kiện có thể đã bị xóa.</EmptyState>
        ) : (
          <ErrorState error={error} onRetry={reload} title="Không tải được sự kiện" />
        )}
      </>
    );
  }
  if (!event) return <Loading label="Đang tải sự kiện…" />;

  return (
    <>
      <PageHeader back={back} title="Chỉnh sửa sự kiện" subtitle={event.name} />
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
          key={event.id}
          event={event}
          submitLabel="Lưu thay đổi"
          onCancel={() => navigate('/admin/events')}
          onSubmit={async (input) => {
            const updated = await api.admin.updateEvent(event.id, input);
            navigate('/admin/events', { state: { flash: `Đã lưu thay đổi cho sự kiện "${updated.name ?? input.name}".` } });
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
        <TicketTypeManager eventId={event.id} ticketTypes={event.ticketTypes} onChanged={reload} />
      </section>
    </>
  );
}
