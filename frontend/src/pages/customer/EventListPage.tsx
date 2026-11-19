import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useAuth } from '../../auth/AuthContext';
import { CategoryBadge, EmptyState, ErrorState, EventCover, Icon, Loading, Pager } from '../../components/ui';
import { categoryLabel, formatCurrency, formatEventTime, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

const PAGE_SIZE = 12;
const LOW_STOCK = 20;

export function EventListPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? '';
  const q = params.get('q') ?? '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [search, setSearch] = useState(q);

  // Bộ lọc lấy từ các loại hình đang có sự kiện mở bán (GET /api/events/categories).
  const categories = useAsync(() => api.listCategories(), []);
  const { data, error, loading, reload } = useAsync(
    () => api.listEvents({ category: category || undefined, q: q || undefined, page, limit: PAGE_SIZE }),
    [category, q, page],
    { keepPreviousData: true },
  );

  // Tìm theo tên hoặc địa điểm: đợi người dùng ngừng gõ một chút rồi mới gọi API.
  useEffect(() => {
    const value = search.trim();
    if (value === q) return;
    const timer = setTimeout(() => {
      const next = new URLSearchParams(params);
      if (value) next.set('q', value);
      else next.delete('q');
      next.delete('page');
      setParams(next, { replace: true });
    }, 350);
    return () => clearTimeout(timer);
  }, [search, q, params, setParams]);

  const filters = [
    { value: '', label: 'Tất cả' },
    ...(categories.data ?? []).map((c) => ({ value: c.category, label: categoryLabel(c.category) })),
  ];
  // Loại hình đang lọc nhưng không còn trong danh sách (ví dụ mở từ link cũ) vẫn hiện để bỏ chọn được.
  if (category && !filters.some((f) => f.value === category)) filters.push({ value: category, label: categoryLabel(category) });

  const select = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('category', value);
    else next.delete('category');
    next.delete('page');
    setParams(next);
  };
  const goPage = (p: number) => {
    const next = new URLSearchParams(params);
    if (p > 1) next.set('page', String(p));
    else next.delete('page');
    setParams(next);
  };

  const events = data?.data ?? [];
  const total = data?.pagination.total;

  return (
    <>
      <section className="hero" aria-labelledby="events-heading">
        <div className="hero__text">
          <p className="hero__eyebrow">Xin chào{user ? `, ${user.username}` : ''}</p>
          <h1 id="events-heading">Sự kiện</h1>
          <p className="hero__lead">Concert, thể thao, nhạc kịch và nhiều sự kiện khác. Chọn chỗ ngồi và đặt vé trong vài bước.</p>
        </div>
        <div className="hero__search" role="search">
          <Icon name="search" />
          <label htmlFor="event-search" className="sr-only">
            Tìm sự kiện
          </label>
          <input
            id="event-search"
            type="search"
            value={search}
            placeholder="Tìm theo tên sự kiện hoặc địa điểm"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </section>

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
        <span className="muted small" aria-live="polite">
          {loading && data ? 'Đang cập nhật…' : total !== undefined ? `${formatNumber(total)} sự kiện` : ''}
        </span>
      </div>

      {error && !loading ? (
        <ErrorState error={error} onRetry={reload} title="Không tải được danh sách sự kiện" />
      ) : !data ? (
        <Loading label="Đang tải danh sách sự kiện…" />
      ) : events.length === 0 ? (
        <EmptyState title={q ? 'Không tìm thấy sự kiện phù hợp' : 'Chưa có sự kiện nào'}>
          {q
            ? `Không có sự kiện nào khớp "${q}". Thử từ khóa khác nhé.`
            : category
              ? `Hiện không có sự kiện thuộc loại "${categoryLabel(category)}". Hãy thử bộ lọc khác.`
              : 'Vui lòng quay lại sau.'}
        </EmptyState>
      ) : (
        <>
          <ul className={`event-grid ${loading ? 'is-refreshing' : ''}`} aria-busy={loading}>
            {events.map((ev) => {
              const soldOut = ev.minPrice !== null && ev.totalAvailable === 0;
              const low = !soldOut && ev.minPrice !== null && ev.totalAvailable <= LOW_STOCK;
              return (
                <li key={ev.id} className="event-card">
                  <EventCover category={ev.category} startTime={ev.startTime} className="event-card__cover">
                    {soldOut && <span className="cover__flag">Hết vé</span>}
                    {low && <span className="cover__flag cover__flag--hot">Sắp hết vé</span>}
                  </EventCover>
                  <div className="event-card__body">
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
                    <div className="event-card__foot">
                      <p className="event-card__price">
                        {ev.minPrice === null ? (
                          <span className="muted">Chưa mở bán vé</span>
                        ) : soldOut ? (
                          <span className="badge badge--muted">Hết vé</span>
                        ) : (
                          <>
                            <span className="muted small">Từ</span> <strong>{formatCurrency(ev.minPrice)}</strong>
                            <span className="muted small"> · còn {formatNumber(ev.totalAvailable)} vé</span>
                          </>
                        )}
                      </p>
                      <span className="event-card__cta" aria-hidden="true">
                        <Icon name="arrowRight" />
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <Pager pagination={data.pagination} onPage={goPage} disabled={loading} />
        </>
      )}
    </>
  );
}
