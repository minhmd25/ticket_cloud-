// Mọi ngày giờ hiển thị và thống kê theo giờ Việt Nam (UTC+7, không đổi giờ mùa hè).
export const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const VN_OFFSET = '+07:00';

const dayKeyFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const pad = (n: number) => String(n).padStart(2, '0');

/** Ngày theo giờ Việt Nam dạng YYYY-MM-DD. */
export function vnDayKey(date: Date | string): string {
  return dayKeyFormat.format(new Date(date));
}

/** Cộng/trừ ngày cho khóa ngày YYYY-MM-DD. */
export function addDays(dayKey: string, days: number): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "2026-11-19" → "19/11". */
export function shortDayLabel(dayKey: string): string {
  const [, m, d] = dayKey.split('-');
  return `${d}/${m}`;
}

/** Thời điểm hh:mm của ngày cách hôm nay `daysFromToday` ngày (giờ Việt Nam), dạng ISO. */
export function vnDateTime(daysFromToday: number, hour: number, minute = 0, now = new Date()): string {
  const key = addDays(vnDayKey(now), daysFromToday);
  return new Date(`${key}T${pad(hour)}:${pad(minute)}:00${VN_OFFSET}`).toISOString();
}

/** ISO → giá trị cho ô <input type="datetime-local"> theo giờ Việt Nam. */
export function isoToVnInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(partsFormat.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Giá trị ô datetime-local (hiểu là giờ Việt Nam) → ISO. Trả null nếu không hợp lệ. */
export function vnInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00${VN_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
