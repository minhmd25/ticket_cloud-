import { useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type Seating, type TicketType, type TicketTypeInput } from '../../api';
import { Alert, FieldError } from '../../components/ui';
import { formatCurrency, formatNumber } from '../../lib/format';

interface Values {
  name: string;
  price: string;
  totalQuantity: string;
  seating: Seating;
}

type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = { name: '', price: '', totalQuantity: '', seating: 'GENERAL' };

export const SEATING_OPTIONS: Array<{ value: Seating; label: string }> = [
  { value: 'GENERAL', label: 'Theo số lượng' },
  { value: 'ASSIGNED', label: 'Chọn ghế trên sơ đồ' },
];

export function validateTicketType(values: Values): Errors {
  const errors: Errors = {};
  if (!values.name.trim()) errors.name = 'Vui lòng nhập tên hạng vé.';
  else if (values.name.trim().length > 100) errors.name = 'Tên hạng vé tối đa 100 ký tự.';
  if (!values.price.trim()) errors.price = 'Vui lòng nhập giá.';
  else if (!/^\d+$/.test(values.price.trim())) errors.price = 'Giá phải là số nguyên không âm (VND).';
  if (values.seating === 'GENERAL') {
    if (!values.totalQuantity.trim()) errors.totalQuantity = 'Vui lòng nhập số lượng.';
    else if (!/^\d+$/.test(values.totalQuantity.trim())) errors.totalQuantity = 'Số lượng phải là số nguyên không âm.';
  }
  return errors;
}

/** Hạng chọn ghế không gửi totalQuantity: backend tính theo số ghế trên sơ đồ. */
const toInput = (v: Values): TicketTypeInput => ({
  name: v.name.trim(),
  price: Number(v.price),
  seating: v.seating,
  ...(v.seating === 'GENERAL' ? { totalQuantity: Number(v.totalQuantity) } : {}),
});

/** Đổi lỗi của backend thành lỗi dưới từng ô nhập. */
function pickErrors(error: unknown): Errors {
  if (!(error instanceof ApiError)) return {};
  if (error.code === 'QUANTITY_BELOW_RESERVED') {
    const reserved = error.detailNumber('reserved');
    return { totalQuantity: reserved !== undefined ? `Tối thiểu ${formatNumber(reserved)} vé.` : error.message };
  }
  if (error.code === 'TICKET_TYPE_NAME_TAKEN') return { name: 'Sự kiện đã có hạng vé cùng tên.' };
  if (error.code === 'SEAT_MANAGED_QUANTITY') return { totalQuantity: 'Số vé của hạng chọn ghế tính theo sơ đồ ghế.' };
  if (error.code === 'TICKET_TYPE_HAS_ORDERS') return { seating: 'Hạng vé đã có đơn, không đổi được cách bán.' };
  if (error.code === 'TICKET_TYPE_HAS_SEATS') return { seating: 'Gỡ các ghế của hạng này khỏi sơ đồ trước.' };
  const { name, price, totalQuantity, seating } = error.fieldErrors;
  return { name, price, totalQuantity, seating };
}

/** Quản lý hạng vé của một sự kiện: thêm mới, sửa giá và số lượng mở bán. */
export function TicketTypeManager({
  eventId,
  ticketTypes,
  readOnly,
  onChanged,
}: {
  eventId: string;
  ticketTypes: TicketType[];
  readOnly?: boolean;
  onChanged: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Values>(EMPTY);
  const [editErrors, setEditErrors] = useState<Errors>({});
  const [newValues, setNewValues] = useState<Values>(EMPTY);
  const [newErrors, setNewErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  const startEdit = (t: TicketType) => {
    setEditingId(String(t.id));
    setEditValues({ name: t.name, price: String(t.price), totalQuantity: String(t.totalQuantity), seating: t.seating });
    setEditErrors({});
    setMessage(null);
  };

  const saveEdit = async (t: TicketType) => {
    const found = validateTicketType(editValues);
    setEditErrors(found);
    if (Object.values(found).some(Boolean)) return;
    // PATCH: chỉ gửi trường đã đổi.
    const input = toInput(editValues);
    const patch: Partial<TicketTypeInput> = {};
    if (input.name !== t.name) patch.name = input.name;
    if (input.price !== t.price) patch.price = input.price;
    if (input.seating !== t.seating) patch.seating = input.seating;
    // Đổi sang bán theo số lượng: gửi kèm số vé (backend đặt về 0 khi đổi cách bán).
    if (input.totalQuantity !== undefined && (input.totalQuantity !== t.totalQuantity || patch.seating))
      patch.totalQuantity = input.totalQuantity;
    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await api.admin.updateTicketType(t.id, patch);
      setEditingId(null);
      setMessage({ kind: 'success', text: `Đã cập nhật hạng vé "${input.name}".` });
      onChanged();
    } catch (error) {
      // Hiển thị nguyên văn lỗi backend, ví dụ giảm số lượng xuống dưới số vé đã đặt.
      setEditErrors(pickErrors(error));
      setMessage({ kind: 'error', text: `Không lưu được hạng vé. ${errorMessage(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const addTicketType = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateTicketType(newValues);
    setNewErrors(found);
    if (Object.values(found).some(Boolean)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.admin.createTicketType(eventId, toInput(newValues));
      setMessage({ kind: 'success', text: `Đã thêm hạng vé "${newValues.name.trim()}".` });
      setNewValues(EMPTY);
      onChanged();
    } catch (error) {
      setNewErrors(pickErrors(error));
      setMessage({ kind: 'error', text: `Không thêm được hạng vé. ${errorMessage(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const editInput = (field: Exclude<keyof Values, 'seating'>, label: string, extra: Record<string, unknown> = {}) => (
    <>
      <input
        aria-label={label}
        value={editValues[field]}
        onChange={(e) => setEditValues((v) => ({ ...v, [field]: e.target.value }))}
        aria-invalid={Boolean(editErrors[field])}
        aria-describedby={editErrors[field] ? `edit-${field}-error` : undefined}
        disabled={busy}
        {...extra}
      />
      <FieldError id={`edit-${field}-error`} message={editErrors[field]} />
    </>
  );

  return (
    <div className="ticket-manager">
      {message && (
        <Alert kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      <div className="table-wrap">
        <table className="table">
          <caption className="sr-only">Các hạng vé của sự kiện</caption>
          <thead>
            <tr>
              <th scope="col">Hạng vé</th>
              <th scope="col">Cách bán</th>
              <th scope="col" className="num">
                Giá (VND)
              </th>
              <th scope="col" className="num">
                Số lượng bán
              </th>
              <th scope="col" className="num">
                Đã đặt
              </th>
              <th scope="col" className="num">
                Còn lại
              </th>
              {!readOnly && (
                <th scope="col">
                  <span className="sr-only">Thao tác</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {ticketTypes.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Chưa có hạng vé nào.{!readOnly && ' Thêm hạng vé ở bên dưới để mở bán.'}
                </td>
              </tr>
            )}
            {ticketTypes.map((t) => {
              const editing = editingId === String(t.id);
              return editing ? (
                <tr key={t.id} className="row-editing">
                  <td>{editInput('name', `Tên hạng vé ${t.name}`, { maxLength: 100 })}</td>
                  <td>
                    <select
                      aria-label={`Cách bán hạng vé ${t.name}`}
                      value={editValues.seating}
                      onChange={(e) => setEditValues((v) => ({ ...v, seating: e.target.value as Seating }))}
                      disabled={busy}
                    >
                      {SEATING_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                    <FieldError id="edit-seating-error" message={editErrors.seating} />
                  </td>
                  <td className="num">{editInput('price', `Giá hạng vé ${t.name}`, { inputMode: 'numeric' })}</td>
                  <td className="num">
                    {editValues.seating === 'ASSIGNED' ? (
                      <span className="muted small">Theo sơ đồ</span>
                    ) : (
                      editInput('totalQuantity', `Số lượng bán hạng vé ${t.name}`, { inputMode: 'numeric' })
                    )}
                  </td>
                  <td className="num">{formatNumber(t.reservedQuantity)}</td>
                  <td className="num">—</td>
                  <td className="actions">
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => saveEdit(t)} disabled={busy}>
                      {busy ? 'Đang lưu…' : 'Lưu'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => setEditingId(null)}
                      disabled={busy}
                    >
                      Hủy
                    </button>
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td className="cell-strong">{t.name}</td>
                  <td>
                    <span className={`tag ${t.seating === 'ASSIGNED' ? 'tag--seat' : 'tag--plain'}`}>
                      {t.seating === 'ASSIGNED' ? 'Chọn ghế' : 'Số lượng'}
                    </span>
                  </td>
                  <td className="num">{formatCurrency(t.price)}</td>
                  <td className="num">{formatNumber(t.totalQuantity)}</td>
                  <td className="num">{formatNumber(t.reservedQuantity)}</td>
                  <td className="num">
                    {t.availableQuantity > 0 ? (
                      formatNumber(t.availableQuantity)
                    ) : (
                      <span className="badge badge--muted">Hết vé</span>
                    )}
                  </td>
                  {!readOnly && (
                    <td className="actions">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        onClick={() => startEdit(t)}
                        disabled={busy || editingId !== null}
                        aria-label={`Sửa hạng vé ${t.name}`}
                      >
                        Sửa
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {!readOnly && (
        <form className="form ticket-add" onSubmit={addTicketType} noValidate aria-label="Thêm hạng vé">
          <h3 className="subsection-title">Thêm hạng vé</h3>
          <div className="ticket-add__fields">
            <div className="field">
              <label htmlFor="new-name">Tên hạng vé</label>
              <input
                id="new-name"
                value={newValues.name}
                maxLength={100}
                onChange={(e) => setNewValues((v) => ({ ...v, name: e.target.value }))}
                aria-invalid={Boolean(newErrors.name)}
                aria-describedby={newErrors.name ? 'new-name-error' : undefined}
                disabled={busy}
                placeholder="Ví dụ: VIP"
              />
              <FieldError id="new-name-error" message={newErrors.name} />
            </div>
            <div className="field">
              <label htmlFor="new-price">Giá (VND)</label>
              <input
                id="new-price"
                inputMode="numeric"
                value={newValues.price}
                onChange={(e) => setNewValues((v) => ({ ...v, price: e.target.value }))}
                aria-invalid={Boolean(newErrors.price)}
                aria-describedby={newErrors.price ? 'new-price-error' : undefined}
                disabled={busy}
                placeholder="500000"
              />
              <FieldError id="new-price-error" message={newErrors.price} />
            </div>
            <div className="field">
              <label htmlFor="new-seating">Cách bán</label>
              <select
                id="new-seating"
                value={newValues.seating}
                onChange={(e) => setNewValues((v) => ({ ...v, seating: e.target.value as Seating }))}
                disabled={busy}
              >
                {SEATING_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="new-quantity">Số lượng bán</label>
              <input
                id="new-quantity"
                inputMode="numeric"
                value={newValues.seating === 'ASSIGNED' ? '' : newValues.totalQuantity}
                onChange={(e) => setNewValues((v) => ({ ...v, totalQuantity: e.target.value }))}
                aria-invalid={Boolean(newErrors.totalQuantity)}
                aria-describedby={newErrors.totalQuantity ? 'new-quantity-error' : undefined}
                disabled={busy || newValues.seating === 'ASSIGNED'}
                placeholder={newValues.seating === 'ASSIGNED' ? 'Tính theo sơ đồ ghế' : '100'}
              />
              <FieldError id="new-quantity-error" message={newErrors.totalQuantity} />
            </div>
            <div className="ticket-add__submit">
              <button type="submit" className="btn btn--primary" disabled={busy}>
                Thêm hạng vé
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
