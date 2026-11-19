import type { ReactNode } from 'react';
import { errorMessage, type Pagination } from '../api';
import { categoryLabel, dateBadge, eventStatusLabel, formatNumber, statusLabel } from '../lib/format';

export function Loading({ label = 'Đang tải dữ liệu…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = 'Không tải được dữ liệu',
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
}) {
  return (
    <div className="state state--error" role="alert">
      <Icon name="alert" />
      <div>
        <p className="state__title">{title}</p>
        <p className="state__text">{errorMessage(error)}</p>
      </div>
      {onRetry && (
        <button type="button" className="btn btn--secondary" onClick={onRetry}>
          Thử lại
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      <Icon name="inbox" />
      <div>
        <p className="state__title">{title}</p>
        {children && <div className="state__text">{children}</div>}
      </div>
    </div>
  );
}

type AlertKind = 'error' | 'success' | 'info' | 'warning';

export function Alert({ kind, children, onClose }: { kind: AlertKind; children: ReactNode; onClose?: () => void }) {
  const icon = kind === 'success' ? 'check' : kind === 'info' ? 'info' : 'alert';
  return (
    <div className={`alert alert--${kind}`} role={kind === 'error' || kind === 'warning' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div className="alert__body">{children}</div>
      {onClose && (
        <button type="button" className="alert__close" onClick={onClose} aria-label="Đóng thông báo">
          ×
        </button>
      )}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const kind = status === 'CONFIRMED' ? 'good' : status === 'CANCELLED' ? 'muted' : 'info';
  return (
    <span className={`badge badge--${kind}`}>
      <Icon name={status === 'CONFIRMED' ? 'check' : 'x'} />
      {statusLabel(status)}
    </span>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  return <span className={`tag tag--${category}`}>{categoryLabel(category)}</span>;
}

export function EventStatusBadge({ status }: { status: string }) {
  const kind = status === 'PUBLISHED' ? 'good' : status === 'CANCELLED' ? 'danger' : 'muted';
  return <span className={`badge badge--${kind}`}>{eventStatusLabel(status)}</span>;
}

/** Chuyển trang cho các danh sách backend trả theo trang. Ẩn khi chỉ có một trang. */
export function Pager({
  pagination,
  onPage,
  disabled,
}: {
  pagination: Pagination | undefined;
  onPage: (page: number) => void;
  disabled?: boolean;
}) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const { page, totalPages, total } = pagination;
  return (
    <nav className="pager" aria-label="Phân trang">
      <button type="button" className="btn btn--secondary btn--sm" onClick={() => onPage(page - 1)} disabled={disabled || page <= 1}>
        ← Trang trước
      </button>
      <span className="pager__info">
        Trang {page}/{totalPages} · {formatNumber(total)} mục
      </span>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() => onPage(page + 1)}
        disabled={disabled || page >= totalPages}
      >
        Trang sau →
      </button>
    </nav>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  back?: ReactNode;
}) {
  return (
    <header className="page-header">
      {back && <div className="page-header__back">{back}</div>}
      <div className="page-header__row">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="page-header__subtitle">{subtitle}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
    </header>
  );
}

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p className="field__error" id={id}>
      {message}
    </p>
  );
}

const ICONS: Record<string, ReactNode> = {
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5v.01" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M7 7l10 10M17 7L7 17" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5v.01" />
    </>
  ),
  inbox: (
    <>
      <path d="M4 13l2.5-7h11L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
      <path d="M4 13h4.5l1 2h5l1-2H20" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  ticket: (
    <path d="M4 8a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v2.5a1.5 1.5 0 0 0 0 3V16a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-2.5a1.5 1.5 0 0 0 0-3z" />
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17 14.2a5.5 5.5 0 0 1 3.5 4.8" />
    </>
  ),
  seat: (
    <>
      <path d="M7 11V6.5A2.5 2.5 0 0 1 9.5 4h5A2.5 2.5 0 0 1 17 6.5V11" />
      <path d="M5 11h14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 15.5z" />
      <path d="M7 17v3M17 17v3" />
    </>
  ),
  music: (
    <>
      <path d="M9 18V5.5l10-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  trophy: (
    <>
      <path d="M8 4h8v5a4 4 0 0 1-8 0z" />
      <path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8.5 20h7M10 17h4" />
    </>
  ),
  masks: (
    <>
      <path d="M4 5c3 1.2 6 1.2 9 0v6a4.5 4.5 0 0 1-9 0z" />
      <path d="M13 9.5c2.4.9 4.6.9 7 0V15a4.5 4.5 0 0 1-7.2 3.6" />
      <path d="M6.3 9h.01M10.7 9h.01M6.8 12.2c.9.7 2.5.7 3.4 0" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3.5" width="6" height="10" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  sparkle: <path d="M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2zM19 3v4M17 5h4" />,
  chart: (
    <>
      <path d="M4 20h16" />
      <path d="M7 16v-5M12 16V7M17 16v-8" />
    </>
  ),
  list: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  logout: (
    <>
      <path d="M10 5H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
      <path d="M15 8l4 4-4 4M19 12H9" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 7.7-1.5" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5z" />,
  edit: <path d="M14.5 5.5l4 4L9 19H5v-4zM12.5 7.5l4 4" />,
};

/** Biểu tượng theo loại hình sự kiện. */
export function categoryIcon(category: string): string {
  switch (category) {
    case 'concert':
    case 'musical':
      return 'music';
    case 'sport':
    case 'sports':
      return 'trophy';
    case 'theater':
    case 'theatre':
      return 'masks';
    case 'conference':
      return 'mic';
    default:
      return 'sparkle';
  }
}

/** Ô ngày nổi trên ảnh bìa sự kiện: ngày to, tháng và thứ nhỏ. */
export function DateBlock({ iso, className }: { iso: string; className?: string }) {
  const d = dateBadge(iso);
  return (
    <span className={`date-block ${className ?? ''}`} aria-hidden="true">
      <span className="date-block__month">{d.month}</span>
      <span className="date-block__day">{d.day}</span>
      <span className="date-block__weekday">
        {d.weekday} · {d.time}
      </span>
    </span>
  );
}

/** Ảnh bìa vẽ bằng CSS theo loại hình (backend chưa có ảnh sự kiện). */
export function EventCover({
  category,
  startTime,
  children,
  className,
}: {
  category: string;
  startTime: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`cover cover--${category} ${className ?? ''}`}>
      <Icon name={categoryIcon(category)} className="cover__art" />
      <DateBlock iso={startTime} />
      {children}
    </div>
  );
}

export function Icon({ name, className }: { name: keyof typeof ICONS | string; className?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
