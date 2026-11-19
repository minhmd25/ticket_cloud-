import { useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, type EventDetail, type EventInput, type EventPatch } from '../../api';
import { Alert, FieldError } from '../../components/ui';
import { isoToVnInput, vnInputToIso } from '../../lib/dates';
import { CATEGORY_OPTIONS, categoryLabel } from '../../lib/format';

interface Values {
  title: string;
  category: string;
  status: 'DRAFT' | 'PUBLISHED';
  startTime: string; // giá trị ô datetime-local, giờ Việt Nam
  endTime: string;
  venue: string;
  description: string;
}

type Errors = Partial<Record<keyof Values, string>>;

const FIELD_ORDER: Array<keyof Values> = ['title', 'category', 'status', 'startTime', 'endTime', 'venue', 'description'];

function toValues(event?: EventDetail | null): Values {
  return {
    title: event?.title ?? '',
    category: event?.category ?? '',
    status: event?.status === 'DRAFT' ? 'DRAFT' : 'PUBLISHED',
    startTime: event ? isoToVnInput(event.startTime) : '',
    endTime: event ? isoToVnInput(event.endTime) : '',
    venue: event?.venue ?? '',
    description: event?.description ?? '',
  };
}

export function validateEvent(values: Values, { requireFuture }: { requireFuture: boolean }): Errors {
  const errors: Errors = {};
  const title = values.title.trim();
  if (!title) errors.title = 'Vui lòng nhập tên sự kiện.';
  else if (title.length > 200) errors.title = 'Tên sự kiện tối đa 200 ký tự.';
  if (!values.category) errors.category = 'Vui lòng chọn loại hình.';
  const start = values.startTime ? vnInputToIso(values.startTime) : null;
  const end = values.endTime ? vnInputToIso(values.endTime) : null;
  if (!values.startTime) errors.startTime = 'Vui lòng chọn thời gian bắt đầu.';
  else if (!start) errors.startTime = 'Thời gian không hợp lệ.';
  else if (requireFuture && new Date(start).getTime() <= Date.now())
    errors.startTime = 'Thời gian bắt đầu phải sau thời điểm hiện tại.';
  if (!values.endTime) errors.endTime = 'Vui lòng chọn thời gian kết thúc.';
  else if (!end) errors.endTime = 'Thời gian không hợp lệ.';
  else if (start && new Date(end) <= new Date(start)) errors.endTime = 'Giờ kết thúc phải sau giờ bắt đầu.';
  if (!values.venue.trim()) errors.venue = 'Vui lòng nhập địa điểm.';
  else if (values.venue.trim().length > 255) errors.venue = 'Địa điểm tối đa 255 ký tự.';
  if (values.description.length > 10000) errors.description = 'Mô tả tối đa 10.000 ký tự.';
  return errors;
}

function toInput(values: Values): EventInput {
  return {
    title: values.title.trim(),
    category: values.category,
    status: values.status,
    startTime: vnInputToIso(values.startTime)!,
    endTime: vnInputToIso(values.endTime)!,
    venue: values.venue.trim(),
    description: values.description.trim(),
  };
}

/** Chỉ gửi các trường đã đổi khi sửa (backend dùng PATCH). */
function diff(input: EventInput, before: EventInput): EventPatch {
  const patch: EventPatch = {};
  for (const key of Object.keys(input) as Array<keyof EventInput>) {
    const changed =
      key === 'startTime' || key === 'endTime'
        ? new Date(input[key]).getTime() !== new Date(before[key]).getTime()
        : input[key] !== before[key];
    if (changed) (patch as Record<string, unknown>)[key] = input[key];
  }
  return patch;
}

export function EventForm({
  event,
  submitLabel,
  onCreate,
  onUpdate,
  onCancel,
}: {
  event?: EventDetail | null;
  submitLabel: string;
  onCreate?: (input: EventInput) => Promise<void>;
  onUpdate?: (patch: EventPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const initial = useRef(toValues(event));
  const [values, setValues] = useState<Values>(initial.current);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const locked = event?.status === 'CANCELLED';

  // Loại hình hiện tại không nằm trong danh sách gợi ý vẫn phải chọn được.
  const categoryOptions = [...CATEGORY_OPTIONS];
  if (values.category && !categoryOptions.some((o) => o.value === values.category))
    categoryOptions.push({ value: values.category, label: categoryLabel(values.category) });

  const set = (field: keyof Values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [field]: e.target.value }));
    if (errors[field]) setErrors((prev) => ({ ...prev, [field]: undefined }));
  };

  const focusFirstError = (found: Errors) => {
    const first = FIELD_ORDER.find((f) => found[f]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Khi sửa mà không đổi giờ bắt đầu thì cho giữ nguyên (kể cả sự kiện đã qua).
    const requireFuture = !event || values.startTime !== initial.current.startTime;
    const found = validateEvent(values, { requireFuture });
    setErrors(found);
    setFormError(null);
    if (Object.values(found).some(Boolean)) {
      setFormError('Vui lòng kiểm tra lại các trường được đánh dấu.');
      focusFirstError(found);
      return;
    }

    setSubmitting(true);
    try {
      const input = toInput(values);
      if (event && onUpdate) {
        const patch = diff(input, toInput(initial.current));
        if (Object.keys(patch).length === 0) {
          setFormError('Bạn chưa thay đổi thông tin nào.');
          setSubmitting(false);
          return;
        }
        await onUpdate(patch);
      } else if (onCreate) {
        await onCreate(input);
      }
    } catch (error) {
      if (error instanceof ApiError && Object.keys(error.fieldErrors).length) {
        const serverErrors: Errors = {};
        for (const field of FIELD_ORDER) if (error.fieldErrors[field]) serverErrors[field] = error.fieldErrors[field];
        setErrors(serverErrors);
        focusFirstError(serverErrors);
      }
      setFormError(errorMessage(error));
      setSubmitting(false);
    }
  };

  const fieldProps = (field: keyof Values) => ({
    id: `event-${field}`,
    name: field,
    value: values[field],
    onChange: set(field),
    disabled: submitting || locked,
    'aria-invalid': Boolean(errors[field]),
    'aria-describedby': errors[field] ? `event-${field}-error` : undefined,
  });

  return (
    <form ref={formRef} className="form form--grid" onSubmit={handleSubmit} noValidate aria-label="Thông tin sự kiện">
      {locked && (
        <div className="form__full">
          <Alert kind="info">Sự kiện đã bị hủy nên không thể sửa thông tin hay mở bán lại.</Alert>
        </div>
      )}
      {formError && (
        <div className="form__full">
          <Alert kind="error">{formError}</Alert>
        </div>
      )}
      <div className="field form__full">
        <label htmlFor="event-title">
          Tên sự kiện <span className="req">*</span>
        </label>
        <input {...fieldProps('title')} maxLength={200} />
        <FieldError id="event-title-error" message={errors.title} />
      </div>
      <div className="field">
        <label htmlFor="event-category">
          Loại hình <span className="req">*</span>
        </label>
        <select {...fieldProps('category')}>
          <option value="">— Chọn loại hình —</option>
          {categoryOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <FieldError id="event-category-error" message={errors.category} />
      </div>
      <div className="field">
        <label htmlFor="event-status">
          Trạng thái <span className="req">*</span>
        </label>
        <select {...fieldProps('status')}>
          <option value="PUBLISHED">Mở bán (khách thấy và đặt được)</option>
          <option value="DRAFT">Nháp (khách chưa thấy)</option>
        </select>
        <FieldError id="event-status-error" message={errors.status} />
      </div>
      <div className="field">
        <label htmlFor="event-startTime">
          Bắt đầu (giờ Việt Nam) <span className="req">*</span>
        </label>
        <input {...fieldProps('startTime')} type="datetime-local" />
        <FieldError id="event-startTime-error" message={errors.startTime} />
      </div>
      <div className="field">
        <label htmlFor="event-endTime">
          Kết thúc (giờ Việt Nam) <span className="req">*</span>
        </label>
        <input {...fieldProps('endTime')} type="datetime-local" />
        <FieldError id="event-endTime-error" message={errors.endTime} />
      </div>
      <div className="field form__full">
        <label htmlFor="event-venue">
          Địa điểm <span className="req">*</span>
        </label>
        <input {...fieldProps('venue')} maxLength={255} />
        <FieldError id="event-venue-error" message={errors.venue} />
      </div>
      <div className="field form__full">
        <label htmlFor="event-description">Mô tả</label>
        <textarea {...fieldProps('description')} rows={4} maxLength={10000} />
        <FieldError id="event-description-error" message={errors.description} />
      </div>
      {!locked && (
        <div className="form__actions form__full">
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? 'Đang lưu…' : submitLabel}
          </button>
          <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
            Quay lại
          </button>
        </div>
      )}
    </form>
  );
}
