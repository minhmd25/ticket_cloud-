// Sinh sơ đồ ghế mẫu để quản trị viên tạo nhanh, không phải vẽ từng ghế.
// Kết quả đúng mẫu body của PUT /api/admin/events/:id/seat-map (chưa có `version`).
import type { SeatMapInput } from '../api/types';

export type SeatLayout = Omit<SeatMapInput, 'version'>;

/** Hạng vé và số hàng ghế của hạng đó, tính từ sân khấu ra. */
export interface TierRows {
  ticketTypeId: string;
  rows: number;
}

export const MAX_ROWS = 26; // nhãn hàng A..Z
const SEAT_SIZE = 24;

const deg = (d: number) => (d * Math.PI) / 180;
const round2 = (v: number) => Math.round(v * 100) / 100;
const rowLabel = (r: number) => String.fromCharCode(65 + r);

/** Hạng vé của hàng thứ `r` (0 = hàng gần sân khấu nhất). */
function tierOfRow(tiers: TierRows[], r: number): string {
  let acc = 0;
  for (const t of tiers) {
    acc += t.rows;
    if (r < acc) return t.ticketTypeId;
  }
  return tiers[tiers.length - 1].ticketTypeId;
}

const totalRows = (tiers: TierRows[]) => tiers.reduce((sum, t) => sum + Math.max(0, t.rows), 0);

/**
 * Nhà hát hàng ghế cong quanh sân khấu, chia 3 khu (trái / giữa / phải) bằng hai lối đi.
 * Cùng cách tính với `cloud-backend/src/seating/theater.ts`: hàng thứ r có bán kính 200 + 34r,
 * ghế trên cung 35°–145°, hai ghế cạnh nhau cách nhau ít nhất 28 (> đường kính ghế 24).
 */
export function buildTheaterLayout(tiers: TierRows[]): SeatLayout {
  const rows = Math.min(MAX_ROWS, totalRows(tiers));
  const maxRadius = 200 + 34 * Math.max(0, rows - 1);
  // Khung đủ rộng cho hàng ngoài cùng (backend từ chối ghế nằm ngoài khung).
  const width = Math.max(1200, Math.ceil(2 * maxRadius * Math.cos(deg(35)) + 120));
  const cx = width / 2;
  const cy = 60;
  const spacing = 28;
  const bands = [
    { key: 'phai', from: 35, to: 66 },
    { key: 'giua', from: 74, to: 106 },
    { key: 'trai', from: 114, to: 145 },
  ];
  const seats: SeatLayout['seats'] = [];

  for (let r = 0; r < rows; r++) {
    const radius = 200 + 34 * r;
    const ticketTypeId = tierOfRow(tiers, r);
    const rowSeats: Array<{ x: number; y: number; theta: number; section: string }> = [];
    for (const b of bands) {
      const span = deg(b.to - b.from);
      const n = Math.floor((radius * span) / spacing) + 1;
      for (let i = 0; i < n; i++) {
        const theta = deg(b.from) + (n === 1 ? span / 2 : (span * i) / (n - 1));
        rowSeats.push({ x: cx + radius * Math.cos(theta), y: cy + radius * Math.sin(theta), theta, section: b.key });
      }
    }
    rowSeats.sort((a, b) => a.x - b.x);
    rowSeats.forEach((s, i) => {
      seats.push({
        label: `${rowLabel(r)}${i + 1}`,
        row: rowLabel(r),
        section: s.section,
        ticketTypeId,
        x: round2(s.x),
        y: round2(s.y),
        rotation: round2((s.theta * 180) / Math.PI - 90),
        accessible: r === rows - 1 && (i === 0 || i === rowSeats.length - 1),
        blocked: false,
      });
    });
  }

  const bottom = cy + maxRadius;
  return {
    width,
    height: Math.ceil(bottom + 80),
    seatSize: SEAT_SIZE,
    sections: [
      { key: 'trai', name: 'Khu trái', color: '#4C78A8' },
      { key: 'giua', name: 'Khu giữa', color: '#F58518' },
      { key: 'phai', name: 'Khu phải', color: '#54A24B' },
    ],
    seats,
    decorations: [
      { type: 'stage', x: cx - 200, y: 0, width: 400, height: 60, label: 'SÂN KHẤU' },
      { type: 'label', x: cx, y: bottom + 60, text: 'Lối vào' },
    ],
  };
}

/** Các hàng ghế thẳng, có một lối đi giữa khi mỗi hàng từ 10 ghế trở lên. */
export function buildGridLayout(tiers: TierRows[], seatsPerRow: number): SeatLayout {
  const rows = Math.min(MAX_ROWS, totalRows(tiers));
  const perRow = Math.max(1, Math.min(60, Math.floor(seatsPerRow)));
  const pitch = 32;
  const rowGap = 40;
  const margin = 40;
  const aisle = perRow >= 10 ? 40 : 0;
  const half = Math.ceil(perRow / 2);
  const rowsWidth = perRow * pitch + aisle;
  const width = Math.max(400, Math.ceil(rowsWidth + margin * 2));
  const left = (width - rowsWidth) / 2 + pitch / 2;
  const top = 120;
  const seats: SeatLayout['seats'] = [];

  for (let r = 0; r < rows; r++) {
    const ticketTypeId = tierOfRow(tiers, r);
    for (let i = 0; i < perRow; i++) {
      const rightSide = aisle > 0 && i >= half;
      seats.push({
        label: `${rowLabel(r)}${i + 1}`,
        row: rowLabel(r),
        section: aisle > 0 ? (rightSide ? 'phai' : 'trai') : 'chinh',
        ticketTypeId,
        x: round2(left + i * pitch + (rightSide ? aisle : 0)),
        y: top + r * rowGap,
        rotation: 0,
        accessible: r === rows - 1 && (i === 0 || i === perRow - 1),
        blocked: false,
      });
    }
  }

  const bottom = top + Math.max(0, rows - 1) * rowGap;
  const stageWidth = Math.min(400, width - margin * 2);
  return {
    width,
    height: Math.ceil(bottom + 90),
    seatSize: SEAT_SIZE,
    sections:
      aisle > 0
        ? [
            { key: 'trai', name: 'Khu trái', color: '#4C78A8' },
            { key: 'phai', name: 'Khu phải', color: '#54A24B' },
          ]
        : [{ key: 'chinh', name: 'Khu chính', color: '#4C78A8' }],
    seats,
    decorations: [
      { type: 'stage', x: (width - stageWidth) / 2, y: 20, width: stageWidth, height: 50, label: 'SÂN KHẤU' },
      { type: 'label', x: width / 2, y: bottom + 70, text: 'Lối vào' },
    ],
  };
}
