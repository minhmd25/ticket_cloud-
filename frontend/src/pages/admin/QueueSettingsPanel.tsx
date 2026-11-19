import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage, type EventDetail, type QueueSettings, type QueueStatus } from '../../api';
import { Alert, FieldError, Icon } from '../../components/ui';
import { isoToVnInput, vnInputToIso } from '../../lib/dates';
import { formatDateTime, formatNumber } from '../../lib/format';

interface Values {
  enabled: boolean;
  saleStartAt: string; // giá trị ô datetime-local, giờ Việt Nam
  maxActive: string;
  accessMinutes: string;
}

type Errors = Partial<Record<keyof Values, string>>;

const COUNT_LABELS: Array<{ key: QueueStatus; label: string }> = [
  { key: 'WAITING', label: 'Đang chờ' },
  { key: 'ADMITTED', label: 'Đang mua' },
  { key: 'COMPLETED', label: 'Đã mua xong' },
  { key: 'EXPIRED', label: 'Hết lượt' },
  { key: 'LEFT', label: 'Rời hàng' },
];

export function validateQueue(v: Values): Errors {
  const errors: Errors = {};
  if (!vnInputToIso(v.saleStartAt)) errors.saleStartAt = 'Vui lòng chọn giờ mở bán.';
  if (!/^\d+$/.test(v.maxActive.trim()) || Number(v.maxActive) < 1 || Number(v.maxActive) > 10000)
    errors.maxActive = 'Từ 1 đến 10.000 người.';
  if (!/^\d+$/.test(v.accessMinutes.trim()) || Number(v.accessMinutes) < 1 || Number(v.accessMinutes) > 120)
    errors.accessMinutes = 'Từ 1 đến 120 phút.';
  return errors;
}

function defaults(event: EventDetail): Values {
  // Mặc định mở bán sau 1 giờ (làm tròn giờ), nhưng không sau giờ diễn.
  const start = new Date(Date.now() + 3_600_000);
  start.setMinutes(0, 0, 0);
  const iso = new Date(Math.min(start.getTime(), new Date(event.startTime).getTime() - 3_600_000)).toISOString();
  return { enabled: true, saleStartAt: isoToVnInput(iso), maxActive: '100', accessMinutes: '10' };
}

const fromSettings = (s: QueueSettings): Values => ({
  enabled: s.enabled,
  saleStartAt: isoToVnInput(s.saleStartAt),
  maxActive: String(s.maxActive),
  accessMinutes: String(s.accessMinutes),
});

/** Cấu hình hàng chờ ảo của một sự kiện (API.md mục 6). */
export function QueueSettingsPanel({ event, readOnly, onChanged }: { event: EventDetail; readOnly?: boolean; onChanged: () => void }) {
  const [settings, setSettings] = useState<QueueSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [values, setValues] = useState<Values>(() => defaults(event));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'info'; text: string } | null>(null);

  const load = async () => {
    setLoadError(null);
    try {
      const s = await api.admin.getQueue(event.id);
      setSettings(s);
      setValues(fromSettings(s));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUEUE_NOT_CONFIGURED') setSettings(null);
      else setLoadError(err);
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  const started = settings !== null && new Date(settings.saleStartAt).getTime() <= Date.now();
  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateQueue(values);
    setErrors(found);
    if (Object.values(found).some(Boolean)) return;
    // Giờ mở bán không đổi thì gửi lại nguyên giá trị cũ (đã mở bán thì backend không cho đổi).
    const unchanged = settings && isoToVnInput(settings.saleStartAt) === values.saleStartAt;
    const saleStartAt = unchanged ? settings.saleStartAt : vnInputToIso(values.saleStartAt)!;
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.admin.saveQueue(event.id, {
        enabled: values.enabled,
        saleStartAt,
        maxActive: Number(values.maxActive),
        accessMinutes: Number(values.accessMinutes),
      });
      setSettings(saved);
      setValues(fromSettings(saved));
      setMessage({ kind: 'success', text: saved.enabled ? 'Đã lưu cấu hình hàng chờ.' : 'Đã tắt hàng chờ: khách đặt vé trực tiếp.' });
      onChanged();
    } catch (err) {
      if (err instanceof ApiError) {
        const { enabled, saleStartAt: sale, maxActive, accessMinutes } = err.fieldErrors;
        setErrors({ enabled, saleStartAt: sale, maxActive, accessMinutes });
        if (err.code === 'QUEUE_ALREADY_STARTED') setErrors({ saleStartAt: 'Đã mở bán, không đổi được giờ mở bán.' });
      }
      setMessage({ kind: 'error', text: `Không lưu được cấu hình. ${errorMessage(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const tick = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.admin.tickQueue(event.id);
      setSettings(res.settings);
      const { admitted, expired, dropped } = res.tick;
      setMessage({
        kind: 'info',
        text: `Đã chạy một nhịp: cho vào ${formatNumber(admitted)} người, hết giờ ${formatNumber(expired)}, bỏ trang chờ ${formatNumber(dropped)}.`,
      });
    } catch (err) {
      setMessage({ kind: 'error', text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  if (!loaded) return <p className="muted">Đang tải cấu hình hàng chờ…</p>;
  if (loadError)
    return (
      <Alert kind="error">
        Không tải được cấu hình hàng chờ. {errorMessage(loadError)}{' '}
        <button type="button" className="link-btn" onClick={() => void load()}>
          Thử lại
        </button>
      </Alert>
    );

  return (
    <div className="queue-admin">
      {message && (
        <Alert kind={message.kind} onClose={() => setMessage(null)}>
          {message.text}
        </Alert>
      )}

      {settings && (
        <div className="queue-admin__stats" aria-label="Số người theo trạng thái">
          {COUNT_LABELS.map((c) => (
            <div key={c.key} className={`mini-stat mini-stat--${c.key.toLowerCase()}`}>
              <span className="mini-stat__value">{formatNumber(settings.counts[c.key] ?? 0)}</span>
              <span className="mini-stat__label">{c.label}</span>
            </div>
          ))}
        </div>
      )}
      {settings && (
        <p className="muted small">
          {settings.randomizedAt
            ? `Đã xếp ngẫu nhiên những người vào trước giờ mở bán lúc ${formatDateTime(settings.randomizedAt)}.`
            : started
              ? 'Đã tới giờ mở bán, nhịp kế tiếp sẽ xếp ngẫu nhiên những người đang chờ.'
              : 'Chưa tới giờ mở bán: người vào hàng sẽ được xếp ngẫu nhiên lúc mở bán.'}
        </p>
      )}

      <form className="form queue-admin__form" onSubmit={save} noValidate aria-label="Cấu hình hàng chờ">
        <label className="checkbox">
          <input type="checkbox" checked={values.enabled} onChange={(e) => set('enabled', e.target.checked)} disabled={busy || readOnly} />
          Bật hàng chờ ảo cho sự kiện này
        </label>
        <div className="form-grid form-grid--3">
          <div className="field">
            <label htmlFor="queue-sale">Giờ mở bán (giờ Việt Nam)</label>
            <input
              id="queue-sale"
              type="datetime-local"
              value={values.saleStartAt}
              onChange={(e) => set('saleStartAt', e.target.value)}
              disabled={busy || readOnly || started}
              aria-invalid={Boolean(errors.saleStartAt)}
              aria-describedby={errors.saleStartAt ? 'queue-sale-error' : started ? 'queue-sale-note' : undefined}
            />
            {started && !errors.saleStartAt && (
              <p className="field__hint" id="queue-sale-note">
                Đã mở bán nên không đổi được giờ mở bán.
              </p>
            )}
            <FieldError id="queue-sale-error" message={errors.saleStartAt} />
          </div>
          <div className="field">
            <label htmlFor="queue-max">Số người mua cùng lúc</label>
            <input
              id="queue-max"
              inputMode="numeric"
              value={values.maxActive}
              onChange={(e) => set('maxActive', e.target.value)}
              disabled={busy || readOnly}
              aria-invalid={Boolean(errors.maxActive)}
              aria-describedby={errors.maxActive ? 'queue-max-error' : undefined}
            />
            <FieldError id="queue-max-error" message={errors.maxActive} />
          </div>
          <div className="field">
            <label htmlFor="queue-minutes">Số phút mỗi lượt mua</label>
            <input
              id="queue-minutes"
              inputMode="numeric"
              value={values.accessMinutes}
              onChange={(e) => set('accessMinutes', e.target.value)}
              disabled={busy || readOnly}
              aria-invalid={Boolean(errors.accessMinutes)}
              aria-describedby={errors.accessMinutes ? 'queue-minutes-error' : undefined}
            />
            <FieldError id="queue-minutes-error" message={errors.accessMinutes} />
          </div>
        </div>
        {!readOnly && (
          <div className="form__actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? 'Đang lưu…' : 'Lưu cấu hình hàng chờ'}
            </button>
            {settings && (
              <>
                <button type="button" className="btn btn--secondary" onClick={tick} disabled={busy}>
                  <Icon name="play" /> Chạy một nhịp
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => void load()} disabled={busy}>
                  <Icon name="refresh" /> Tải lại số người
                </button>
              </>
            )}
          </div>
        )}
      </form>
    </div>
  );
}
