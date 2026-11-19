import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, errorMessage, type EventDetail, type Order, type QueueEntry } from '../../api';
import { Alert, Icon } from '../../components/ui';
import { formatDateTime, formatEventTime, formatNumber, seatLabels, shortId } from '../../lib/format';

/** "1 ngày 02:03:04", "02:03:04" hoặc "03:04". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = h > 0 || days > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days} ngày ${clock}` : clock;
}

export interface QueueSlot {
  /** Đơn vừa đặt trong lượt: hàng chờ chuyển lượt sang COMPLETED. */
  onBooked: (order: Order) => void;
  /** Backend báo chưa tới lượt / chưa mở bán khi đặt vé: quay lại trang chờ. */
  onQueueLost: () => void;
}

type Phase = 'checking' | 'none' | 'entry' | 'direct' | 'error';

const RETRY_ON_ERROR_SECONDS = 5;

/**
 * Trang chờ của hàng chờ ảo (GHE-VA-HANG-CHO.md mục 5.2). Chỉ hiện `children` (form đặt vé)
 * khi khách đã tới lượt (ADMITTED), hoặc khi quản trị viên đã tắt hàng chờ.
 */
export function QueueGate({ event, children }: { event: EventDetail; children: (slot: QueueSlot) => ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  // Lệch giữa đồng hồ máy chủ và máy khách, để đếm ngược không phụ thuộc giờ máy khách.
  const offset = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const entryRef = useRef<QueueEntry | null>(null);
  const lastImmediate = useRef(0);
  entryRef.current = entry;
  const serverNow = now + offset.current;

  const accept = useCallback((e: QueueEntry) => {
    offset.current = Date.parse(e.serverTime) - Date.now();
    setNow(Date.now());
    setEntry(e);
    setPhase(e.queueEnabled ? 'entry' : 'direct');
  }, []);

  const poll = useCallback(async () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    try {
      const e = await api.getMyQueue(event.id);
      if (alive.current) accept(e);
    } catch (err) {
      if (!alive.current) return;
      if (err instanceof ApiError && err.code === 'QUEUE_ENTRY_NOT_FOUND') {
        setEntry(null);
        setPhase('none');
      } else if (err instanceof ApiError && err.isNetworkError) {
        // Mất mạng tạm thời: thử lại sau ít giây, giữ màn hình hiện tại.
        pollTimer.current = setTimeout(() => void poll(), RETRY_ON_ERROR_SECONDS * 1000);
      } else if (!entryRef.current) {
        setError(err);
        setPhase('error');
      }
    }
  }, [accept, event.id]);

  // Lần đầu: khách có thể đang có lượt từ trước (tải lại trang) thì tiếp tục luôn.
  useEffect(() => {
    alive.current = true;
    void poll();
    return () => {
      alive.current = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id]);

  // Hỏi lại theo nhịp backend gợi ý; dừng khi retryAfterSeconds = null.
  useEffect(() => {
    if (phase !== 'entry' || !entry || entry.retryAfterSeconds === null) return;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = setTimeout(() => void poll(), entry.retryAfterSeconds * 1000);
    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [entry, phase, poll]);

  // Đồng hồ đếm ngược.
  const ticking = phase === 'entry' && (entry?.status === 'WAITING' || entry?.status === 'ADMITTED');
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // Hết giờ mua hoặc tới giờ mở bán: hỏi lại ngay thay vì chờ nhịp kế.
  const admittedLeft = entry?.status === 'ADMITTED' && entry.expiresAt ? Date.parse(entry.expiresAt) - serverNow : null;
  const untilSale = entry && !entry.saleStarted ? Date.parse(entry.saleStartAt) - serverNow : null;
  const expiredNow = admittedLeft !== null && admittedLeft <= 0;
  const saleNow = untilSale !== null && untilSale <= 0;
  useEffect(() => {
    if (!(expiredNow || saleNow)) return;
    // Tránh hỏi dồn dập khi đồng hồ hai bên lệch nhau vài trăm mili giây.
    if (Date.now() - lastImmediate.current < 2000) return;
    lastImmediate.current = Date.now();
    void poll();
  }, [expiredNow, saleNow, now, poll]);

  const join = async () => {
    setBusy(true);
    setNotice(null);
    setLastOrder(null);
    try {
      accept(await api.joinQueue(event.id));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'QUEUE_NOT_ENABLED') setPhase('direct');
      else setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      accept(await api.leaveQueue(event.id));
    } catch (err) {
      setNotice(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const slot: QueueSlot = {
    onBooked: (order) => {
      setLastOrder(order);
      void poll();
    },
    onQueueLost: () => {
      setNotice('Lượt mua của bạn không còn hiệu lực. Hãy xếp hàng lại.');
      void poll();
    },
  };

  if (phase === 'direct') return <>{children(slot)}</>;

  const info = event.queue;
  const intro = info && (
    <p className="muted small">
      Mở bán lúc <strong>{formatEventTime(info.saleStartAt)}</strong>. Tối đa {formatNumber(info.maxActive)} người mua cùng
      lúc, mỗi lượt {formatNumber(info.accessMinutes)} phút.
    </p>
  );

  if (phase === 'checking') {
    return (
      <div className="queue" aria-busy="true">
        <p className="muted">Đang kiểm tra lượt xếp hàng của bạn…</p>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <Alert kind="error">
        Không kiểm tra được hàng chờ. {errorMessage(error)}{' '}
        <button type="button" className="link-btn" onClick={() => void poll()}>
          Thử lại
        </button>
      </Alert>
    );
  }

  const noticeAlert = notice && (
    <Alert kind="warning" onClose={() => setNotice(null)}>
      {notice}
    </Alert>
  );

  const rejoin = (label = 'Vào hàng lại') => (
    <button type="button" className="btn btn--primary btn--block" onClick={join} disabled={busy}>
      {busy ? 'Đang vào hàng…' : label}
    </button>
  );

  if (phase === 'none' || !entry) {
    return (
      <div className="queue queue--intro">
        {noticeAlert}
        <div className="queue__hero">
          <span className="queue__icon" aria-hidden="true">
            <Icon name="users" />
          </span>
          <div>
            <h3 className="queue__title">Sự kiện mở bán qua hàng chờ</h3>
            {intro}
          </div>
        </div>
        <p className="small">
          Vào hàng trước giờ mở bán thì thứ tự được xếp <strong>ngẫu nhiên</strong> lúc mở bán, nên không cần canh từng giây.
        </p>
        {rejoin('Vào hàng chờ')}
      </div>
    );
  }

  if (entry.status === 'ADMITTED') {
    const urgent = admittedLeft !== null && admittedLeft < 60_000;
    return (
      <>
        <div className={`queue-banner ${urgent ? 'is-urgent' : ''}`} role="status">
          <Icon name="check" />
          <span>
            <strong>Đã tới lượt bạn!</strong> Còn{' '}
            <span className="queue-banner__time">{formatCountdown(admittedLeft ?? 0)}</span> để đặt vé.
          </span>
        </div>
        {noticeAlert}
        {children(slot)}
      </>
    );
  }

  if (entry.status === 'WAITING') {
    return (
      <div className="queue" aria-live="polite">
        {noticeAlert}
        {!entry.saleStarted ? (
          <>
            <p className="queue__eyebrow">Bạn đã ở trong hàng chờ</p>
            <p className="queue__label">Mở bán sau</p>
            <p className="queue__countdown">{formatCountdown(untilSale ?? 0)}</p>
            <p className="small">
              Thứ tự sẽ được xếp ngẫu nhiên lúc mở bán ({formatDateTime(entry.saleStartAt)}).{' '}
              <strong>{formatNumber(entry.waitingCount)}</strong> người đang chờ.
            </p>
          </>
        ) : (
          <>
            <p className="queue__eyebrow">Bạn đang xếp hàng</p>
            {entry.position !== null && (
              <p className="queue__label">
                Số thứ tự <strong>#{formatNumber(entry.position)}</strong>
              </p>
            )}
            <p className="queue__countdown queue__countdown--text">
              {entry.aheadOfYou ? `Còn ${formatNumber(entry.aheadOfYou)} người phía trước` : 'Bạn đứng đầu hàng'}
            </p>
            <div className="queue__progress" aria-hidden="true">
              <span />
            </div>
            <p className="small">
              {entry.aheadOfYou
                ? 'Trang tự cập nhật, tới lượt thì form đặt vé sẽ hiện ra.'
                : 'Đang chờ người phía trước mua xong. Tới lượt thì form đặt vé sẽ hiện ra.'}
            </p>
          </>
        )}
        <p className="note">Giữ trang này mở. Nếu đóng trang hoặc mất kết nối quá 2 phút, bạn sẽ mất lượt.</p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={leave} disabled={busy}>
          Rời hàng
        </button>
      </div>
    );
  }

  // COMPLETED / EXPIRED / LEFT: lượt đã kết thúc.
  return (
    <div className="queue">
      {noticeAlert}
      {entry.status === 'COMPLETED' ? (
        <Alert kind="success">
          <p>
            <strong>Đặt vé thành công!</strong>
            {lastOrder && (
              <>
                {' '}
                Mã đơn <strong className="code">{shortId(lastOrder.id)}</strong>
                {lastOrder.seats.length > 0 && ` · ghế ${seatLabels(lastOrder.seats)}`}.{' '}
                <Link to={`/my-tickets/${encodeURIComponent(lastOrder.id)}`}>Xem đơn</Link>
              </>
            )}
          </p>
          <p>Lượt mua của bạn đã kết thúc. Muốn mua thêm thì vào hàng lại.</p>
        </Alert>
      ) : entry.status === 'EXPIRED' ? (
        <Alert kind="warning">Lượt của bạn đã hết hạn (hết giờ mua, hoặc rời trang chờ quá lâu).</Alert>
      ) : (
        <Alert kind="info">Bạn đã rời hàng chờ.</Alert>
      )}
      {intro}
      {rejoin()}
    </div>
  );
}
