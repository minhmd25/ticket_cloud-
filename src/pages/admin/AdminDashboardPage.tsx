import { useState } from 'react';
import { api, type StatsGroupBy } from '../../api';
import { Alert, EmptyState, ErrorState, Icon, Loading, PageHeader } from '../../components/ui';
import { addDays, shortDayLabel, vnDayKey } from '../../lib/dates';
import { formatClock, formatCurrency, formatDateTime, formatNumber } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { StatsChart, type ChartRow } from './StatsChart';

const RANGE_PRESETS = [
  { days: 7, label: '7 ngày gần nhất' },
  { days: 14, label: '14 ngày gần nhất' },
  { days: 30, label: '30 ngày gần nhất' },
  { days: 90, label: '90 ngày gần nhất' },
];

const GROUP_OPTIONS: Array<{ value: StatsGroupBy; label: string }> = [
  { value: 'day', label: 'Theo ngày' },
  { value: 'event', label: 'Theo sự kiện' },
];

const percent = new Intl.NumberFormat('vi-VN', { style: 'percent', maximumFractionDigits: 1 });

export function AdminDashboardPage() {
  const [groupBy, setGroupBy] = useState<StatsGroupBy>('day');
  const [days, setDays] = useState(14);
  const to = vnDayKey(new Date());
  const from = addDays(to, -(days - 1));

  // Backend GCP lấy số vé từ dịch vụ thống kê trên Azure, doanh thu từ DB của GCP.
  const stats = useAsync(
    () => (groupBy === 'day' ? api.admin.statsDaily({ from, to }) : api.admin.statsByEvent({ from, to })),
    [groupBy, from, to],
    { keepPreviousData: true },
  );
  const data = stats.data;
  const refreshing = stats.loading && Boolean(data);
  const shownGroup = data?.query?.groupBy ?? groupBy;
  const totals = data?.totals;
  const booked = totals?.bookedTickets ?? 0;
  const cancelled = totals?.cancelledTickets ?? 0;

  const rows: ChartRow[] = (data?.items ?? []).map((i) => ({
    key: i.key,
    label: shownGroup === 'day' ? shortDayLabel(i.key) : i.eventTitle || i.key,
    booked: i.bookedTickets,
    cancelled: i.cancelledTickets,
  }));
  const hasActivity = rows.some((r) => r.booked > 0 || r.cancelled > 0);
  const firstColumn = shownGroup === 'event' ? 'Sự kiện' : 'Ngày';

  return (
    <>
      <PageHeader
        title="Thống kê vé"
        subtitle="Số vé đặt và hủy do dịch vụ thống kê trên Azure tổng hợp, lấy qua backend GCP. Doanh thu lấy từ dữ liệu đơn trên GCP."
      />

      <div className="filters" aria-label="Bộ lọc thống kê">
        <div className="field field--inline">
          <label htmlFor="stats-range">Khoảng thời gian</label>
          <select id="stats-range" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {RANGE_PRESETS.map((p) => (
              <option key={p.days} value={p.days}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="segmented" role="group" aria-label="Nhóm số liệu">
          {GROUP_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className="segmented__item"
              aria-pressed={groupBy === o.value}
              onClick={() => setGroupBy(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={stats.reload} disabled={stats.loading}>
          <Icon name="refresh" className={stats.loading ? 'spin' : ''} />
          {stats.loading ? 'Đang tải…' : 'Tải lại số liệu'}
        </button>
        {data && (
          <span className="muted small filters__meta" aria-live="polite">
            Cập nhật lúc {formatClock(data.fetchedAt)}
          </span>
        )}
      </div>

      {data?.stale && (
        <Alert kind="warning">
          Dịch vụ thống kê trên Azure đang không phản hồi. Số vé bên dưới là số liệu lưu tạm lúc{' '}
          {formatDateTime(data.fetchedAt)}.
        </Alert>
      )}
      {stats.error && data && (
        <Alert kind="warning">
          Không cập nhật được số liệu mới: {stats.error instanceof Error ? stats.error.message : 'lỗi không xác định'}. Đang
          hiển thị số liệu lần trước.
        </Alert>
      )}

      {stats.error && !data ? (
        <ErrorState error={stats.error} onRetry={stats.reload} title="Không lấy được số liệu thống kê" />
      ) : !data || !totals ? (
        <Loading label="Đang tải số liệu thống kê… (dịch vụ Azure có thể mất vài giây để khởi động)" />
      ) : (
        <div className={`dashboard-body ${refreshing ? 'is-refreshing' : ''}`} aria-busy={stats.loading}>
          <div className="stat-grid">
            <div className="stat card">
              <p className="stat__label">Vé đã đặt</p>
              <p className="stat__value">{formatNumber(booked)}</p>
              <p className="stat__note">
                <span className="legend__swatch legend__swatch--booked" aria-hidden="true" />
                {formatNumber(totals.bookedOrders)} lượt đặt trong {days} ngày
              </p>
            </div>
            <div className="stat card">
              <p className="stat__label">Vé đã hủy</p>
              <p className="stat__value">{formatNumber(cancelled)}</p>
              <p className="stat__note">
                <span className="legend__swatch legend__swatch--cancelled" aria-hidden="true" />
                {booked > 0 ? `bằng ${percent.format(cancelled / booked)} số vé đặt` : 'chưa có vé đặt'}
              </p>
            </div>
            <div className="stat card">
              <p className="stat__label">Vé thực bán (đặt − hủy)</p>
              <p className="stat__value">{formatNumber(totals.netTickets)}</p>
              <p className="stat__note">vé</p>
            </div>
            <div className="stat card">
              <p className="stat__label">Doanh thu thực</p>
              <p className="stat__value">{formatCurrency(totals.netRevenue)}</p>
              <p className="stat__note">đặt {formatCurrency(totals.bookedRevenue)}, hủy {formatCurrency(totals.cancelledRevenue)}</p>
            </div>
          </div>

          <section className="card" aria-labelledby="chart-heading">
            <h2 id="chart-heading" className="section-title section-title--flush">
              Vé đặt và hủy {shownGroup === 'day' ? 'theo ngày' : 'theo sự kiện'}
            </h2>
            {hasActivity ? (
              <StatsChart items={rows} groupBy={shownGroup} />
            ) : (
              <EmptyState title="Chưa có số liệu">Không có vé nào được đặt hoặc hủy trong khoảng thời gian này.</EmptyState>
            )}
            {data.notes?.tickets && <p className="note">{data.notes.tickets}.</p>}
          </section>

          {data.items.length > 0 && (
            <section className="card" aria-labelledby="table-heading">
              <h2 id="table-heading" className="section-title section-title--flush">
                Bảng số liệu
              </h2>
              <div className="table-wrap">
                <table className="table table--numbers">
                  <thead>
                    <tr>
                      <th scope="col">{firstColumn}</th>
                      <th scope="col" className="num">
                        Vé đã đặt
                      </th>
                      <th scope="col" className="num">
                        Vé đã hủy
                      </th>
                      <th scope="col" className="num">
                        Vé thực bán
                      </th>
                      <th scope="col" className="num">
                        Doanh thu thực
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((i, idx) => (
                      <tr key={i.key}>
                        <th scope="row">{rows[idx].label}</th>
                        <td className="num">{formatNumber(i.bookedTickets)}</td>
                        <td className="num">{formatNumber(i.cancelledTickets)}</td>
                        <td className="num">{formatNumber(i.netTickets)}</td>
                        <td className="num">{formatCurrency(i.netRevenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">Tổng</th>
                      <td className="num">{formatNumber(booked)}</td>
                      <td className="num">{formatNumber(cancelled)}</td>
                      <td className="num">{formatNumber(totals.netTickets)}</td>
                      <td className="num">{formatCurrency(totals.netRevenue)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
