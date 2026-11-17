import { useRef, useState, type FormEvent } from 'react';
import { ApiError, errorMessage, type EventCategory, type EventDetail, type EventInput } from '../../api';
import { Alert, FieldError } from '../../components/ui';
import { isoToVnInput, vnInputToIso } from '../../lib/dates';
import { CATEGORY_OPTIONS } from '../../lib/format';

interface Values {
  name: string;
  category: '' | EventCategory;
  description: string;
  startTime: string; // giá trị ô datetime-local, giờ Việt Nam
  venue: string;
}

type Errors = Partial<Record<keyof Values, string>>;

const FIELD_ORDER: Array<keyof Values> = ['name', 'category', 'startTime', 'venue', 'description'];

function toValues(event?: EventDetail | null): Values {
  return {
    name: event?.name ?? '',
    category: event?.category ?? '',
    description: event?.description ?? '',
    startTime: event ? isoToVnInput(event.startTime) : '',
    venue: event?.venue ?? '',
  };
}

export function validateEvent(values: Values, { requireFuture }: { requireFuture: boolean }): Errors {
  const errors: Errors = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Vui lòng nhập tên sự kiện.';
  else if (name.length > 200) errors.name = 'Tên sự kiện tối đa 200 ký tự.';
  if (!values.category) errors.category = 'Vui lòng chọn loại hình.';
  if (!values.startTime) errors.startTime = 'Vui lòng chọn thời gian diễn ra.';
  else {
    const iso = vnInputToIso(values.startTime);
    if (!iso) errors.startTime = 'Thời gian không hợp lệ.';
    else if (requireFuture && new Date(iso).getTime() <= Date.now())
      errors.startTime = 'Thời gian diễn ra phải sau thời điểm hiện tại.';
  }
  if (!values.venue.trim()) errors.venue = 'Vui lòng nhập địa điểm.';
  if (values.description.trim().length > 2000) errors.description = 'Mô tả tối đa 2000 ký tự.';
  return errors;
}

export function EventForm({
  event,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  event?: EventDetail | null;
  submitLabel: string;
  onSubmit: (input: EventInput) => Promise<void>;
  onCancel: () => void;
}) {
  const initial = useRef(toValues(event));
  const [values, setValues] = useState<Values>(initial.current);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

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
    // Khi sửa mà không đổi thời gian thì cho phép giữ nguyên (kể cả sự kiện đã qua).
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
      await onSubmit({
        name: values.name.trim(),
        category: values.category as EventCategory,
        description: values.description.trim(),
        startTime: vnInputToIso(values.startTime)!,
        venue: values.venue.trim(),
      });
    } catch (error) {
      if (error instanceof ApiError && error.details) {
        const serverErrors: Errors = {};
        for (const field of FIELD_ORDER) if (error.details[field]) serverErrors[field] = error.details[field];
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
    disabled: submitting,
    'aria-invalid': Boolean(errors[field]),
    'aria-describedby': errors[field] ? `event-${field}-error` : undefined,
  });

  return (
    <form ref={formRef} className="form form--grid" onSubmit={handleSubmit} noValidate aria-label="Thông tin sự kiện">
      {formError && (
        <div className="form__full">
          <Alert kind="error">{formError}</Alert>
        </div>
      )}
      <div className="field form__full">
        <label htmlFor="event-name">
          Tên sự kiện <span className="req">*</span>
        </label>
        <input {...fieldProps('name')} maxLength={200} />
        <FieldError id="event-name-error" message={errors.name} />
      </div>
      <div className="field">
        <label htmlFor="event-category">
          Loại hình <span className="req">*</span>
        </label>
        <select {...fieldProps('category')}>
          <option value="">— Chọn loại hình —</option>
          {CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <FieldError id="event-category-error" message={errors.category} />
      </div>
      <div className="field">
        <label htmlFor="event-startTime">
          Thời gian diễn ra (giờ Việt Nam) <span className="req">*</span>
        </label>
        <input {...fieldProps('startTime')} type="datetime-local" />
        <FieldError id="event-startTime-error" message={errors.startTime} />
      </div>
      <div className="field form__full">
        <label htmlFor="event-venue">
          Địa điểm <span className="req">*</span>
        </label>
        <input {...fieldProps('venue')} maxLength={300} />
        <FieldError id="event-venue-error" message={errors.venue} />
      </div>
      <div className="field form__full">
        <label htmlFor="event-description">Mô tả</label>
        <textarea {...fieldProps('description')} rows={4} maxLength={2000} />
        <FieldError id="event-description-error" message={errors.description} />
      </div>
      <div className="form__actions form__full">
        <button type="submit" className="btn btn--primary" disabled={submitting}>
          {submitting ? 'Đang lưu…' : submitLabel}
        </button>
        <button type="button" className="btn btn--secondary" onClick={onCancel} disabled={submitting}>
          Hủy
        </button>
      </div>
    </form>
  );
}
