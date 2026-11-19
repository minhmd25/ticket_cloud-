import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import type { StatsGroupBy } from '../../api';

/** Một cột/thanh trên biểu đồ: số vé đặt và hủy của một ngày hoặc một sự kiện. */
export interface ChartRow {
  key: string;
  label: string;
  booked: number;
  cancelled: number;
}
import { formatNumber } from '../../lib/format';

interface ChartColors {
  booked: string;
  cancelled: string;
  grid: string;
  axis: string;
  muted: string;
  hover: string;
}

const FALLBACK: ChartColors = {
  booked: '#2a78d6',
  cancelled: '#eb6834',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  muted: '#898781',
  hover: 'rgba(11, 11, 11, 0.05)',
};

// Màu lấy từ biến CSS để biểu đồ đổi theo chế độ sáng/tối của hệ điều hành.
function readColors(): ChartColors {
  if (typeof document === 'undefined') return FALLBACK;
  const style = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    booked: v('--series-1', FALLBACK.booked),
    cancelled: v('--series-2', FALLBACK.cancelled),
    grid: v('--chart-grid', FALLBACK.grid),
    axis: v('--chart-axis', FALLBACK.axis),
    muted: v('--text-muted', FALLBACK.muted),
    hover: v('--chart-hover', FALLBACK.hover),
  };
}

function useChartColors(): ChartColors {
  const [colors, setColors] = useState(readColors);
  useEffect(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    const update = () => setColors(readColors());
    mq?.addEventListener('change', update);
    return () => mq?.removeEventListener('change', update);
  }, []);
  return colors;
}

export const SERIES = [
  { key: 'booked' as const, label: 'Vé đã đặt' },
  { key: 'cancelled' as const, label: 'Vé đã hủy' },
];

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip__label">{label}</div>
      {payload.map((p) => (
        <div key={String(p.dataKey)} className="chart-tooltip__row">
          <span className="chart-tooltip__key" style={{ background: p.color }} aria-hidden="true" />
          <strong>{formatNumber(Number(p.value ?? 0))}</strong>
          <span>{p.name}</span>
        </div>
      ))}
    </div>
  );
}

const truncate = (text: string, max = 26) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Các mốc trục tròn (bước 1, 2, 5, 10, 20, 25, 50, …), tối đa 5 khoảng. */
export function niceTicks(max: number): number[] {
  const top = Math.max(1, max);
  const magnitude = 10 ** Math.floor(Math.log10(top));
  const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].map((m) => m * magnitude).filter((s) => s >= 1);
  const step = steps.find((s) => Math.ceil(top / s) <= 5 && Number.isInteger(s)) ?? magnitude * 10;
  const count = Math.ceil(top / step);
  return Array.from({ length: count + 1 }, (_, i) => i * step);
}

/** Tắt hiệu ứng của biểu đồ khi người dùng bật "giảm chuyển động" trong hệ điều hành. */
function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setReduced(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function StatsChart({ items, groupBy }: { items: ChartRow[]; groupBy: StatsGroupBy }) {
  const c = useChartColors();
  const animate = !useReducedMotion();
  const axisTick = { fill: c.muted, fontSize: 12 };
  const ticks = niceTicks(Math.max(0, ...items.flatMap((i) => [i.booked, i.cancelled])));
  const domain: [number, number] = [0, ticks[ticks.length - 1]];
  const summary = items
    .map((i) => `${i.label}: ${i.booked} vé đặt, ${i.cancelled} vé hủy`)
    .join('; ');

  return (
    <figure className="chart" aria-label={`Biểu đồ số vé đặt và hủy ${groupBy === 'day' ? 'theo ngày' : 'theo sự kiện'}`}>
      <ul className="legend" aria-label="Chú thích">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className="legend__swatch" style={{ background: c[s.key] }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="chart__plot" role="img" aria-label={summary}>
        {groupBy === 'day' ? (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={items} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="22%">
              <CartesianGrid vertical={false} stroke={c.grid} />
              <XAxis
                dataKey="label"
                tick={axisTick}
                tickLine={false}
                axisLine={{ stroke: c.axis }}
                interval="preserveStartEnd"
                minTickGap={10}
              />
              <YAxis
                allowDecimals={false}
                ticks={ticks}
                domain={domain}
                tick={axisTick}
                tickLine={false}
                axisLine={false}
                width={40}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: c.hover }} />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={c[s.key]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={animate} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(200, items.length * 64 + 40)}>
            <BarChart
              data={items}
              layout="vertical"
              margin={{ top: 4, right: 16, bottom: 0, left: 0 }}
              barGap={2}
              barCategoryGap="24%"
            >
              <CartesianGrid horizontal={false} stroke={c.grid} />
              <XAxis
                type="number"
                allowDecimals={false}
                ticks={ticks}
                domain={domain}
                tick={axisTick}
                tickLine={false}
                axisLine={{ stroke: c.axis }}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={190}
                tick={axisTick}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value: string) => truncate(value)}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: c.hover }} />
              {SERIES.map((s) => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={c[s.key]} radius={[0, 4, 4, 0]} maxBarSize={24} isAnimationActive={animate} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </figure>
  );
}
