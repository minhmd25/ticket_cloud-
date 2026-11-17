import type { ReactNode } from 'react';
import { errorMessage } from '../api';
import { categoryLabel, statusLabel } from '../lib/format';

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
};

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
