import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  ApiError,
  errorMessage,
  newIdempotencyKey,
  type EventDetail,
  type Order,
  type Seat,
  type TicketType,
} from '../../api';
import { SeatMapView, tierColor, tierSlots, useSeatMapData, type SeatState } from '../../components/SeatMap';
import { Alert, FieldError, Icon } from '../../components/ui';
import { RULES } from '../../api/mock/db';
import { formatCurrency, formatNumber, seatLabels, shortId, sortSeats } from '../../lib/format';

/** Kiểm tra số lượng nhập vào. Trả về câu báo lỗi, hoặc null nếu hợp lệ. */
export function validateQuantity(value: string, ticketType: TicketType | undefined): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Vui lòng nhập số lượng vé.';
  if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) return 'Số lượng phải là số nguyên dương.';
  if (ticketType) {
    if (ticketType.availableQuantity <= 0) return 'Hạng vé này đã hết.';
    if (Number(trimmed) > ticketType.availableQuantity)
      return `Hạng vé này chỉ còn ${formatNumber(ticketType.availableQuantity)} vé.`;
  }
  return null;
}

const NETWORK_CODES = ['NETWORK_ERROR', 'TIMEOUT'];
const MAX_SEATS = RULES.maxTicketsPerOrder;
const SEAT_POLL_MS = 8000;

function bookingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'SOLD_OUT':
        return 'Rất tiếc, hạng vé này vừa hết. Vui lòng chọn hạng vé khác.';
      case 'INSUFFICIENT_TICKETS': {
        const available = error.detailNumber('available');
        return available !== undefined
          ? `Hạng vé này chỉ còn ${formatNumber(available)} vé. Vui lòng giảm số lượng và thử lại.`
          : `${error.message} Vui lòng giảm số lượng và thử lại.`;
      }
      case 'SEAT_TAKEN':
      case 'SEAT_BLOCKED':
        return `${error.message.replace(/\.$/, '')}. Sơ đồ ghế đã được cập nhật.`;
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        return 'Mất kết nối tới máy chủ nên chưa xác nhận được đơn. Hãy kiểm tra mạng rồi bấm "Đặt vé" lại: hệ thống nhận ra lần bấm này và sẽ không tạo đơn trùng.';
    }
  }
  // Các lỗi còn lại (vượt số vé mỗi đơn, sự kiện đã hủy/đã diễn ra, ...) dùng nguyên câu của backend.
  return errorMessage(error);
}

function stringList(details: unknown, key: string): string[] {
  const value = (details as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

type Result = { kind: 'success'; order: Order } | { kind: 'error'; message: string } | null;

interface BookingFormProps {
  event: EventDetail;
  /** Gọi sau khi đặt thành công hoặc khi số vé đã thay đổi, để trang tải lại số vé. */
  onChanged: () => void;
  /** Đặt thành công. Khi có hàng chờ, trang chờ hiển thị kết quả thay cho form. */
  onBooked?: (order: Order) => void;
  /** Backend báo chưa tới lượt (hàng chờ). */
  onQueueLost?: () => void;
  /** Bố cục rộng: sơ đồ ghế bên trái, tóm tắt bên phải. */
  wide?: boolean;
}

export function BookingForm({ event, onChanged, onBooked, onQueueLost, wide }: BookingFormProps) {
  const hasAssigned = event.ticketTypes.some((t) => t.seating === 'ASSIGNED');
  const firstAvailable = event.ticketTypes.find((t) => t.availableQuantity > 0);
  const [ticketTypeId, setTicketTypeId] = useState<string>(firstAvailable ? String(firstAvailable.id) : '');
  const [quantity, setQuantity] = useState('1');
  const [seatIds, setSeatIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const [hint, setHint] = useState<string | null>(null);
  // Khóa chống đặt trùng: giữ nguyên khi thử lại cùng yêu cầu sau lỗi mạng.
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);

  const seatData = useSeatMapData(event.id, { pollMs: SEAT_POLL_MS, enabled: hasAssigned && event.seatMap !== null });
  const { map, status } = seatData;
  const slots = useMemo(() => tierSlots(event.ticketTypes), [event.ticketTypes]);
  const sold = useMemo(() => new Set(status?.sold ?? []), [status]);
  const blocked = useMemo(() => new Set(status?.blocked ?? []), [status]);
  const seatById = useMemo(() => new Map((map?.seats ?? []).map((s) => [s.id, s])), [map]);

  const selected = event.ticketTypes.find((t) => String(t.id) === ticketTypeId);
  const seated = selected?.seating === 'ASSIGNED';

  // Hạng vé đang chọn không còn sau khi tải lại → bỏ chọn.
  useEffect(() => {
    if (ticketTypeId && !selected) setTicketTypeId('');
  }, [ticketTypeId, selected]);

  // Ghế đang chọn vừa bị người khác đặt / bị khóa (biết qua lần hỏi trạng thái định kỳ) → bỏ ra và báo.
  useEffect(() => {
    if (!status) return;
    const gone = seatIds.filter((id) => sold.has(id) || blocked.has(id));
    if (gone.length === 0) return;
    setSeatIds((ids) => ids.filter((id) => !gone.includes(id)));
    setTouched(false);
    const labels = gone.map((id) => seatById.get(id)?.label ?? '?').join(', ');
    setHint(`Ghế ${labels} vừa được người khác đặt hoặc ngừng bán nên đã được bỏ khỏi lựa chọn của bạn.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const ticketError = !selected ? 'Vui lòng chọn hạng vé.' : null;
  const quantityError = seated
    ? seatIds.length === 0
      ? 'Vui lòng chọn ít nhất một ghế trên sơ đồ.'
      : null
    : validateQuantity(quantity, selected);
  const count = seated ? seatIds.length : Number(quantity);
  const subtotal = selected && !quantityError ? selected.price * count : null;
  const soldOutAll = event.ticketTypes.length > 0 && event.ticketTypes.every((t) => t.availableQuantity <= 0);

  const chooseType = (t: TicketType) => {
    if (String(t.id) === ticketTypeId) return;
    setTicketTypeId(String(t.id));
    setSeatIds([]);
    setHint(null);
  };

  const stateOf = (s: Seat): SeatState =>
    seatIds.includes(s.id) ? 'selected' : sold.has(s.id) ? 'sold' : blocked.has(s.id) || s.blocked ? 'blocked' : 'available';
  const canSelect = (s: Seat) => !submitting && (seatIds.includes(s.id) || stateOf(s) === 'available');

  const toggleSeat = (s: Seat) => {
    setTouched(true);
    setResult((r) => (r?.kind === 'error' ? null : r));
    if (s.ticketTypeId !== ticketTypeId) {
      // Mỗi đơn chỉ gồm ghế của một hạng vé: chọn ghế hạng khác thì chuyển sang hạng đó.
      const t = event.ticketTypes.find((x) => x.id === s.ticketTypeId);
      setTicketTypeId(s.ticketTypeId);
      setSeatIds([s.id]);
      setHint(seatIds.length > 0 && t ? `Đã chuyển sang ${t.name}. Mỗi đơn chỉ gồm ghế của một hạng vé.` : null);
      return;
    }
    if (seatIds.includes(s.id)) {
      setSeatIds((ids) => ids.filter((id) => id !== s.id));
      setHint(null);
    } else if (seatIds.length >= MAX_SEATS) {
      setHint(`Mỗi đơn được chọn tối đa ${MAX_SEATS} ghế.`);
    } else {
      setSeatIds((ids) => [...ids, s.id]);
      setHint(null);
    }
  };

  const stepQuantity = (delta: number) => {
    const current = Number(quantity) || 0;
    const max = Math.min(MAX_SEATS, selected?.availableQuantity ?? MAX_SEATS);
    setQuantity(String(Math.min(Math.max(1, current + delta), Math.max(1, max))));
    setTouched(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setTouched(true);
    if (ticketError || quantityError || !selected) return;

    const ids = [...seatIds].sort();
    const input = seated ? { ticketTypeId: selected.id, seatIds: ids } : { ticketTypeId: selected.id, quantity: Number(quantity) };
    const fingerprint = seated ? `${selected.id}:${ids.join(',')}` : `${selected.id}:${quantity}`;
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { key: newIdempotencyKey(), fingerprint };

    setSubmitting(true);
    setResult(null);
    setHint(null);
    try {
      const order = await api.createOrder(input, attempt.current.key);
      attempt.current = null;
      setResult({ kind: 'success', order });
      setQuantity('1');
      setSeatIds([]);
      setTouched(false);
      onChanged();
      void seatData.refreshStatus();
      onBooked?.(order);
    } catch (error) {
      // Chỉ giữ khóa khi không biết đơn đã được tạo hay chưa (lỗi mạng).
      if (!(error instanceof ApiError && NETWORK_CODES.includes(error.code))) attempt.current = null;
      setResult({ kind: 'error', message: bookingErrorMessage(error) });
      if (error instanceof ApiError) {
        if (['SEAT_TAKEN', 'SEAT_BLOCKED'].includes(error.code)) {
          const taken = stringList(error.details, 'seatIds');
          setSeatIds((cur) => cur.filter((id) => !taken.includes(id)));
          setTouched(false); // chỉ báo "chưa chọn ghế" khi khách bấm đặt lần nữa
          void seatData.refreshStatus();
          onChanged();
        } else if (error.code === 'SEATS_NOT_FOUND') {
          setSeatIds([]);
          seatData.reload();
        } else if (['SOLD_OUT', 'INSUFFICIENT_TICKETS'].includes(error.code)) {
          // Số vé còn lại đã thay đổi: tải lại để khách thấy số mới.
          onChanged();
        } else if (['QUEUE_ADMISSION_REQUIRED', 'SALE_NOT_STARTED'].includes(error.code)) {
          onQueueLost?.();
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (event.ticketTypes.length === 0) {
    return <p className="muted">Sự kiện chưa mở bán vé.</p>;
  }

  const ticketOptions = (
    <fieldset className="field" aria-describedby={touched && ticketError ? 'ticket-error' : undefined}>
      <legend>Hạng vé</legend>
      <div className={`ticket-options ${wide ? 'ticket-options--row' : ''}`}>
        {event.ticketTypes.map((t) => {
          const soldOut = t.availableQuantity <= 0;
          const id = `tt-${t.id}`;
          const slot = slots.get(t.id);
          return (
            <label key={t.id} htmlFor={id} className={`ticket-option ${soldOut ? 'is-disabled' : ''}`}>
              <input
                id={id}
                type="radio"
                name="ticketType"
                value={String(t.id)}
                checked={ticketTypeId === String(t.id)}
                disabled={soldOut || submitting}
                onChange={() => chooseType(t)}
              />
              <span className="ticket-option__name">
                {slot && <span className="tier-dot" style={{ background: tierColor(slot) }} aria-hidden="true" />}
                {t.name}
              </span>
              <span className="ticket-option__price">{formatCurrency(t.price)}</span>
              <span className="ticket-option__left">
                {soldOut
                  ? 'Hết vé'
                  : t.seating === 'ASSIGNED'
                    ? `Chọn ghế · còn ${formatNumber(t.availableQuantity)} ghế`
                    : `Còn ${formatNumber(t.availableQuantity)} vé`}
              </span>
            </label>
          );
        })}
      </div>
      {touched && <FieldError id="ticket-error" message={ticketError ?? undefined} />}
    </fieldset>
  );

  const seatPicker = seated && (
    <div className="seat-picker">
      {event.seatMap === null ? (
        <Alert kind="info">Hạng vé này bán theo ghế nhưng sự kiện chưa có sơ đồ ghế. Vui lòng quay lại sau.</Alert>
      ) : seatData.error && !map ? (
        <Alert kind="error">
          Không tải được sơ đồ ghế. {errorMessage(seatData.error)}{' '}
          <button type="button" className="link-btn" onClick={seatData.reload}>
            Thử lại
          </button>
        </Alert>
      ) : !map ? (
        <p className="muted">Đang tải sơ đồ ghế…</p>
      ) : (
        <SeatMapView
          map={map}
          ticketTypes={event.ticketTypes}
          stateOf={stateOf}
          canSelect={canSelect}
          onSeatClick={toggleSeat}
          label={`Sơ đồ ghế ${event.title}. Chọn tối đa ${MAX_SEATS} ghế cùng một hạng vé.`}
          tierNote={(t) => `còn ${formatNumber(t.availableQuantity)} ghế`}
          disabled={submitting}
        />
      )}
    </div>
  );

  const quantityField = !seated && (
    <div className="field">
      <label htmlFor="quantity">Số lượng</label>
      <div className="stepper">
        <button
          type="button"
          className="stepper__btn"
          onClick={() => stepQuantity(-1)}
          disabled={submitting || Number(quantity) <= 1}
          aria-label="Giảm số lượng"
        >
          −
        </button>
        <input
          id="quantity"
          name="quantity"
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={quantity}
          disabled={submitting}
          onChange={(e) => {
            setQuantity(e.target.value);
            setTouched(true);
          }}
          aria-invalid={touched && Boolean(quantityError)}
          aria-describedby={touched && quantityError ? 'quantity-error' : undefined}
        />
        <button type="button" className="stepper__btn" onClick={() => stepQuantity(1)} disabled={submitting} aria-label="Tăng số lượng">
          +
        </button>
      </div>
      {touched && <FieldError id="quantity-error" message={quantityError ?? undefined} />}
    </div>
  );

  const chosenSeats = sortSeats(seatIds.map((id) => seatById.get(id)).filter((s): s is Seat => Boolean(s)));
  const summary = (
    <div className="booking__summary">
      {seated && (
        <div className="field">
          <span className="field__label" id="chosen-seats-label">
            Ghế đã chọn ({formatNumber(seatIds.length)}/{MAX_SEATS})
          </span>
          {chosenSeats.length === 0 ? (
            <p className="muted small">Bấm vào ghế còn trống trên sơ đồ để chọn.</p>
          ) : (
            <ul className="seat-chips" aria-labelledby="chosen-seats-label">
              {chosenSeats.map((s) => (
                <li key={s.id}>
                  <span>{s.label}</span>
                  <button type="button" onClick={() => toggleSeat(s)} aria-label={`Bỏ chọn ghế ${s.label}`} disabled={submitting}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {touched && <FieldError id="quantity-error" message={quantityError ?? undefined} />}
        </div>
      )}
      {quantityField}

      <div className="booking__total" aria-live="polite">
        <span>Tạm tính</span>
        <strong>{subtotal !== null ? formatCurrency(subtotal) : '—'}</strong>
      </div>
      {selected && subtotal !== null && (
        <p className="muted small">
          {formatNumber(count)} × {formatCurrency(selected.price)} ({selected.name})
        </p>
      )}

      <button type="submit" className="btn btn--primary btn--block btn--lg" disabled={submitting || soldOutAll}>
        <Icon name="ticket" />
        {submitting ? 'Đang đặt vé…' : soldOutAll ? 'Đã hết vé' : 'Đặt vé'}
      </button>
    </div>
  );

  const alerts = (
    <>
      {result?.kind === 'success' && (
        <Alert kind="success" onClose={() => setResult(null)}>
          <p>
            <strong>Đặt vé thành công!</strong> Mã đơn của bạn:{' '}
            <strong className="code" title={result.order.id}>
              {shortId(result.order.id)}
            </strong>
          </p>
          <p>
            {formatNumber(result.order.quantity)} vé {result.order.ticketType.name}
            {result.order.seats.length > 0 && ` (ghế ${seatLabels(result.order.seats)})`} ·{' '}
            {formatCurrency(result.order.totalAmount)}.{' '}
            <Link to={`/my-tickets/${encodeURIComponent(result.order.id)}`}>Xem đơn</Link> ·{' '}
            <Link to="/my-tickets">Vé của tôi</Link>
          </p>
        </Alert>
      )}
      {result?.kind === 'error' && (
        <Alert kind="error" onClose={() => setResult(null)}>
          {result.message}
        </Alert>
      )}
      {hint && (
        <Alert kind="info" onClose={() => setHint(null)}>
          {hint}
        </Alert>
      )}
    </>
  );

  return (
    <form className={`form booking ${wide ? 'booking--wide' : ''}`} onSubmit={handleSubmit} noValidate aria-label="Đặt vé">
      {alerts}
      {ticketOptions}
      {wide ? (
        <div className="booking__grid">
          <div className="booking__main">{seatPicker || <p className="muted">Hạng vé này không cần chọn ghế.</p>}</div>
          <aside className="booking__side">{summary}</aside>
        </div>
      ) : (
        <>
          {seatPicker}
          {summary}
        </>
      )}
    </form>
  );
}
