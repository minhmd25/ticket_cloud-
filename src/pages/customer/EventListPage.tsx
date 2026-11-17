import { Link, useSearchParams } from 'react-router-dom';
import { api, type EventCategory } from '../../api';
import { CategoryBadge, EmptyState, ErrorState, Icon, Loading, PageHeader } from '../../components/ui';
import { CATEGORY_OPTIONS, formatEventTime } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const FILTERS: Array<{ value: '' | EventCategory; label: string }> = [{ value: '', label: 'Tất cả' }, ...CATEGORY_OPTIONS];

export function EventListPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('category') ?? '';
  const category = FILTERS.some((f) => f.value === raw) ? (raw as '' | EventCategory) : '';

  const { data, error, loading, reload } = useAsync(() => api.listEvents(category || undefined), [category], {
    keepPreviousData: true,
  });

  const events = data ? [...data].sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];
  const currentLabel = FILTERS.find((f) => f.value === category)?.label ?? 'Tất cả';

  return (
    <>
      <PageHeader title="Sự kiện" subtitle="Chọn sự kiện bạn muốn tham gia và đặt vé trực tuyến." />

      <div className="toolbar">
        <div className="chips" role="group" aria-label="Lọc theo loại hình">
          {FILTERS.map((f) => (
            <button
              key={f.value || 'all'}
              type="button"
              className="chip"
              aria-pressed={category === f.value}
              onClick={() => setParams(f.value ? { category: f.value } : {})}
            >
              {f.label}
            </button>
          ))}
        </div>
        {loading && data && <span className="muted small">Đang cập nhật…</span>}
      </div>

      {error && !loading ? (
        <ErrorState error={error} onRetry={reload} title="Không tải được danh sách sự kiện" />
      ) : !data ? (
        <Loading label="Đang tải danh sách sự kiện…" />
      ) : events.length === 0 ? (
        <EmptyState title="Chưa có sự kiện nào">
          {category ? `Hiện không có sự kiện thuộc loại "${currentLabel}". Hãy thử bộ lọc khác.` : 'Vui lòng quay lại sau.'}
        </EmptyState>
      ) : (
        <ul className={`event-grid ${loading ? 'is-refreshing' : ''}`} aria-busy={loading}>
          {events.map((ev) => (
            <li key={ev.id} className="event-card card">
              <CategoryBadge category={ev.category} />
              <h2 className="event-card__title">
                <Link to={`/events/${encodeURIComponent(ev.id)}`} className="stretched-link">
                  {ev.name}
                </Link>
              </h2>
              <p className="meta">
                <Icon name="calendar" />
                {formatEventTime(ev.startTime)}
              </p>
              <p className="meta">
                <Icon name="pin" />
                {ev.venue}
              </p>
              <span className="event-card__cta" aria-hidden="true">
                Xem chi tiết và đặt vé →
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
