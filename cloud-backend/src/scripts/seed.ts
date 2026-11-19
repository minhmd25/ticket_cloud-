import { config } from '../config';
import { createPool } from '../db';
import { EventService } from '../events/service';
import { eventCreateSchema } from '../events/schemas';
import { OrderService } from '../orders/service';
import { QueueService } from '../queue/service';
import { SeatMapService } from '../seating/service';
import { buildTheaterLayout } from '../seating/theater';
import { migrate } from './migrate';

/**
 * Khởi tạo dữ liệu mẫu.
 *   npm run seed            -> chỉ seed nếu DB chưa có sự kiện nào
 *   npm run seed -- --reset -> XÓA toàn bộ dữ liệu sự kiện/đơn/outbox rồi seed lại
 */
const DAY = 24 * 3600_000;
const at = (days: number, hour = 19) => {
  const d = new Date(Date.now() + days * DAY);
  d.setUTCHours(hour - 7, 0, 0, 0); // giờ Việt Nam
  return d.toISOString();
};

const SAMPLE_EVENTS = [
  {
    title: 'Đêm nhạc Mùa Đông 2026',
    description: 'Đêm nhạc acoustic ngoài trời với các nghệ sĩ trẻ.',
    category: 'concert',
    venue: 'Nhà hát Lớn Hà Nội',
    startTime: at(30),
    endTime: at(30, 22),
    status: 'PUBLISHED',
    ticketTypes: [
      { name: 'Thường', price: 350000, totalQuantity: 300 },
      { name: 'VIP', price: 1200000, totalQuantity: 50 },
      { name: 'VVIP - Hàng đầu', price: 3000000, totalQuantity: 1 }, // demo "vé cuối"
    ],
  },
  {
    title: 'Chung kết Giải bóng đá Sinh viên',
    description: 'Trận chung kết giải bóng đá sinh viên toàn quốc.',
    category: 'sport',
    venue: 'Sân vận động Mỹ Đình',
    startTime: at(14, 18),
    endTime: at(14, 21),
    status: 'PUBLISHED',
    ticketTypes: [
      { name: 'Khán đài A', price: 150000, totalQuantity: 2000 },
      { name: 'Khán đài B', price: 100000, totalQuantity: 3000 },
    ],
  },
  {
    title: 'Hội thảo Cloud Native Việt Nam',
    description: 'Kubernetes, serverless, kiến trúc đa đám mây GCP + Azure.',
    category: 'conference',
    venue: 'Trung tâm Hội nghị Quốc gia',
    startTime: at(45, 8),
    endTime: at(45, 17),
    status: 'PUBLISHED',
    ticketTypes: [
      { name: 'Sinh viên', price: 0, totalQuantity: 200 },
      { name: 'Tiêu chuẩn', price: 500000, totalQuantity: 300 },
    ],
  },
  {
    title: 'Kịch: Hồn Trương Ba, da hàng thịt',
    description: 'Vở kịch kinh điển của Lưu Quang Vũ. (Diễn sau 12 giờ nữa - dùng để thử quy tắc hạn hủy.)',
    category: 'theater',
    venue: 'Nhà hát Tuổi Trẻ',
    startTime: new Date(Date.now() + 12 * 3600_000).toISOString(),
    endTime: new Date(Date.now() + 15 * 3600_000).toISOString(),
    status: 'PUBLISHED',
    ticketTypes: [{ name: 'Ghế thường', price: 200000, totalQuantity: 100 }],
  },
  {
    title: 'Lễ hội Ẩm thực đường phố (bản nháp)',
    description: 'Sự kiện đang soạn, chưa mở bán - khách không thấy.',
    category: 'festival',
    venue: 'Phố đi bộ Hồ Gươm',
    startTime: at(60, 10),
    endTime: at(62, 22),
    status: 'DRAFT',
    ticketTypes: [{ name: 'Vé vào cổng', price: 50000, totalQuantity: 1000 }],
  },
];

async function main() {
  const reset = process.argv.includes('--reset');
  await migrate(config.databaseUrl);
  const db = createPool();
  try {
    if (reset) {
      await db.query('TRUNCATE outbox_events, orders, ticket_types, events RESTART IDENTITY CASCADE');
      console.log('[seed] đã xóa dữ liệu cũ');
    } else {
      const n = (await db.query('SELECT count(*)::int AS n FROM events')).rows[0].n;
      if (n > 0) {
        console.log(`[seed] DB đã có ${n} sự kiện, bỏ qua. Dùng "npm run seed -- --reset" để làm lại.`);
        return;
      }
    }

    const events = new EventService(db);
    const created = [];
    for (const e of SAMPLE_EVENTS) created.push(await events.create(eventCreateSchema.parse(e), 'seed-admin'));
    console.log(`[seed] tạo ${created.length} sự kiện`);

    // vài đơn mẫu (qua service thật => có outbox)
    const orders = new OrderService(db, config.rules);
    const concert = created[0];
    const football = created[1];
    await orders.create({ userId: 'alice', role: 'customer' }, { ticketTypeId: concert.ticketTypes[0].id, quantity: 2 });
    await orders.create({ userId: 'bob', role: 'customer' }, { ticketTypeId: concert.ticketTypes[1].id, quantity: 1 });
    const o = await orders.create({ userId: 'alice', role: 'customer' }, { ticketTypeId: football.ticketTypes[0].id, quantity: 4 });
    await orders.cancel({ userId: 'alice', role: 'customer' }, o.order.id, 'Bận việc đột xuất');
    console.log('[seed] tạo 3 đơn mẫu (1 đơn đã hủy)');

    // nhà hát có sơ đồ ghế cong + hàng chờ ảo
    const theater = await events.create(
      eventCreateSchema.parse({
        title: 'Nhạc kịch: Những người khốn khổ (có sơ đồ ghế)',
        description: 'Chọn ghế trên sơ đồ nhà hát. Mở bán qua hàng chờ ảo: tới giờ mở bán, người vào trước được xếp ngẫu nhiên.',
        category: 'theater',
        venue: 'Nhà hát Hòa Bình',
        startTime: at(21, 20),
        endTime: at(21, 23),
        status: 'PUBLISHED',
        ticketTypes: [
          { name: 'Hạng A', price: 1500000, seating: 'ASSIGNED' },
          { name: 'Hạng B', price: 800000, seating: 'ASSIGNED' },
          { name: 'Hạng C', price: 400000, seating: 'ASSIGNED' },
        ],
      }),
      'seed-admin',
    );
    const tier = (name: string) => theater.ticketTypes.find((t) => t.name === name)!.id;
    const seatMaps = new SeatMapService(db);
    const map = await seatMaps.save(
      theater.id,
      { version: 0, ...buildTheaterLayout({ front: tier('Hạng A'), middle: tier('Hạng B'), back: tier('Hạng C') }) },
      'seed-admin',
    );
    const pick = (...labels: string[]) => labels.map((l) => map.seats.find((s) => s.label === l)!.id);
    await orders.create({ userId: 'alice', role: 'customer' }, { ticketTypeId: tier('Hạng A'), quantity: 2, seatIds: pick('A3', 'A4') });
    await new QueueService(db, config.queue).putSettings(
      theater.id,
      { enabled: true, saleStartAt: new Date(Date.now() + 5 * 60_000), maxActive: 2, accessMinutes: 10 },
      'seed-admin',
    );
    created.push(await events.getById(theater.id, false));
    console.log(`[seed] nhà hát: ${map.seats.length} ghế, alice đã đặt A3 + A4; hàng chờ mở bán sau 5 phút, 2 người mua cùng lúc`);

    if (config.auth.mode === 'mock') {
      console.log('\nTài khoản mock (AUTH_MODE=mock) - dùng header Authorization:');
      console.log('  Khách : Bearer mock:alice:customer   |  Bearer mock:bob:customer');
      console.log('  Admin : Bearer mock:admin1:admin');
    }
    console.log('\nSự kiện:');
    for (const e of created) console.log(`  ${e.id}  [${e.status}] ${e.title}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
