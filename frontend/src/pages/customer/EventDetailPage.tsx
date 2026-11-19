import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, isNotFound, type EventDetail, type TicketType } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { tierColor, tierSlots } from '../../components/SeatMap';
import { CategoryBadge, EmptyState, ErrorState, EventCover, Icon, Loading } from '../../components/ui';
import { formatCurrency, formatEventTime, formatNumber, formatTimeRange, isPast } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { BookingForm } from './BookingForm';
import { QueueGate } from './QueueGate';

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
  const wide = event.seatMap !== null && event.ticketTypes.some((t) => t.seating === 'ASSIGNED');
  const minPrice = event.ticketTypes.length ? Math.min(...event.ticketTypes.map((t) => t.price)) : null;
  const queueOn = Boolean(event.queue?.enabled);

  let booking: ReactNode;
  if (started) booking = <p className="muted">Sự kiện đã diễn ra, không thể đặt vé.</p>;
  else if (user?.role === 'admin')
    booking = <p className="muted">Bạn đang đăng nhập bằng tài khoản quản trị. Hãy dùng tài khoản khách hàng để đặt vé.</p>;
  else if (queueOn)
    booking = (
      <QueueGate event={event}>
        {(slot) => <BookingForm event={event} onChanged={reload} onBooked={slot.onBooked} onQueueLost={slot.onQueueLost} wide={wide} />}
      </QueueGate>
    );
  else booking = <BookingForm event={event} onChanged={reload} wide={wide} />;

  const bookingHeader = (
    <div className="booking-card__head">
      <h2 className="section-title section-title--flush">{wide ? 'Chọn ghế và đặt vé' : 'Đặt vé'}</h2>
      {loading && <span className="muted small">Đang cập nhật số vé…</span>}
    </div>
  );

  return (
    <>
      {back}
      <section className="event-hero" aria-labelledby="event-title">
        <EventCover category={event.category} startTime={event.startTime} className="event-hero__cover" />
        <div className="event-hero__body">
          <div className="badge-row">
            <CategoryBadge category={event.category} />
            {wide && (
              <span className="pill">
                <Icon name="seat" /> Chọn ghế trên sơ đồ
              </span>
            )}
            {queueOn && (
              <span className="pill pill--accent">
                <Icon name="users" /> Mở bán qua hàng chờ
              </span>
            )}
          </div>
          <h1 id="event-title" className="detail-title">
            {event.title}
          </h1>
          <p className="meta meta--lg">
            <Icon name="calendar" />
            {formatTimeRange(event.startTime, event.endTime)}
          </p>
          <p className="meta meta--lg">
            <Icon name="pin" />
            {event.venue}
          </p>
          {queueOn && event.queue && (
            <p className="meta meta--lg">
              <Icon name="clock" />
              Mở bán lúc {formatEventTime(event.queue.saleStartAt)}
            </p>
          )}
          {minPrice !== null && (
            <p className="event-hero__price">
              Giá từ <strong>{formatCurrency(minPrice)}</strong>
            </p>
          )}
        </div>
      </section>

      {wide ? (
        <>
          <div className="detail-grid">
            <About event={event} />
            <TicketTypeList event={event} />
          </div>
          <section className="card booking-card" aria-label="Đặt vé" id="dat-ve">
            {bookingHeader}
            {booking}
          </section>
        </>
      ) : (
        <div className="detail-layout">
          <div className="detail-main">
            <About event={event} />
            <TicketTypeList event={event} />
          </div>
          <aside className="detail-side card booking-card" aria-label="Đặt vé">
            {bookingHeader}
            {booking}
          </aside>
        </div>
      )}
    </>
  );
}

function About({ event }: { event: EventDetail }) {
  if (!event.description) return null;
  return (
    <section className="card card--flat" aria-labelledby="about-heading">
      <h2 id="about-heading" className="section-title section-title--flush">
        Giới thiệu
      </h2>
      <p className="detail-description">{event.description}</p>
    </section>
  );
}

/** Các hạng vé kèm thanh "còn lại / tổng" để khách thấy nhanh hạng nào sắp hết. */
function TicketTypeList({ event }: { event: EventDetail }) {
  const slots = tierSlots(event.ticketTypes);
  return (
    <section className="card card--flat" aria-labelledby="tiers-heading">
      <h2 id="tiers-heading" className="section-title section-title--flush">
        Hạng vé
      </h2>
      {event.ticketTypes.length === 0 ? (
        <p className="muted">Sự kiện chưa mở bán vé.</p>
      ) : (
        <ul className="tier-list">
          {event.ticketTypes.map((t) => (
            <TierRow key={t.id} t={t} slot={slots.get(t.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TierRow({ t, slot }: { t: TicketType; slot: number | undefined }) {
  const ratio = t.totalQuantity > 0 ? t.availableQuantity / t.totalQuantity : 0;
  const low = t.availableQuantity > 0 && ratio <= 0.15;
  return (
    <li className="tier">
      <div className="tier__head">
        <span className="tier__name">
          {slot && <span className="tier-dot" style={{ background: tierColor(slot) }} aria-hidden="true" />}
          {t.name}
          {t.seating === 'ASSIGNED' && <span className="tag tag--plain">Chọn ghế</span>}
        </span>
        <span className="tier__price">{formatCurrency(t.price)}</span>
      </div>
      {t.description && <p className="muted small">{t.description}</p>}
      <div className="meter" aria-hidden="true">
        <span className={`meter__fill ${low ? 'is-low' : ''}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
      </div>
      <p className="tier__left small">
        {t.availableQuantity > 0 ? (
          <>
            Còn <strong>{formatNumber(t.availableQuantity)}</strong> / {formatNumber(t.totalQuantity)}{' '}
            {t.seating === 'ASSIGNED' ? 'ghế' : 'vé'}
            {low && <span className="tier__warn"> · sắp hết</span>}
          </>
        ) : (
          <span className="badge badge--muted">Hết vé</span>
        )}
      </p>
    </li>
  );
}
