import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage, newIdempotencyKey, type EventDetail, type Order, type TicketType } from '../../api';
import { Alert, FieldError } from '../../components/ui';
import { formatCurrency, formatNumber, shortId } from '../../lib/format';

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
      case 'NETWORK_ERROR':
      case 'TIMEOUT':
        return 'Mất kết nối tới máy chủ nên chưa xác nhận được đơn. Hãy kiểm tra mạng rồi bấm "Đặt vé" lại: hệ thống nhận ra lần bấm này và sẽ không tạo đơn trùng.';
    }
  }
  // Các lỗi còn lại (vượt số vé mỗi đơn, sự kiện đã hủy/đã diễn ra, ...) dùng nguyên câu của backend.
  return errorMessage(error);
}

type Result = { kind: 'success'; order: Order } | { kind: 'error'; message: string } | null;

export function BookingForm({ event, onBooked }: { event: EventDetail; onBooked: () => void }) {
  const firstAvailable = event.ticketTypes.find((t) => t.availableQuantity > 0);
  const [ticketTypeId, setTicketTypeId] = useState<string>(firstAvailable ? String(firstAvailable.id) : '');
  const [quantity, setQuantity] = useState('1');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<Result>(null);
  // Khóa chống đặt trùng: giữ nguyên khi thử lại cùng hạng vé và số lượng sau lỗi mạng.
  const attempt = useRef<{ key: string; fingerprint: string } | null>(null);

  const selected = event.ticketTypes.find((t) => String(t.id) === ticketTypeId);

  // Hạng vé đang chọn không còn sau khi tải lại → bỏ chọn.
  useEffect(() => {
    if (ticketTypeId && !selected) setTicketTypeId('');
  }, [ticketTypeId, selected]);

  const ticketError = !selected ? 'Vui lòng chọn hạng vé.' : null;
  const quantityError = validateQuantity(quantity, selected);
  const subtotal = selected && !quantityError ? selected.price * Number(quantity) : null;
  const soldOutAll = event.ticketTypes.length > 0 && event.ticketTypes.every((t) => t.availableQuantity <= 0);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setTouched(true);
    if (ticketError || quantityError || !selected) return;

    const input = { ticketTypeId: selected.id, quantity: Number(quantity) };
    const fingerprint = `${input.ticketTypeId}:${input.quantity}`;
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { key: newIdempotencyKey(), fingerprint };

    setSubmitting(true);
    setResult(null);
    try {
      const order = await api.createOrder(input, attempt.current.key);
      attempt.current = null;
      setResult({ kind: 'success', order });
      setQuantity('1');
      setTouched(false);
      onBooked();
    } catch (error) {
      // Chỉ giữ khóa khi không biết đơn đã được tạo hay chưa (lỗi mạng).
      if (!(error instanceof ApiError && NETWORK_CODES.includes(error.code))) attempt.current = null;
      setResult({ kind: 'error', message: bookingErrorMessage(error) });
      // Số vé còn lại đã thay đổi: tải lại để khách thấy số mới.
      if (error instanceof ApiError && ['SOLD_OUT', 'INSUFFICIENT_TICKETS'].includes(error.code)) onBooked();
    } finally {
      setSubmitting(false);
    }
  };

  if (event.ticketTypes.length === 0) {
    return <p className="muted">Sự kiện chưa mở bán vé.</p>;
  }

  return (
    <form className="form booking" onSubmit={handleSubmit} noValidate aria-label="Đặt vé">
      {result?.kind === 'success' && (
        <Alert kind="success" onClose={() => setResult(null)}>
          <p>
            <strong>Đặt vé thành công!</strong> Mã đơn của bạn:{' '}
            <strong className="code" title={result.order.id}>
              {shortId(result.order.id)}
            </strong>
          </p>
          <p>
            {formatNumber(result.order.quantity)} vé {result.order.ticketType.name} ·{' '}
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

      <fieldset className="field" aria-describedby={touched && ticketError ? 'ticket-error' : undefined}>
        <legend>Hạng vé</legend>
        <div className="ticket-options">
          {event.ticketTypes.map((t) => {
            const soldOut = t.availableQuantity <= 0;
            const id = `tt-${t.id}`;
            return (
              <label key={t.id} htmlFor={id} className={`ticket-option ${soldOut ? 'is-disabled' : ''}`}>
                <input
                  id={id}
                  type="radio"
                  name="ticketType"
                  value={String(t.id)}
                  checked={ticketTypeId === String(t.id)}
                  disabled={soldOut || submitting}
                  onChange={() => setTicketTypeId(String(t.id))}
                />
                <span className="ticket-option__name">{t.name}</span>
                <span className="ticket-option__price">{formatCurrency(t.price)}</span>
                <span className="ticket-option__left">
                  {soldOut ? 'Hết vé' : `Còn ${formatNumber(t.availableQuantity)} vé`}
                </span>
              </label>
            );
          })}
        </div>
        {touched && <FieldError id="ticket-error" message={ticketError ?? undefined} />}
      </fieldset>

      <div className="field">
        <label htmlFor="quantity">Số lượng</label>
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
        {touched && <FieldError id="quantity-error" message={quantityError ?? undefined} />}
      </div>

      <div className="booking__total" aria-live="polite">
        <span>Tạm tính</span>
        <strong>{subtotal !== null ? formatCurrency(subtotal) : '—'}</strong>
      </div>
      {selected && subtotal !== null && (
        <p className="muted small">
          {quantity} × {formatCurrency(selected.price)} ({selected.name})
        </p>
      )}

      <button type="submit" className="btn btn--primary btn--block" disabled={submitting || soldOutAll}>
        {submitting ? 'Đang đặt vé…' : soldOutAll ? 'Đã hết vé' : 'Đặt vé'}
      </button>
    </form>
  );
}
