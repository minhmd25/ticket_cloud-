import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { CategoryBadge, EmptyState, ErrorState, Icon, Loading, PageHeader, Pager } from '../../components/ui';
import { categoryLabel, formatCurrency, formatEventTime, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const PAGE_SIZE = 12;

export function EventListPage() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);

  // Bộ lọc lấy từ các loại hình đang có sự kiện mở bán (GET /api/events/categories).
  const categories = useAsync(() => api.listCategories(), []);
  const { data, error, loading, reload } = useAsync(
    () => api.listEvents({ category: category || undefined, page, limit: PAGE_SIZE }),
    [category, page],
    { keepPreviousData: true },
  );

  const filters = [
    { value: '', label: 'Tất cả' },
    ...(categories.data ?? []).map((c) => ({ value: c.category, label: categoryLabel(c.category) })),
  ];
  // Loại hình đang lọc nhưng không còn trong danh sách (ví dụ mở từ link cũ) vẫn hiện để bỏ chọn được.
  if (category && !filters.some((f) => f.value === category)) filters.push({ value: category, label: categoryLabel(category) });

  const select = (value: string) => setParams(value ? { category: value } : {});
  const goPage = (p: number) => {
    const next = new URLSearchParams(params);
    if (p > 1) next.set('page', String(p));
    else next.delete('page');
    setParams(next);
  };

  const events = data?.data ?? [];

  return (
    <>
      <PageHeader title="Sự kiện" subtitle="Chọn sự kiện bạn muốn tham gia và đặt vé trực tuyến." />

      <div className="toolbar">
        <div className="chips" role="group" aria-label="Lọc theo loại hình">
          {filters.map((f) => (
            <button
              key={f.value || 'all'}
              type="button"
              className="chip"
              aria-pressed={category === f.value}
              onClick={() => select(f.value)}
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
          {category
            ? `Hiện không có sự kiện thuộc loại "${categoryLabel(category)}". Hãy thử bộ lọc khác.`
            : 'Vui lòng quay lại sau.'}
        </EmptyState>
      ) : (
        <>
          <ul className={`event-grid ${loading ? 'is-refreshing' : ''}`} aria-busy={loading}>
            {events.map((ev) => (
              <li key={ev.id} className="event-card card">
                <CategoryBadge category={ev.category} />
                <h2 className="event-card__title">
                  <Link to={`/events/${encodeURIComponent(ev.id)}`} className="stretched-link">
                    {ev.title}
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
                <p className="event-card__price">
                  {ev.minPrice === null ? (
                    <span className="muted">Chưa mở bán vé</span>
                  ) : ev.totalAvailable === 0 ? (
                    <span className="badge badge--muted">Hết vé</span>
                  ) : (
                    <>
                      Từ <strong>{formatCurrency(ev.minPrice)}</strong>
                      <span className="muted"> · còn {formatNumber(ev.totalAvailable)} vé</span>
                    </>
                  )}
                </p>
                <span className="event-card__cta" aria-hidden="true">
                  Xem chi tiết và đặt vé →
                </span>
              </li>
            ))}
          </ul>
          <Pager pagination={data.pagination} onPage={goPage} disabled={loading} />
        </>
      )}
    </>
  );
}
