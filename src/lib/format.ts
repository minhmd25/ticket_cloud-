import type { EventStatus, OrderStatus } from '../api/types';
import { TIME_ZONE } from './dates';

const currencyFormat = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });
const numberFormat = new Intl.NumberFormat('vi-VN');
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const weekdayFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: TIME_ZONE, weekday: 'long' });
const timeFormat = new Intl.DateTimeFormat('vi-VN', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const formatCurrency = (value: number) => currencyFormat.format(value);
export const formatNumber = (value: number) => numberFormat.format(value);

function valid(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "20:00 19/11/2026" */
export function formatDateTime(iso: string | null | undefined): string {
  const d = valid(iso);
  return d ? dateTimeFormat.format(d) : '—';
}

/** "Thứ Năm, 20:00 19/11/2026" */
export function formatEventTime(iso: string): string {
  const d = valid(iso);
  if (!d) return '—';
  const weekday = weekdayFormat.format(d);
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${dateTimeFormat.format(d)}`;
}

export function formatClock(iso: string): string {
  const d = valid(iso);
  return d ? timeFormat.format(d) : '—';
}

/** Loại hình hay dùng. Backend nhận chuỗi chữ thường không dấu bất kỳ, nên có thể có thêm loại khác. */
export const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'concert', label: 'Concert' },
  { value: 'sport', label: 'Thể thao' },
  { value: 'musical', label: 'Nhạc kịch' },
  { value: 'theater', label: 'Kịch' },
  { value: 'conference', label: 'Hội thảo' },
  { value: 'festival', label: 'Lễ hội' },
];

const EXTRA_CATEGORY_LABELS: Record<string, string> = { sports: 'Thể thao', theatre: 'Kịch', other: 'Khác' };

export function categoryLabel(category: string): string {
  const known = CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? EXTRA_CATEGORY_LABELS[category];
  if (known) return known;
  const words = category.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : category;
}

export const EVENT_STATUS_OPTIONS: Array<{ value: EventStatus; label: string }> = [
  { value: 'PUBLISHED', label: 'Đang mở bán' },
  { value: 'DRAFT', label: 'Nháp' },
  { value: 'CANCELLED', label: 'Đã hủy' },
];

export function eventStatusLabel(status: string): string {
  return EVENT_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export const STATUS_OPTIONS: Array<{ value: OrderStatus; label: string }> = [
  { value: 'CONFIRMED', label: 'Đã xác nhận' },
  { value: 'CANCELLED', label: 'Đã hủy' },
];

export function statusLabel(status: string): string {
  return STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function isPast(iso: string | null | undefined, now = new Date()): boolean {
  const d = valid(iso);
  return d ? d.getTime() <= now.getTime() : false;
}

/** Mã đơn rút gọn để hiển thị: 8 ký tự đầu của UUID, viết hoa. */
export function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8).toUpperCase() : id;
}

/** "20:00 – 22:30" nếu cùng ngày, ngược lại hiện đầy đủ giờ kết thúc. */
export function formatTimeRange(startIso: string, endIso: string | null | undefined): string {
  const start = formatEventTime(startIso);
  if (!endIso) return start;
  const sameDay = formatDateTime(startIso).slice(6) === formatDateTime(endIso).slice(6);
  return sameDay ? `${start} – ${formatDateTime(endIso).slice(0, 5)}` : `${start} → ${formatDateTime(endIso)}`;
}
