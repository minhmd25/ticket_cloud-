// Dữ liệu cho backend giả. Chỉ dùng khi VITE_USE_MOCK=true, để chạy demo và kiểm thử
// giao diện khi không có backend thật. Cấu trúc bám theo bảng của cloud-backend.
import type { EventStatus, OrderStatus, QueueStatus, Role, SeatDecoration, SeatSection, Seating } from '../types';
import { vnDateTime } from '../../lib/dates';
import { buildGridLayout, buildTheaterLayout, type SeatLayout } from '../../lib/seatLayouts';

export interface DbUser {
  id: string;
  username: string;
  password: string;
  role: Role;
}

export interface DbEvent {
  id: string;
  title: string;
  category: string;
  description: string;
  venue: string;
  startTime: string;
  endTime: string;
  status: EventStatus;
  imageUrl: string | null;
  createdAt: string;
}

export interface DbTicketType {
  id: string;
  eventId: string;
  name: string;
  description: string;
  price: number;
  seating: Seating;
  totalQuantity: number;
  availableQuantity: number;
}

export interface DbOrder {
  id: string;
  userId: string;
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  unitPrice: number;
  status: OrderStatus;
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  idempotencyKey: string | null;
  /** Ghế của đơn (vé chọn ghế). Đơn đã hủy vẫn giữ danh sách, ghế được trả lại để bán tiếp. */
  seatIds: string[];
}

/** Bản ghi đặt/hủy, tương ứng thông điệp gửi sang Azure để thống kê. */
export interface DbActivity {
  id: string;
  type: 'BOOKED' | 'CANCELLED';
  orderId: string;
  eventId: string;
  quantity: number;
  amount: number;
  at: string;
}

export interface DbSeat {
  id: string;
  label: string;
  row: string | null;
  section: string | null;
  ticketTypeId: string;
  x: number;
  y: number;
  rotation: number;
  accessible: boolean;
  blocked: boolean;
}

export interface DbSeatMap {
  eventId: string;
  version: number;
  width: number;
  height: number;
  seatSize: number;
  sections: SeatSection[];
  decorations: SeatDecoration[];
  seats: DbSeat[];
  updatedAt: string;
}

export interface DbQueueSettings {
  eventId: string;
  enabled: boolean;
  saleStartAt: string;
  maxActive: number;
  accessMinutes: number;
  randomizedAt: string | null;
  lastPosition: number;
  updatedAt: string;
}

export interface DbQueueEntry {
  eventId: string;
  userId: string;
  status: QueueStatus;
  position: number | null;
  joinedAt: string;
  lastSeenAt: string;
  admittedAt: string | null;
  expiresAt: string | null;
  finishedAt: string | null;
}

export interface DbSession {
  token: string;
  userId: string;
  expiresAt: string;
}

export interface MockDb {
  version: 3;
  users: DbUser[];
  events: DbEvent[];
  ticketTypes: DbTicketType[];
  orders: DbOrder[];
  activities: DbActivity[];
  sessions: DbSession[];
  seatMaps: DbSeatMap[];
  queueSettings: DbQueueSettings[];
  queueEntries: DbQueueEntry[];
}

/** Quy tắc nghiệp vụ giống cấu hình mặc định của backend. */
export const RULES = {
  cancellationDeadlineHours: 24,
  maxTicketsPerOrder: 10,
  /** Người đang chờ không hỏi lại quá số giây này thì mất lượt (QUEUE_STALE_SECONDS). */
  queueStaleSeconds: 120,
};

/**
 * Người xếp hàng giả trong dữ liệu mẫu (không phải tài khoản đăng nhập được), để trang chờ có
 * người phía trước. Họ luôn "đang mở trang" và mua xong sau vài chục giây kể từ lúc tới lượt.
 */
export const DEMO_QUEUE_PREFIX = 'demo-';
export const DEMO_QUEUE_PURCHASE_SECONDS = 20;

/** Mật khẩu tài khoản mẫu, trùng với `npm run seed:accounts -- --demo` của backend. */
export const DEMO_PASSWORDS = { customer: 'DemoCustomer2026!', admin: 'DemoAdmin2026!' };

const STORAGE_KEY = 'nhom5.mockdb.v3';

// Bộ sinh số ngẫu nhiên có hạt giống, để dữ liệu mẫu giống nhau mỗi lần tạo.
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** UUID v4 từ một bộ sinh số ngẫu nhiên. */
export function makeUuid(rand: () => number = Math.random): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
  const variant = ['8', '9', 'a', 'b'][Math.floor(rand() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

export function createSeedDb(now = new Date()): MockDb {
  const nowMs = now.getTime();
  const users: DbUser[] = [
    { id: 'alice', username: 'alice', password: DEMO_PASSWORDS.customer, role: 'customer' },
    { id: 'bob', username: 'bob', password: DEMO_PASSWORDS.customer, role: 'customer' },
    { id: 'carol', username: 'carol', password: DEMO_PASSWORDS.customer, role: 'customer' },
    { id: 'admin1', username: 'admin1', password: DEMO_PASSWORDS.admin, role: 'admin' },
  ];

  const at = (days: number, h: number, m = 0) => vnDateTime(days, h, m, now);
  const plusHours = (iso: string, hours: number) => new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
  const created = new Date(nowMs - 20 * 86_400_000).toISOString();

  const ev = (
    id: string,
    title: string,
    category: string,
    startTime: string,
    hours: number,
    venue: string,
    description: string,
    status: EventStatus = 'PUBLISHED',
  ): DbEvent => ({
    id,
    title,
    category,
    description,
    venue,
    startTime,
    endTime: plusHours(startTime, hours),
    status,
    imageUrl: null,
    createdAt: created,
  });

  const soon = new Date(nowMs + 10 * 3_600_000);
  soon.setUTCMinutes(0, 0, 0);

  const events: DbEvent[] = [
    ev('ev-101', 'Đêm nhạc Mùa Thu Hà Nội', 'concert', at(10, 20), 2.5, 'Cung Văn hóa Hữu nghị Việt Xô, Hà Nội',
      'Đêm nhạc acoustic với những ca khúc về Hà Nội mùa thu. Chương trình kéo dài khoảng 150 phút, có phần giao lưu cùng nghệ sĩ.'),
    ev('ev-102', 'Siêu cúp bóng đá Thủ đô 2026', 'sport', at(14, 19, 15), 2, 'Sân vận động Quốc gia Mỹ Đình, Hà Nội',
      'Trận tranh Siêu cúp giữa đội vô địch giải quốc gia và đội đoạt cúp quốc gia. Mở cửa sân lúc 17:30.'),
    ev('ev-103', 'Nhạc kịch: Chuyện tình sông Hương', 'musical', at(21, 19, 30), 2.5, 'Nhà hát Lớn Hà Nội',
      'Vở nhạc kịch hai màn lấy cảm hứng từ cố đô Huế, kết hợp ca Huế và dàn nhạc giao hưởng.'),
    ev('ev-104', 'Live concert Mùa Hè Rực Rỡ', 'concert', at(30, 19), 4, 'Nhà thi đấu Phú Thọ, TP. Hồ Chí Minh',
      'Đại nhạc hội ngoài trời với 8 nghệ sĩ khách mời. Vé VIP gồm khu vực đứng sát sân khấu và quà tặng.'),
    ev('ev-105', 'Giải chạy Marathon Hồ Tây', 'sport', at(7, 5, 30), 6, 'Công viên Hồ Tây, Hà Nội',
      'Giải chạy quanh Hồ Tây với hai cự ly 21 km và 42 km. Vận động viên nhận áo, số đeo và huy chương hoàn thành.'),
    ev('ev-106', 'Kịch: Hồn Trương Ba, da hàng thịt', 'theater', soon.toISOString(), 3, 'Nhà hát Tuổi Trẻ, Hà Nội',
      'Vở kịch kinh điển của Lưu Quang Vũ. Diễn trong vòng 24 giờ tới nên đơn đã đặt không còn được hủy.'),
    ev('ev-107', 'Lễ hội Ẩm thực đường phố', 'festival', at(40, 17), 5, 'Phố đi bộ Hồ Gươm, Hà Nội',
      'Bản nháp, khách hàng chưa nhìn thấy.', 'DRAFT'),
  ];

  const tt = (
    id: string,
    eventId: string,
    name: string,
    price: number,
    totalQuantity: number,
    seating: Seating = 'GENERAL',
  ): DbTicketType => ({
    id,
    eventId,
    name,
    description: '',
    price,
    seating,
    totalQuantity,
    availableQuantity: totalQuantity,
  });
  const ticketTypes: DbTicketType[] = [
    tt('tt-1011', 'ev-101', 'VIP', 1_500_000, 60),
    tt('tt-1012', 'ev-101', 'Thường', 600_000, 240),
    tt('tt-1021', 'ev-102', 'Khán đài A', 300_000, 500),
    tt('tt-1022', 'ev-102', 'Khán đài B', 200_000, 800),
    tt('tt-1031', 'ev-103', 'Hạng nhất', 1_200_000, 80),
    tt('tt-1032', 'ev-103', 'Hạng hai', 700_000, 120),
    tt('tt-1041', 'ev-104', 'VIP', 1_200_000, 20),
    tt('tt-1042', 'ev-104', 'Vé đứng', 450_000, 400),
    tt('tt-1051', 'ev-105', 'Cự ly 21 km', 500_000, 300),
    tt('tt-1052', 'ev-105', 'Cự ly 42 km', 800_000, 60),
    tt('tt-1061', 'ev-106', 'Ghế thường', 200_000, 100),
    tt('tt-1071', 'ev-107', 'Vé vào cổng', 50_000, 1000),
  ];

  const db: MockDb = {
    version: 3,
    users,
    events,
    ticketTypes,
    orders: [],
    activities: [],
    sessions: [],
    seatMaps: [],
    queueSettings: [],
    queueEntries: [],
  };
  const rand = seededRandom(20261119);
  const customers = users.filter((u) => u.role === 'customer');

  const book = (t: DbTicketType, userId: string, quantity: number, createdAt: string, cancelAfterHours?: number) => {
    const order: DbOrder = {
      id: makeUuid(rand),
      userId,
      eventId: t.eventId,
      ticketTypeId: t.id,
      quantity,
      unitPrice: t.price,
      status: 'CONFIRMED',
      createdAt,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      idempotencyKey: null,
      seatIds: [],
    };
    t.availableQuantity -= quantity;
    db.orders.push(order);
    db.activities.push({
      id: makeUuid(rand),
      type: 'BOOKED',
      orderId: order.id,
      eventId: t.eventId,
      quantity,
      amount: quantity * t.price,
      at: createdAt,
    });
    if (cancelAfterHours !== undefined) {
      const cancelledMs = new Date(createdAt).getTime() + cancelAfterHours * 3_600_000;
      if (cancelledMs < nowMs) {
        order.status = 'CANCELLED';
        order.cancelledAt = new Date(cancelledMs).toISOString();
        order.cancelledBy = userId;
        order.cancelReason = 'Bận việc đột xuất';
        t.availableQuantity += quantity;
        db.activities.push({
          id: makeUuid(rand),
          type: 'CANCELLED',
          orderId: order.id,
          eventId: t.eventId,
          quantity,
          amount: quantity * t.price,
          at: order.cancelledAt,
        });
      }
    }
  };

  // Lịch sử đặt/hủy trong 14 ngày gần nhất để trang thống kê có số liệu.
  const bookable = ticketTypes.filter((t) => t.eventId !== 'ev-107');
  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const count = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      const t = bookable[Math.floor(rand() * bookable.length)];
      const quantity = Math.min(t.availableQuantity, 1 + Math.floor(rand() * 4));
      const userId = customers[Math.floor(rand() * customers.length)].id;
      let createdAt = at(-daysAgo, 8 + Math.floor(rand() * 14), Math.floor(rand() * 60));
      if (new Date(createdAt).getTime() > nowMs) createdAt = new Date(nowMs - (i + 1) * 600_000).toISOString();
      const cancel = rand() < 0.22 ? 1 + Math.floor(rand() * 30) : undefined;
      if (quantity > 0) book(t, userId, quantity, createdAt, cancel);
    }
  }

  // Một hạng vé hết sạch và một hạng chỉ còn 5 vé, rải ra nhiều ngày cho biểu đồ đẹp.
  const fillTo = (ticketTypeId: string, remainingTarget: number) => {
    const t = ticketTypes.find((x) => x.id === ticketTypeId)!;
    let need = t.availableQuantity - remainingTarget;
    for (let daysAgo = 12; need > 0; daysAgo = daysAgo > 2 ? daysAgo - 2 : 12) {
      const quantity = Math.min(need, 2 + Math.floor(rand() * 3));
      const userId = customers[Math.floor(rand() * customers.length)].id;
      book(t, userId, quantity, at(-daysAgo, 9 + Math.floor(rand() * 10), Math.floor(rand() * 60)));
      need -= quantity;
    }
  };
  fillTo('tt-1041', 0);
  fillTo('tt-1052', 5);

  // Đơn của alice cho vở kịch sắp diễn: đã quá hạn hủy.
  book(ticketTypes.find((x) => x.id === 'tt-1061')!, 'alice', 2, new Date(nowMs - 2 * 86_400_000).toISOString());

  addSeatedEvents(db, now, at, plusHours, created, rand);
  return db;
}

/**
 * Hai sự kiện chọn ghế (thêm sau phần sinh lịch sử ở trên nên dữ liệu cũ không đổi):
 *  - ev-108: nhà hát hàng cong 367 ghế, mở bán qua hàng chờ, giống dữ liệu `npm run seed` của backend
 *  - ev-109: ghế thẳng, không có hàng chờ, chọn ghế được ngay
 */
function addSeatedEvents(
  db: MockDb,
  now: Date,
  at: (days: number, h: number, m?: number) => string,
  plusHours: (iso: string, hours: number) => string,
  created: string,
  rand: () => number,
) {
  const nowIso = now.toISOString();
  const event = (id: string, title: string, category: string, startTime: string, hours: number, venue: string, description: string) =>
    db.events.push({ id, title, category, description, venue, startTime, endTime: plusHours(startTime, hours), status: 'PUBLISHED', imageUrl: null, createdAt: created });
  const tier = (id: string, eventId: string, name: string, price: number) => {
    const t: DbTicketType = { id, eventId, name, description: '', price, seating: 'ASSIGNED', totalQuantity: 0, availableQuantity: 0 };
    db.ticketTypes.push(t);
    return t;
  };
  const addMap = (eventId: string, layout: SeatLayout) => {
    const seats = layout.seats.map((s) => ({ ...s, id: makeUuid(rand), row: s.row ?? null, section: s.section ?? null }));
    db.seatMaps.push({ eventId, version: 1, width: layout.width, height: layout.height, seatSize: layout.seatSize ?? 24, sections: layout.sections, decorations: layout.decorations, seats, updatedAt: nowIso });
    for (const t of db.ticketTypes.filter((x) => x.eventId === eventId && x.seating === 'ASSIGNED')) {
      t.totalQuantity = seats.filter((s) => s.ticketTypeId === t.id && !s.blocked).length;
      t.availableQuantity = t.totalQuantity;
    }
    return seats;
  };
  const bookSeats = (eventId: string, userId: string, labels: string[], createdAt: string) => {
    const map = db.seatMaps.find((m) => m.eventId === eventId)!;
    const seats = labels.map((l) => map.seats.find((s) => s.label === l)!);
    const t = db.ticketTypes.find((x) => x.id === seats[0].ticketTypeId)!;
    const order: DbOrder = {
      id: makeUuid(rand), userId, eventId, ticketTypeId: t.id, quantity: seats.length, unitPrice: t.price, status: 'CONFIRMED',
      createdAt, cancelledAt: null, cancelledBy: null, cancelReason: null, idempotencyKey: null, seatIds: seats.map((s) => s.id),
    };
    t.availableQuantity -= seats.length;
    db.orders.push(order);
    db.activities.push({ id: makeUuid(rand), type: 'BOOKED', orderId: order.id, eventId, quantity: seats.length, amount: seats.length * t.price, at: createdAt });
  };
  const ago = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

  // ---- ev-108: nhà hát, có hàng chờ ----
  event('ev-108', 'Nhạc kịch: Những người khốn khổ', 'musical', at(21, 20), 3, 'Nhà hát Hòa Bình, TP. Hồ Chí Minh',
    'Chọn ghế trên sơ đồ nhà hát. Mở bán qua hàng chờ ảo: tới giờ mở bán, những người đã vào hàng được xếp thứ tự ngẫu nhiên.');
  const a = tier('tt-1081', 'ev-108', 'Hạng A', 1_500_000);
  const b = tier('tt-1082', 'ev-108', 'Hạng B', 900_000);
  const c = tier('tt-1083', 'ev-108', 'Hạng C', 400_000);
  addMap('ev-108', buildTheaterLayout([{ ticketTypeId: a.id, rows: 4 }, { ticketTypeId: b.id, rows: 6 }, { ticketTypeId: c.id, rows: 4 }]));
  bookSeats('ev-108', 'alice', ['A3', 'A4'], ago(30));
  bookSeats('ev-108', 'bob', ['E14', 'E15', 'E16'], ago(26));
  bookSeats('ev-108', 'carol', ['K20', 'K21'], ago(20));
  const saleStart = new Date(now.getTime() + 2 * 60_000);
  saleStart.setUTCSeconds(0, 0);
  db.queueSettings.push({ eventId: 'ev-108', enabled: true, saleStartAt: saleStart.toISOString(), maxActive: 2, accessMinutes: 10, randomizedAt: null, lastPosition: 0, updatedAt: nowIso });
  for (let i = 1; i <= 6; i++) {
    db.queueEntries.push({ eventId: 'ev-108', userId: `${DEMO_QUEUE_PREFIX}${i}`, status: 'WAITING', position: null, joinedAt: ago(0.2 - i * 0.01), lastSeenAt: nowIso, admittedAt: null, expiresAt: null, finishedAt: null });
  }

  // ---- ev-109: ghế thẳng, không có hàng chờ ----
  event('ev-109', 'Hòa nhạc thính phòng: Bốn mùa', 'concert', at(12, 20), 2, 'Nhà hát Lớn Hà Nội',
    'Dàn nhạc thính phòng trình diễn bản "Bốn mùa" của Vivaldi. Chọn ghế ngồi ngay trên sơ đồ, không cần xếp hàng.');
  const vip = tier('tt-1091', 'ev-109', 'Hạng nhất', 1_200_000);
  const std = tier('tt-1092', 'ev-109', 'Hạng hai', 600_000);
  addMap('ev-109', buildGridLayout([{ ticketTypeId: vip.id, rows: 3 }, { ticketTypeId: std.id, rows: 5 }], 16));
  bookSeats('ev-109', 'bob', ['A7', 'A8'], ago(50));
  bookSeats('ev-109', 'carol', ['B9', 'B10', 'B11'], ago(40));
  bookSeats('ev-109', 'bob', ['E3', 'E4'], ago(10));
  bookSeats('ev-109', 'carol', ['F12'], ago(5));
}

let memoryDb: MockDb | null = null;
let memoryRaw: string | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Đọc dữ liệu giả. Nhiều tab dùng chung localStorage (ví dụ hai khách cùng xếp hàng), nên mỗi lần
 * đọc đều so với bản trong localStorage và nạp lại nếu tab khác vừa ghi.
 */
export function loadDb(): MockDb {
  const raw = readRaw();
  if (memoryDb && (raw === null || raw === memoryRaw)) return memoryDb;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as MockDb;
      if (parsed?.version === 3) {
        memoryDb = parsed;
        memoryRaw = raw;
        return memoryDb;
      }
    } catch {
      // dữ liệu hỏng hoặc không đọc được: tạo lại
    }
  }
  memoryDb = createSeedDb();
  saveDb(memoryDb);
  return memoryDb;
}

export function saveDb(db: MockDb): void {
  memoryDb = db;
  try {
    memoryRaw = JSON.stringify(db);
    localStorage.setItem(STORAGE_KEY, memoryRaw);
  } catch {
    memoryRaw = null; // chỉ giữ trong bộ nhớ
  }
}

export function resetMockDb(): void {
  memoryDb = createSeedDb();
  saveDb(memoryDb);
}
