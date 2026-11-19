import type { SeatMapInput } from './schemas';

export interface TheaterTiers {
  /** hàng A-D, gần sân khấu */
  front: string;
  /** hàng E-J */
  middle: string;
  /** hàng K trở về sau */
  back: string;
}

const deg = (d: number) => (d * Math.PI) / 180;
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Sinh sơ đồ nhà hát: các hàng ghế cong đồng tâm quanh sân khấu, chia 3 khu (trái / giữa / phải)
 * bằng hai lối đi. Dùng cho seed và test, đồng thời là ví dụ dữ liệu cho frontend.
 *
 * Hình học (trục y hướng xuống):
 *  - tâm các cung tròn = giữa sân khấu (600, 60), hàng thứ r có bán kính 200 + 34r
 *  - ghế nằm trên cung từ 35° đến 145°, chia 3 dải góc, giữa các dải chừa 8° làm lối đi
 *  - khoảng cách hai ghế cạnh nhau trên một hàng >= 28 > seatSize (24) => không chồng nhau
 *  - mỗi ghế xoay để quay mặt về sân khấu
 */
export function buildTheaterLayout(tiers: TheaterTiers, rows = 14): Omit<SeatMapInput, 'version'> {
  const cx = 600;
  const cy = 60;
  const seatSize = 24;
  const spacing = 28;
  const bands = [
    { key: 'phai', from: 35, to: 66 },
    { key: 'giua', from: 74, to: 106 },
    { key: 'trai', from: 114, to: 145 },
  ];
  const seats: SeatMapInput['seats'] = [];

  for (let r = 0; r < rows; r++) {
    const rowLabel = String.fromCharCode(65 + r); // A, B, C...
    const radius = 200 + 34 * r;
    const ticketTypeId = r < 4 ? tiers.front : r < 10 ? tiers.middle : tiers.back;
    const rowSeats: { x: number; y: number; theta: number; section: string }[] = [];
    for (const b of bands) {
      const span = deg(b.to - b.from);
      const n = Math.floor((radius * span) / spacing) + 1;
      for (let i = 0; i < n; i++) {
        const theta = deg(b.from) + (n === 1 ? span / 2 : (span * i) / (n - 1));
        rowSeats.push({ x: cx + radius * Math.cos(theta), y: cy + radius * Math.sin(theta), theta, section: b.key });
      }
    }
    // đánh số từ trái sang phải theo hướng nhìn của bản vẽ
    rowSeats.sort((a, b) => a.x - b.x);
    rowSeats.forEach((s, i) => {
      seats.push({
        label: `${rowLabel}${i + 1}`,
        row: rowLabel,
        section: s.section,
        ticketTypeId,
        x: round2(s.x),
        y: round2(s.y),
        rotation: round2((s.theta * 180) / Math.PI - 90),
        // hai ghế đầu/cuối hàng sau cùng dành cho người khuyết tật (gần lối vào)
        accessible: r === rows - 1 && (i === 0 || i === rowSeats.length - 1),
        blocked: false,
      });
    });
  }

  return {
    width: 1200,
    height: Math.ceil(cy + 200 + 34 * (rows - 1) + 80),
    seatSize,
    sections: [
      { key: 'trai', name: 'Khu trái', color: '#4C78A8' },
      { key: 'giua', name: 'Khu giữa', color: '#F58518' },
      { key: 'phai', name: 'Khu phải', color: '#54A24B' },
    ],
    seats,
    decorations: [
      { type: 'stage', x: 400, y: 0, width: 400, height: 60, label: 'SÂN KHẤU' },
      { type: 'label', x: 600, y: cy + 200 + 34 * (rows - 1) + 60, text: 'Lối vào' },
    ],
  };
}
