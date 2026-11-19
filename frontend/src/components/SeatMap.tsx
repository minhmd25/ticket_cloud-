import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type Seat, type SeatDecoration, type SeatMap, type SeatStatus, type TicketType } from '../api';
import { formatCurrency } from '../lib/format';

/** Trạng thái hiển thị của một ghế. */
export type SeatState = 'available' | 'sold' | 'blocked' | 'selected';

/**
 * Màu theo hạng vé (màu đi theo hạng, không theo thứ tự hiển thị): hạng đắt nhất nhận màu 1.
 * Các màu --tier-N lấy từ bảng màu phân loại đã kiểm tra mù màu (styles.css).
 */
export function tierSlots(ticketTypes: TicketType[]): Map<string, number> {
  const assigned = ticketTypes
    .filter((t) => t.seating === 'ASSIGNED')
    .slice()
    .sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
  return new Map(assigned.map((t, i) => [t.id, (i % 6) + 1]));
}

export const tierColor = (slot: number | undefined) => (slot ? `var(--tier-${slot})` : 'var(--tier-none)');

const ZOOMS = [1, 1.5, 2, 3];

interface SeatMapViewProps {
  map: SeatMap;
  ticketTypes: TicketType[];
  stateOf: (seat: Seat) => SeatState;
  /** Ghế bấm được (ghế trống, hoặc mọi ghế ở chế độ quản trị). */
  canSelect: (seat: Seat) => boolean;
  onSeatClick?: (seat: Seat) => void;
  /** Mô tả ngắn cho cả sơ đồ, đọc bởi trình đọc màn hình. */
  label: string;
  /** Nội dung thêm ở chú thích, ví dụ số ghế còn trống của từng hạng. */
  tierNote?: (t: TicketType) => ReactNode;
  disabled?: boolean;
}

const STATE_TEXT: Record<SeatState, string> = {
  available: 'còn trống',
  sold: 'đã có người đặt',
  blocked: 'không bán',
  selected: 'đang chọn',
};

/** Vẽ sơ đồ ghế bằng SVG theo tọa độ backend trả về (API.md mục 5). */
export function SeatMapView({ map, ticketTypes, stateOf, canSelect, onSeatClick, label, tierNote, disabled }: SeatMapViewProps) {
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState<Seat | null>(null);
  const slots = useMemo(() => tierSlots(ticketTypes), [ticketTypes]);
  const typeById = useMemo(() => new Map(ticketTypes.map((t) => [t.id, t])), [ticketTypes]);
  const r = map.seatSize / 2;

  // Nhãn hàng đặt bên trái ghế ngoài cùng bên trái của mỗi hàng.
  const rowLabels = useMemo(() => {
    const first = new Map<string, Seat>();
    for (const s of map.seats) {
      if (!s.row) continue;
      const cur = first.get(s.row);
      if (!cur || s.x < cur.x) first.set(s.row, s);
    }
    return [...first.entries()].map(([row, s]) => ({ row, x: s.x - map.seatSize * 1.05, y: s.y }));
  }, [map]);

  const describe = (s: Seat) => {
    const t = typeById.get(s.ticketTypeId);
    const parts = [`Ghế ${s.label}`];
    if (t) parts.push(t.name, formatCurrency(t.price));
    if (s.accessible) parts.push('dành cho người khuyết tật');
    parts.push(STATE_TEXT[stateOf(s)]);
    return parts.join(' · ');
  };

  const onKey = (e: KeyboardEvent, s: Seat) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSeatClick?.(s);
    }
  };

  const usedTiers = ticketTypes
    .filter((t) => slots.has(t.id) && map.seats.some((s) => s.ticketTypeId === t.id))
    .sort((a, b) => (slots.get(a.id) ?? 0) - (slots.get(b.id) ?? 0));

  return (
    <div className={`seatmap ${disabled ? 'is-disabled' : ''}`}>
      <div className="seatmap__toolbar">
        <p className="seatmap__hover" aria-live="polite">
          {hover ? describe(hover) : 'Di chuột hoặc dùng phím Tab để xem từng ghế.'}
        </p>
        <div className="seatmap__zoom" role="group" aria-label="Phóng to sơ đồ">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])}
            disabled={zoom === ZOOMS[0]}
            aria-label="Thu nhỏ sơ đồ"
          >
            −
          </button>
          <span className="seatmap__zoom-level">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])}
            disabled={zoom === ZOOMS[ZOOMS.length - 1]}
            aria-label="Phóng to sơ đồ"
          >
            +
          </button>
        </div>
      </div>

      <div className={`seatmap__viewport ${zoom > 1 ? 'is-zoomed' : ''}`}>
        <svg
          className="seatmap__svg"
          viewBox={`0 0 ${map.width} ${map.height}`}
          style={{ width: `${zoom * 100}%` }}
          role="group"
          aria-label={label}
          onMouseLeave={() => setHover(null)}
        >
          {map.decorations.map((d, i) => (
            <Decoration key={i} d={d} />
          ))}
          {rowLabels.map((l) => (
            <text key={l.row} className="seatmap__row" x={l.x} y={l.y} dominantBaseline="central" textAnchor="middle">
              {l.row}
            </text>
          ))}
          {map.seats.map((s) => {
            const state = stateOf(s);
            const selectable = !disabled && canSelect(s);
            const fill = state === 'selected' ? 'var(--seat-selected)' : state === 'available' ? tierColor(slots.get(s.ticketTypeId)) : undefined;
            return (
              <g
                key={s.id}
                className={`seat seat--${state} ${selectable ? 'is-selectable' : ''}`}
                transform={`translate(${s.x} ${s.y}) rotate(${s.rotation})`}
                role={selectable ? 'button' : 'img'}
                tabIndex={selectable ? 0 : undefined}
                aria-label={describe(s)}
                aria-pressed={selectable ? state === 'selected' : undefined}
                onClick={selectable ? () => onSeatClick?.(s) : undefined}
                onKeyDown={selectable ? (e) => onKey(e, s) : undefined}
                onMouseEnter={() => setHover(s)}
                onFocus={() => setHover(s)}
              >
                <rect className="seat__back" x={-r * 0.72} y={r * 0.55} width={r * 1.44} height={r * 0.42} rx={r * 0.2} />
                <circle className="seat__body" r={r * 0.86} style={fill ? { fill } : undefined} />
                {state === 'selected' && <path className="seat__mark" d={`M${-r * 0.4} 0 L${-r * 0.1} ${r * 0.32} L${r * 0.45} ${-r * 0.32}`} />}
                {state === 'sold' && (
                  <path className="seat__mark seat__mark--muted" d={`M${-r * 0.32} ${-r * 0.32} L${r * 0.32} ${r * 0.32} M${r * 0.32} ${-r * 0.32} L${-r * 0.32} ${r * 0.32}`} />
                )}
                {state === 'blocked' && <path className="seat__mark seat__mark--muted" d={`M${-r * 0.45} 0 L${r * 0.45} 0`} />}
                {s.accessible && state === 'available' && <circle className="seat__access" r={r * 0.36} />}
              </g>
            );
          })}
        </svg>
      </div>

      <ul className="seatmap__legend" aria-label="Chú thích sơ đồ ghế">
        {usedTiers.map((t) => (
          <li key={t.id}>
            <span className="seatmap__swatch" style={{ background: tierColor(slots.get(t.id)) }} aria-hidden="true" />
            <span>
              <strong>{t.name}</strong> · {formatCurrency(t.price)}
              {tierNote && <span className="muted"> · {tierNote(t)}</span>}
            </span>
          </li>
        ))}
        <li>
          <span className="seatmap__swatch seatmap__swatch--selected" aria-hidden="true" />
          Đang chọn
        </li>
        <li>
          <span className="seatmap__swatch seatmap__swatch--sold" aria-hidden="true" />
          Đã có người đặt
        </li>
        <li>
          <span className="seatmap__swatch seatmap__swatch--blocked" aria-hidden="true" />
          Không bán
        </li>
        <li>
          <span className="seatmap__swatch seatmap__swatch--access" aria-hidden="true" />
          Ghế cho người khuyết tật
        </li>
      </ul>
    </div>
  );
}

function Decoration({ d }: { d: SeatDecoration }) {
  const x = Number(d.x ?? 0);
  const y = Number(d.y ?? 0);
  if (d.type === 'stage' || d.type === 'rect') {
    const w = Number(d.width ?? 0);
    const h = Number(d.height ?? 0);
    const label = typeof d.label === 'string' ? d.label : typeof d.text === 'string' ? d.text : '';
    return (
      <g className={`seatmap__deco seatmap__deco--${d.type}`}>
        <rect x={x} y={y} width={w} height={h} rx={Math.min(16, h / 3)} />
        {label && (
          <text x={x + w / 2} y={y + h / 2} dominantBaseline="central" textAnchor="middle">
            {label}
          </text>
        )}
      </g>
    );
  }
  if (d.type === 'label' || d.type === 'text') {
    const value = typeof d.text === 'string' ? d.text : typeof d.label === 'string' ? d.label : '';
    return (
      <text className="seatmap__label" x={x} y={y} dominantBaseline="central" textAnchor="middle">
        {value}
      </text>
    );
  }
  return null; // loại trang trí frontend chưa biết vẽ: bỏ qua
}

interface SeatMapData {
  map: SeatMap | null;
  status: SeatStatus | null;
  error: unknown;
  loading: boolean;
  /** Tải lại trạng thái ghế ngay (ví dụ sau khi nhận SEAT_TAKEN). */
  refreshStatus: () => Promise<void>;
  reload: () => void;
}

/**
 * Tải sơ đồ và trạng thái ghế. Khi `pollMs` > 0 thì hỏi lại trạng thái định kỳ; nếu `version`
 * của trạng thái khác sơ đồ đang hiển thị thì tải lại sơ đồ (GHE-VA-HANG-CHO.md mục 5.3).
 */
export function useSeatMapData(eventId: string, opts: { admin?: boolean; pollMs?: number; enabled?: boolean } = {}): SeatMapData {
  const { admin = false, pollMs = 0, enabled = true } = opts;
  const [map, setMap] = useState<SeatMap | null>(null);
  const [status, setStatus] = useState<SeatStatus | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [nonce, setNonce] = useState(0);
  const mapVersion = useRef<number | null>(null);
  const alive = useRef(true);

  const fetchMap = useCallback(() => (admin ? api.admin.getSeatMap(eventId) : api.getSeatMap(eventId)), [admin, eventId]);
  const fetchStatus = useCallback(
    () => (admin ? api.admin.getSeatStatus(eventId) : api.getSeatStatus(eventId)),
    [admin, eventId],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(undefined);
    Promise.all([fetchMap(), fetchStatus()]).then(
      ([m, st]) => {
        if (!active) return;
        mapVersion.current = m.version;
        setMap(m);
        setStatus(st);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [enabled, fetchMap, fetchStatus, nonce]);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await fetchStatus();
      if (!alive.current) return;
      setStatus(st);
      if (mapVersion.current !== null && st.version !== mapVersion.current) {
        const m = await fetchMap();
        if (!alive.current) return;
        mapVersion.current = m.version;
        setMap(m);
      }
    } catch {
      // lần hỏi sau sẽ thử lại; giữ trạng thái cũ
    }
  }, [fetchMap, fetchStatus]);

  useEffect(() => {
    if (!enabled || !pollMs || !map) return;
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refreshStatus();
    }, pollMs);
    return () => clearInterval(timer);
  }, [enabled, pollMs, map, refreshStatus]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return { map, status, error, loading, refreshStatus, reload };
}
