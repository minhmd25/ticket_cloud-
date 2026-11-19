import type { SeatMapInput } from './schemas';

export interface LayoutIssue {
  path: string;
  message: string;
}

/** Hai ghế được coi là chồng nhau khi khoảng cách tâm nhỏ hơn đường kính trừ sai số này */
const EPS = 1e-6;
/** Trả về tối đa chừng này lỗi để response không quá lớn */
const MAX_ISSUES = 20;

/**
 * Kiểm tra bố cục sơ đồ (không cần DB):
 *  - mã khu không trùng, ghế chỉ tham chiếu khu có thật
 *  - nhãn ghế không trùng
 *  - mỗi ghế (hình tròn đường kính seatSize) nằm trọn trong khung
 *  - không hai ghế nào chồng lên nhau
 * Kiểm tra chồng nhau dùng lưới băm ô vuông cạnh = seatSize: mỗi ghế chỉ so với ghế ở 9 ô lân cận,
 * nên 5000 ghế vẫn chạy trong vài mili giây thay vì 12,5 triệu phép so sánh.
 */
export function validateLayout(m: Pick<SeatMapInput, 'width' | 'height' | 'seatSize' | 'sections' | 'seats'>): LayoutIssue[] {
  const issues: LayoutIssue[] = [];
  const add = (path: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  const sectionKeys = new Set<string>();
  m.sections.forEach((s, i) => {
    if (sectionKeys.has(s.key)) add(`sections.${i}.key`, `Mã khu "${s.key}" bị trùng`);
    sectionKeys.add(s.key);
  });

  const labels = new Map<string, number>();
  const r = m.seatSize / 2;
  m.seats.forEach((s, i) => {
    const first = labels.get(s.label);
    if (first !== undefined) add(`seats.${i}.label`, `Nhãn ghế "${s.label}" trùng với ghế thứ ${first + 1}`);
    else labels.set(s.label, i);

    if (s.section && !sectionKeys.has(s.section)) add(`seats.${i}.section`, `Ghế "${s.label}" thuộc khu "${s.section}" không có trong sections`);

    if (s.x - r < -EPS || s.x + r > m.width + EPS || s.y - r < -EPS || s.y + r > m.height + EPS) {
      add(`seats.${i}`, `Ghế "${s.label}" (${s.x}, ${s.y}) nằm ngoài khung ${m.width}x${m.height}`);
    }
  });

  const cell = m.seatSize;
  const minDist2 = (m.seatSize - EPS) ** 2;
  const grid = new Map<string, number[]>();
  const keyOf = (cx: number, cy: number) => `${cx}:${cy}`;
  m.seats.forEach((s, i) => {
    const cx = Math.floor(s.x / cell);
    const cy = Math.floor(s.y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of grid.get(keyOf(cx + dx, cy + dy)) ?? []) {
          const o = m.seats[j];
          const d2 = (s.x - o.x) ** 2 + (s.y - o.y) ** 2;
          if (d2 < minDist2) add(`seats.${i}`, `Ghế "${s.label}" chồng lên ghế "${o.label}"`);
        }
      }
    }
    const k = keyOf(cx, cy);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  });

  return issues;
}
