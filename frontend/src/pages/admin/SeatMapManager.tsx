import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { api, ApiError, errorMessage, type EventDetail, type Seat, type SeatMap } from '../../api';
import { SeatMapView, tierColor, tierSlots, useSeatMapData, type SeatState } from '../../components/SeatMap';
import { Alert, Icon } from '../../components/ui';
import { buildGridLayout, buildTheaterLayout, MAX_ROWS, type SeatLayout } from '../../lib/seatLayouts';
import { formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

type Tool = 'generate' | 'json' | 'copy';
type Template = 'theater' | 'grid';
type Message = { kind: 'success' | 'error' | 'info'; text: string; items?: string[] } | null;

/** Đổi lỗi lưu sơ đồ thành câu thông báo kèm danh sách chi tiết (ghế chồng nhau, ghế đã bán...). */
function saveErrorMessage(error: unknown): Message {
  if (!(error instanceof ApiError)) return { kind: 'error', text: errorMessage(error) };
  const d = error.details as Record<string, unknown> | unknown[] | null;
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return {
        kind: 'error',
        text: 'Sơ đồ chưa hợp lệ:',
        items: Array.isArray(d) ? d.map((x) => String((x as { message?: unknown })?.message ?? x)) : [error.message],
      };
    case 'SEAT_MAP_VERSION_CONFLICT':
      return { kind: 'error', text: 'Sơ đồ vừa bị người khác sửa. Đã tải lại bản mới nhất, hãy kiểm tra rồi làm lại.' };
    case 'SEAT_SOLD_LOCKED': {
      const seats = Array.isArray((d as Record<string, unknown>)?.seats) ? ((d as Record<string, unknown>).seats as unknown[]) : [];
      return {
        kind: 'error',
        text: `${error.message}. Dời vị trí ghế đã bán thì được, nhưng không xóa, đổi hạng hay khóa được:`,
        items: seats.map((s) => {
          const x = s as { label?: string; reason?: string };
          return x.reason ? `${x.label}: ${x.reason}` : String(x.label ?? s);
        }),
      };
    }
    case 'INVALID_SEAT_TICKET_TYPE':
      return { kind: 'error', text: `${error.message}. Ghế chỉ được gán cho hạng vé "Chọn ghế trên sơ đồ" của sự kiện này.` };
    case 'TICKET_TYPE_MAPPING_FAILED': {
      const missing = Array.isArray((d as Record<string, unknown>)?.missing) ? ((d as Record<string, unknown>).missing as string[]) : [];
      return {
        kind: 'error',
        text: 'Hạng vé được ghép theo tên. Hãy thêm các hạng vé "Chọn ghế trên sơ đồ" còn thiếu rồi chép lại:',
        items: missing,
      };
    }
    default:
      return { kind: 'error', text: error.message };
  }
}

/** Đọc file/ô JSON theo mẫu body của PUT seat-map (bỏ qua `version`, `id` nếu có). */
export function parseSeatLayout(text: string): SeatLayout {
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.seats)) throw new Error('JSON phải có danh sách "seats".');
  const seats = (raw.seats as Array<Record<string, unknown>>).map((s) => {
    const { id: _id, ...rest } = s;
    return rest as unknown as SeatLayout['seats'][number];
  });
  return {
    width: Number(raw.width),
    height: Number(raw.height),
    seatSize: raw.seatSize === undefined ? 24 : Number(raw.seatSize),
    sections: Array.isArray(raw.sections) ? (raw.sections as SeatLayout['sections']) : [],
    seats,
    decorations: Array.isArray(raw.decorations) ? (raw.decorations as SeatLayout['decorations']) : [],
  };
}

const layoutToMap = (eventId: string, layout: SeatLayout): SeatMap => ({
  eventId,
  version: 0,
  width: layout.width,
  height: layout.height,
  seatSize: layout.seatSize ?? 24,
  sections: layout.sections,
  decorations: layout.decorations,
  seats: layout.seats.map((s, i) => ({ ...s, id: `draft-${i}`, row: s.row ?? null, section: s.section ?? null })),
  updatedAt: '',
});

const mapToLayout = (m: SeatMap): SeatLayout => ({
  width: m.width,
  height: m.height,
  seatSize: m.seatSize,
  sections: m.sections,
  decorations: m.decorations,
  seats: m.seats.map(({ id: _id, ...rest }) => rest),
});

/** Sơ đồ ghế của sự kiện: tạo nhanh, nhập JSON, chép từ sự kiện khác, khóa/mở ghế (API.md mục 5). */
export function SeatMapManager({ event, readOnly, onChanged }: { event: EventDetail; readOnly?: boolean; onChanged: () => void }) {
  const assigned = event.ticketTypes.filter((t) => t.seating === 'ASSIGNED');
  const seatData = useSeatMapData(event.id, { admin: true });
  const noMap = seatData.error instanceof ApiError && seatData.error.code === 'SEAT_MAP_NOT_FOUND';
  const map = noMap ? null : seatData.map;
  const status = seatData.status;

  const [tool, setTool] = useState<Tool>('generate');
  const [draft, setDraft] = useState<SeatLayout | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  const sold = useMemo(() => new Set(status?.sold ?? []), [status]);
  const slots = useMemo(() => tierSlots(event.ticketTypes), [event.ticketTypes]);

  const afterSave = (text: string) => {
    setDraft(null);
    setPicked([]);
    setMessage({ kind: 'success', text });
    seatData.reload();
    onChanged();
  };

  const save = async (layout: SeatLayout) => {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.admin.saveSeatMap(event.id, { version: map?.version ?? 0, ...layout, seatSize: layout.seatSize ?? 24 });
      afterSave(`Đã lưu sơ đồ ${formatNumber(saved.seats.length)} ghế (phiên bản ${saved.version}). Số vé của các hạng chọn ghế đã được tính lại.`);
    } catch (err) {
      setMessage(saveErrorMessage(err));
      if (err instanceof ApiError && err.code === 'SEAT_MAP_VERSION_CONFLICT') seatData.reload();
    } finally {
      setBusy(false);
    }
  };

  const setBlocked = async (blocked: boolean) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await api.admin.setSeatsBlocked(event.id, picked, blocked);
      setPicked([]);
      setMessage({
        kind: 'success',
        text:
          res.changed === 0
            ? 'Các ghế đã ở trạng thái này, không có gì thay đổi.'
            : `Đã ${blocked ? 'khóa' : 'mở khóa'} ${formatNumber(res.changed)} ghế.`,
      });
      seatData.reload();
      onChanged();
    } catch (err) {
      setMessage(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    if (!map) return;
    const blob = new Blob([JSON.stringify(mapToLayout(map), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `so-do-ghe-${event.id.slice(0, 8)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (assigned.length === 0) {
    return (
      <Alert kind="info">
        Sự kiện chưa có hạng vé bán theo ghế. Hãy thêm hạng vé với cách bán <strong>Chọn ghế trên sơ đồ</strong> ở mục Hạng vé, rồi
        tạo sơ đồ tại đây.
      </Alert>
    );
  }
  if (seatData.loading && !seatData.map && !seatData.error) return <p className="muted">Đang tải sơ đồ ghế…</p>;
  if (seatData.error && !noMap)
    return (
      <Alert kind="error">
        Không tải được sơ đồ ghế. {errorMessage(seatData.error)}{' '}
        <button type="button" className="link-btn" onClick={seatData.reload}>
          Thử lại
        </button>
      </Alert>
    );

  const shown = draft ? layoutToMap(event.id, draft) : map;
  const pickedSeats = picked.map((id) => map?.seats.find((s) => s.id === id)).filter((s): s is Seat => Boolean(s));
  const stateOf = (s: Seat): SeatState => {
    if (draft) return s.blocked ? 'blocked' : 'available';
    if (picked.includes(s.id)) return 'selected';
    if (sold.has(s.id)) return 'sold';
    return s.blocked ? 'blocked' : 'available';
  };

  return (
    <div className="seat-admin">
      {message && (
        <Alert kind={message.kind} onClose={() => setMessage(null)}>
          <p>{message.text}</p>
          {message.items && message.items.length > 0 && (
            <ul className="issue-list">
              {message.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}

      {map && !draft && <SeatSummary map={map} sold={sold} event={event} slots={slots} />}

      {shown ? (
        <>
          {draft && (
            <div className="draft-bar" role="status">
              <Icon name="info" />
              <span>
                <strong>Bản xem trước</strong> · {formatNumber(draft.seats.length)} ghế, chưa lưu.
              </span>
              <div className="draft-bar__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={() => void save(draft)} disabled={busy || readOnly}>
                  {busy ? 'Đang lưu…' : 'Lưu sơ đồ'}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDraft(null)} disabled={busy}>
                  Bỏ bản xem trước
                </button>
              </div>
            </div>
          )}
          <SeatMapView
            map={shown}
            ticketTypes={event.ticketTypes}
            stateOf={stateOf}
            canSelect={(s) => !draft && !readOnly && !sold.has(s.id)}
            onSeatClick={(s) => setPicked((ids) => (ids.includes(s.id) ? ids.filter((x) => x !== s.id) : [...ids, s.id]))}
            label={draft ? 'Bản xem trước sơ đồ ghế' : `Sơ đồ ghế của sự kiện. Bấm vào ghế để chọn rồi khóa hoặc mở khóa.`}
            tierNote={(t) => `${formatNumber(shown.seats.filter((s) => s.ticketTypeId === t.id).length)} ghế`}
          />
          {!draft && map && !readOnly && (
            <div className="pick-bar" aria-live="polite">
              <span>
                {pickedSeats.length === 0
                  ? 'Bấm vào ghế trên sơ đồ để chọn ghế cần khóa (không bán) hoặc mở khóa.'
                  : `Đang chọn ${formatNumber(pickedSeats.length)} ghế: ${pickedSeats
                      .slice(0, 12)
                      .map((s) => s.label)
                      .join(', ')}${pickedSeats.length > 12 ? '…' : ''}`}
              </span>
              <div className="pick-bar__actions">
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void setBlocked(true)} disabled={busy || picked.length === 0}>
                  <Icon name="lock" /> Khóa ghế
                </button>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void setBlocked(false)} disabled={busy || picked.length === 0}>
                  <Icon name="unlock" /> Mở khóa
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPicked([])} disabled={busy || picked.length === 0}>
                  Bỏ chọn
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="empty-map">
          <Icon name="seat" />
          <p>
            <strong>Sự kiện chưa có sơ đồ ghế.</strong> Tạo nhanh từ mẫu, nhập file JSON hoặc chép từ sự kiện khác ở bên dưới.
          </p>
        </div>
      )}

      {!readOnly && (
        <section className="seat-tools" aria-label="Công cụ tạo sơ đồ">
          <div className="seat-tools__head">
            <div className="segmented" role="group" aria-label="Cách tạo sơ đồ">
              {(
                [
                  ['generate', 'Tạo nhanh từ mẫu'],
                  ['json', 'Nhập file JSON'],
                  ['copy', 'Chép từ sự kiện khác'],
                ] as Array<[Tool, string]>
              ).map(([value, label]) => (
                <button key={value} type="button" className="segmented__item" aria-pressed={tool === value} onClick={() => setTool(value)}>
                  {label}
                </button>
              ))}
            </div>
            {map && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={exportJson}>
                <Icon name="download" /> Tải sơ đồ hiện tại (JSON)
              </button>
            )}
          </div>
          {map && (
            <p className="muted small">
              Lưu sơ đồ mới sẽ thay thế toàn bộ sơ đồ hiện tại. Ghế cùng nhãn giữ nguyên mã ghế; ghế đã bán không xóa hay đổi hạng được.
            </p>
          )}
          {tool === 'generate' && (
            <GenerateTool event={event} busy={busy} onPreview={(l) => {
              setDraft(l);
              setMessage(null);
            }} />
          )}
          {tool === 'json' && (
            <JsonTool busy={busy} onPreview={(l) => {
              setDraft(l);
              setMessage(null);
            }} onError={(text) => setMessage({ kind: 'error', text })} />
          )}
          {tool === 'copy' && (
            <CopyTool
              event={event}
              busy={busy}
              onCopy={async (sourceId) => {
                setBusy(true);
                setMessage(null);
                try {
                  const saved = await api.admin.copySeatMap(event.id, sourceId, map?.version ?? 0);
                  afterSave(`Đã chép sơ đồ ${formatNumber(saved.seats.length)} ghế. Hạng vé được ghép theo tên.`);
                } catch (err) {
                  setMessage(saveErrorMessage(err));
                  if (err instanceof ApiError && err.code === 'SEAT_MAP_VERSION_CONFLICT') seatData.reload();
                } finally {
                  setBusy(false);
                }
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}

function SeatSummary({
  map,
  sold,
  event,
  slots,
}: {
  map: SeatMap;
  sold: Set<string>;
  event: EventDetail;
  slots: Map<string, number>;
}) {
  const blocked = map.seats.filter((s) => s.blocked).length;
  const soldCount = map.seats.filter((s) => sold.has(s.id)).length;
  return (
    <div className="seat-summary">
      <div className="mini-stat">
        <span className="mini-stat__value">{formatNumber(map.seats.length)}</span>
        <span className="mini-stat__label">Tổng ghế</span>
      </div>
      <div className="mini-stat">
        <span className="mini-stat__value">{formatNumber(soldCount)}</span>
        <span className="mini-stat__label">Đã bán</span>
      </div>
      <div className="mini-stat">
        <span className="mini-stat__value">{formatNumber(blocked)}</span>
        <span className="mini-stat__label">Đang khóa</span>
      </div>
      {event.ticketTypes
        .filter((t) => slots.has(t.id))
        .map((t) => (
          <div key={t.id} className="mini-stat">
            <span className="mini-stat__value">
              <span className="tier-dot" style={{ background: tierColor(slots.get(t.id)) }} aria-hidden="true" />
              {formatNumber(map.seats.filter((s) => s.ticketTypeId === t.id).length)}
            </span>
            <span className="mini-stat__label">{t.name}</span>
          </div>
        ))}
      <span className="muted small seat-summary__version">Phiên bản {map.version}</span>
    </div>
  );
}

function GenerateTool({ event, busy, onPreview }: { event: EventDetail; busy: boolean; onPreview: (l: SeatLayout) => void }) {
  const assigned = event.ticketTypes
    .filter((t) => t.seating === 'ASSIGNED')
    .slice()
    .sort((a, b) => b.price - a.price);
  const [template, setTemplate] = useState<Template>('theater');
  const [perRow, setPerRow] = useState('16');
  const [rows, setRows] = useState<Record<string, string>>(() => Object.fromEntries(assigned.map((t) => [t.id, '4'])));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRows((cur) => Object.fromEntries(assigned.map((t) => [t.id, cur[t.id] ?? '4'])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigned.map((t) => t.id).join(',')]);

  const preview = () => {
    const tiers = assigned.map((t) => ({ ticketTypeId: t.id, rows: Number(rows[t.id]) }));
    if (tiers.some((t) => !Number.isInteger(t.rows) || t.rows < 0)) return setError('Số hàng phải là số nguyên không âm.');
    const total = tiers.reduce((s, t) => s + t.rows, 0);
    if (total < 1) return setError('Cần ít nhất một hàng ghế.');
    if (total > MAX_ROWS) return setError(`Tối đa ${MAX_ROWS} hàng (A–Z).`);
    const n = Number(perRow);
    if (template === 'grid' && (!Number.isInteger(n) || n < 1 || n > 60)) return setError('Số ghế mỗi hàng từ 1 đến 60.');
    setError(null);
    const active = tiers.filter((t) => t.rows > 0);
    onPreview(template === 'theater' ? buildTheaterLayout(active) : buildGridLayout(active, n));
  };

  return (
    <div className="tool">
      <div className="form-grid form-grid--3">
        <div className="field">
          <label htmlFor="gen-template">Mẫu sơ đồ</label>
          <select id="gen-template" value={template} onChange={(e) => setTemplate(e.target.value as Template)} disabled={busy}>
            <option value="theater">Nhà hát hàng ghế cong (3 khu)</option>
            <option value="grid">Các hàng ghế thẳng</option>
          </select>
        </div>
        {template === 'grid' && (
          <div className="field">
            <label htmlFor="gen-per-row">Số ghế mỗi hàng</label>
            <input id="gen-per-row" inputMode="numeric" value={perRow} onChange={(e) => setPerRow(e.target.value)} disabled={busy} />
          </div>
        )}
      </div>
      <fieldset className="field">
        <legend>Số hàng của mỗi hạng vé (tính từ sân khấu ra)</legend>
        <div className="form-grid form-grid--4">
          {assigned.map((t) => (
            <div key={t.id} className="field">
              <label htmlFor={`gen-rows-${t.id}`}>{t.name}</label>
              <input
                id={`gen-rows-${t.id}`}
                inputMode="numeric"
                value={rows[t.id] ?? ''}
                onChange={(e) => setRows((r) => ({ ...r, [t.id]: e.target.value }))}
                disabled={busy}
              />
            </div>
          ))}
        </div>
      </fieldset>
      {error && <p className="field__error">{error}</p>}
      <div className="form__actions">
        <button type="button" className="btn btn--secondary" onClick={preview} disabled={busy}>
          <Icon name="seat" /> Xem trước sơ đồ
        </button>
      </div>
    </div>
  );
}

function JsonTool({ busy, onPreview, onError }: { busy: boolean; onPreview: (l: SeatLayout) => void; onError: (text: string) => void }) {
  const [text, setText] = useState('');

  const readFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) setText(await file.text());
  };

  const preview = () => {
    try {
      onPreview(parseSeatLayout(text));
    } catch (err) {
      onError(`File JSON không đọc được: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="tool">
      <p className="muted small">
        Đúng mẫu body của <code>PUT /api/admin/events/:id/seat-map</code> (xem API.md mục 5), không cần <code>version</code>.{' '}
        <code>ticketTypeId</code> phải là mã hạng vé chọn ghế của sự kiện này.
      </p>
      <div className="field">
        <label htmlFor="json-file">Chọn file JSON</label>
        <input id="json-file" type="file" accept="application/json,.json" onChange={(e) => void readFile(e)} disabled={busy} />
      </div>
      <div className="field">
        <label htmlFor="json-text">Hoặc dán nội dung JSON</label>
        <textarea id="json-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} spellCheck={false} className="code-area" />
      </div>
      <div className="form__actions">
        <button type="button" className="btn btn--secondary" onClick={preview} disabled={busy || !text.trim()}>
          <Icon name="upload" /> Xem trước sơ đồ
        </button>
      </div>
    </div>
  );
}

function CopyTool({ event, busy, onCopy }: { event: EventDetail; busy: boolean; onCopy: (sourceId: string) => Promise<void> }) {
  const events = useAsync(() => api.admin.listEvents({ includePast: true, limit: 100 }), []);
  const options = (events.data?.data ?? []).filter((e) => e.id !== event.id);
  const [source, setSource] = useState('');
  return (
    <div className="tool">
      <p className="muted small">
        Dùng khi nhiều suất diễn cùng một nhà hát. Hạng vé được ghép <strong>theo tên</strong>: sự kiện này phải có hạng vé chọn ghế
        trùng tên với hạng vé của sự kiện nguồn.
      </p>
      <div className="form-grid form-grid--2">
        <div className="field">
          <label htmlFor="copy-source">Sự kiện nguồn</label>
          <select id="copy-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={busy || events.loading}>
            <option value="">{events.loading ? 'Đang tải…' : 'Chọn sự kiện'}</option>
            {options.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="form__actions">
        <button type="button" className="btn btn--secondary" onClick={() => void onCopy(source)} disabled={busy || !source}>
          <Icon name="copy" /> Chép sơ đồ
        </button>
      </div>
    </div>
  );
}
