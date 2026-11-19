import { Link, useParams } from 'react-router-dom';
import { api, isNotFound } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { CategoryBadge, EmptyState, ErrorState, Icon, Loading } from '../../components/ui';
import { formatCurrency, formatNumber, formatTimeRange, isPast } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { BookingForm } from './BookingForm';

export function EventDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const { data: event, error, loading, reload } = useAsync(() => api.getEvent(id), [id]);

  const back = (
    <Link to="/events" className="back-link">
      <Icon name="arrowLeft" /> Danh sách sự kiện
    </Link>
  );

  if (error && !event) {
    if (isNotFound(error)) {
      return (
        <>
          {back}
          <EmptyState title="Không tìm thấy sự kiện">
            Sự kiện có thể đã bị hủy, chưa mở bán hoặc đường dẫn không đúng.
          </EmptyState>
        </>
      );
    }
    return (
      <>
        {back}
        <ErrorState error={error} onRetry={reload} title="Không tải được thông tin sự kiện" />
      </>
    );
  }
  if (!event) return <Loading label="Đang tải thông tin sự kiện…" />;

  const started = isPast(event.startTime);

  return (
    <>
      {back}
      <div className="detail-layout">
        <article className="detail-main">
          <CategoryBadge category={event.category} />
          <h1 className="detail-title">{event.title}</h1>
          <p className="meta meta--lg">
            <Icon name="calendar" />
            {formatTimeRange(event.startTime, event.endTime)}
          </p>
          <p className="meta meta--lg">
            <Icon name="pin" />
            {event.venue}
          </p>
          {event.description && <p className="detail-description">{event.description}</p>}

          <h2 className="section-title">Hạng vé</h2>
          {event.ticketTypes.length === 0 ? (
            <p className="muted">Sự kiện chưa mở bán vé.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Hạng vé</th>
                    <th scope="col" className="num">
                      Giá
                    </th>
                    <th scope="col" className="num">
                      Còn lại
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {event.ticketTypes.map((t) => (
                    <tr key={t.id}>
                      <td>
                        {t.name}
                        {t.description && <div className="muted small">{t.description}</div>}
                      </td>
                      <td className="num">{formatCurrency(t.price)}</td>
                      <td className="num">
                        {t.availableQuantity > 0 ? (
                          `${formatNumber(t.availableQuantity)} / ${formatNumber(t.totalQuantity)}`
                        ) : (
                          <span className="badge badge--muted">Hết vé</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <aside className="detail-side card" aria-label="Đặt vé">
          <h2 className="section-title section-title--flush">Đặt vé</h2>
          {loading && <p className="muted small">Đang cập nhật số vé…</p>}
          {started ? (
            <p className="muted">Sự kiện đã diễn ra, không thể đặt vé.</p>
          ) : user?.role === 'admin' ? (
            <p className="muted">Bạn đang đăng nhập bằng tài khoản quản trị. Hãy dùng tài khoản khách hàng để đặt vé.</p>
          ) : (
            <BookingForm event={event} onBooked={reload} />
          )}
        </aside>
      </div>
    </>
  );
}
