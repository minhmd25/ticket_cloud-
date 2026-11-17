import type { EventCategory, OrderStatus } from '../api/types';
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

export const CATEGORY_OPTIONS: Array<{ value: EventCategory; label: string }> = [
  { value: 'concert', label: 'Concert' },
  { value: 'sports', label: 'Thể thao' },
  { value: 'musical', label: 'Nhạc kịch' },
];

export function categoryLabel(category: string): string {
  return CATEGORY_OPTIONS.find((o) => o.value === category)?.label ?? category;
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
