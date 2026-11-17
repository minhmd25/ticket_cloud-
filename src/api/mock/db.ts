// Dữ liệu cho backend giả. Chỉ dùng khi VITE_USE_MOCK=true để frontend làm song song với backend.
import type { EventCategory, OrderStatus, Role } from '../types';
import { vnDateTime } from '../../lib/dates';

export interface DbUser {
  id: string;
  username: string;
  password: string;
  role: Role;
  fullName: string;
}

export interface DbEvent {
  id: string;
  name: string;
  category: EventCategory;
  description: string;
  startTime: string;
  venue: string;
}

export interface DbTicketType {
  id: string;
  eventId: string;
  name: string;
  price: number;
  totalQuantity: number;
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
}

/** Bản ghi đặt/hủy, tương ứng thông điệp gửi sang Azure để thống kê. */
export interface DbActivity {
  id: string;
  type: 'BOOKED' | 'CANCELLED';
  orderId: string;
  eventId: string;
  ticketTypeId: string;
  quantity: number;
  at: string;
}

export interface DbSession {
  token: string;
  userId: string;
  expiresAt: string;
}

export interface MockDb {
  version: 1;
  seq: number;
  users: DbUser[];
  events: DbEvent[];
  ticketTypes: DbTicketType[];
  orders: DbOrder[];
  activities: DbActivity[];
  sessions: DbSession[];
}

const STORAGE_KEY = 'nhom5.mockdb.v1';

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

/** Số vé đang được giữ bởi các đơn còn hiệu lực. */
export function heldQuantity(db: MockDb, ticketTypeId: string): number {
  return db.orders
    .filter((o) => o.ticketTypeId === ticketTypeId && o.status === 'CONFIRMED')
    .reduce((sum, o) => sum + o.quantity, 0);
}

export function createSeedDb(now = new Date()): MockDb {
  const users: DbUser[] = [
    { id: 'u1', username: 'khach', password: 'khach123', role: 'customer', fullName: 'Nguyễn Văn An' },
    { id: 'u2', username: 'admin', password: 'admin123', role: 'admin', fullName: 'Quản trị viên' },
    { id: 'u3', username: 'khach2', password: 'khach123', role: 'customer', fullName: 'Trần Thị Bình' },
    { id: 'u4', username: 'khach3', password: 'khach123', role: 'customer', fullName: 'Lê Minh Châu' },
  ];

  const at = (days: number, h: number, m = 0) => vnDateTime(days, h, m, now);

  const events: DbEvent[] = [
    {
      id: 'ev-101',
      name: 'Đêm nhạc Mùa Thu Hà Nội',
      category: 'concert',
      description:
        'Đêm nhạc acoustic với những ca khúc về Hà Nội mùa thu. Chương trình kéo dài khoảng 150 phút, có phần giao lưu cùng nghệ sĩ.',
      startTime: at(10, 20),
      venue: 'Cung Văn hóa Hữu nghị Việt Xô, Hà Nội',
    },
    {
      id: 'ev-102',
      name: 'Siêu cúp bóng đá Thủ đô 2026',
      category: 'sports',
      description: 'Trận tranh Siêu cúp giữa đội vô địch giải quốc gia và đội đoạt cúp quốc gia. Mở cửa sân lúc 17:30.',
      startTime: at(14, 19, 15),
      venue: 'Sân vận động Quốc gia Mỹ Đình, Hà Nội',
    },
    {
      id: 'ev-103',
      name: 'Nhạc kịch: Chuyện tình sông Hương',
      category: 'musical',
      description: 'Vở nhạc kịch hai màn lấy cảm hứng từ cố đô Huế, kết hợp ca Huế và dàn nhạc giao hưởng.',
      startTime: at(21, 19, 30),
      venue: 'Nhà hát Lớn Hà Nội',
    },
    {
      id: 'ev-104',
      name: 'Live concert Mùa Hè Rực Rỡ',
      category: 'concert',
      description: 'Đại nhạc hội ngoài trời với 8 nghệ sĩ khách mời. Vé VIP gồm khu vực đứng sát sân khấu và quà tặng.',
      startTime: at(30, 19),
      venue: 'Nhà thi đấu Phú Thọ, TP. Hồ Chí Minh',
    },
    {
      id: 'ev-105',
      name: 'Giải chạy Marathon Hồ Tây',
      category: 'sports',
      description: 'Giải chạy quanh Hồ Tây với hai cự ly 21 km và 42 km. Vận động viên nhận áo, số đeo và huy chương hoàn thành.',
      startTime: at(7, 5, 30),
      venue: 'Công viên Hồ Tây, Hà Nội',
    },
    {
      id: 'ev-106',
      name: 'Nhạc kịch thiếu nhi: Cô bé quàng khăn đỏ',
      category: 'musical',
      description: 'Nhạc kịch dành cho thiếu nhi từ 4 tuổi, thời lượng 75 phút, không nghỉ giữa giờ.',
      startTime: at(5, 9),
      venue: 'Nhà hát Tuổi Trẻ, Hà Nội',
    },
  ];

  const ticketTypes: DbTicketType[] = [
    { id: 'tt-1011', eventId: 'ev-101', name: 'VIP', price: 1_500_000, totalQuantity: 60 },
    { id: 'tt-1012', eventId: 'ev-101', name: 'Thường', price: 600_000, totalQuantity: 240 },
    { id: 'tt-1021', eventId: 'ev-102', name: 'Khán đài A', price: 300_000, totalQuantity: 500 },
    { id: 'tt-1022', eventId: 'ev-102', name: 'Khán đài B', price: 200_000, totalQuantity: 800 },
    { id: 'tt-1031', eventId: 'ev-103', name: 'Hạng nhất', price: 1_200_000, totalQuantity: 80 },
    { id: 'tt-1032', eventId: 'ev-103', name: 'Hạng hai', price: 700_000, totalQuantity: 120 },
    { id: 'tt-1041', eventId: 'ev-104', name: 'VIP', price: 1_200_000, totalQuantity: 20 },
    { id: 'tt-1042', eventId: 'ev-104', name: 'Vé đứng', price: 450_000, totalQuantity: 400 },
    { id: 'tt-1051', eventId: 'ev-105', name: 'Cự ly 21 km', price: 500_000, totalQuantity: 300 },
    { id: 'tt-1052', eventId: 'ev-105', name: 'Cự ly 42 km', price: 800_000, totalQuantity: 60 },
    { id: 'tt-1061', eventId: 'ev-106', name: 'Vé tiêu chuẩn', price: 250_000, totalQuantity: 150 },
  ];

  const db: MockDb = { version: 1, seq: 1000, users, events, ticketTypes, orders: [], activities: [], sessions: [] };
  const rand = seededRandom(20261119);
  const customers = users.filter((u) => u.role === 'customer');
  const nowMs = now.getTime();

  const book = (tt: DbTicketType, userId: string, quantity: number, createdAt: string, cancelAfterHours?: number) => {
    const id = `DH${++db.seq}`;
    const order: DbOrder = {
      id,
      userId,
      eventId: tt.eventId,
      ticketTypeId: tt.id,
      quantity,
      unitPrice: tt.price,
      status: 'CONFIRMED',
      createdAt,
      cancelledAt: null,
    };
    db.orders.push(order);
    db.activities.push({ id: `A-${id}-B`, type: 'BOOKED', orderId: id, eventId: tt.eventId, ticketTypeId: tt.id, quantity, at: createdAt });
    if (cancelAfterHours !== undefined) {
      const cancelledMs = new Date(createdAt).getTime() + cancelAfterHours * 3_600_000;
      if (cancelledMs < nowMs) {
        order.status = 'CANCELLED';
        order.cancelledAt = new Date(cancelledMs).toISOString();
        db.activities.push({
          id: `A-${id}-C`,
          type: 'CANCELLED',
          orderId: id,
          eventId: tt.eventId,
          ticketTypeId: tt.id,
          quantity,
          at: order.cancelledAt,
        });
      }
    }
  };

  // Lịch sử đặt/hủy trong 14 ngày gần nhất để dashboard có số liệu.
  for (let daysAgo = 13; daysAgo >= 0; daysAgo--) {
    const count = 3 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      const tt = ticketTypes[Math.floor(rand() * ticketTypes.length)];
      const remaining = tt.totalQuantity - heldQuantity(db, tt.id);
      const quantity = Math.min(remaining, 1 + Math.floor(rand() * 4));
      const userId = customers[Math.floor(rand() * customers.length)].id;
      let createdAt = at(-daysAgo, 8 + Math.floor(rand() * 14), Math.floor(rand() * 60));
      if (new Date(createdAt).getTime() > nowMs) createdAt = new Date(nowMs - (i + 1) * 600_000).toISOString();
      const cancel = rand() < 0.22 ? 1 + Math.floor(rand() * 30) : undefined;
      if (quantity > 0) book(tt, userId, quantity, createdAt, cancel);
    }
  }

  // Một hạng vé hết sạch và một hạng gần hết, để thử các trường hợp hết vé.
  // Rải các đơn bù ra nhiều ngày để biểu đồ thống kê không bị dồn vào một ngày.
  const fillTo = (ticketTypeId: string, remainingTarget: number) => {
    const tt = ticketTypes.find((t) => t.id === ticketTypeId)!;
    let need = tt.totalQuantity - heldQuantity(db, tt.id) - remainingTarget;
    for (let daysAgo = 12; need > 0; daysAgo = daysAgo > 2 ? daysAgo - 2 : 12) {
      const quantity = Math.min(need, 2 + Math.floor(rand() * 3));
      const userId = customers[Math.floor(rand() * customers.length)].id;
      book(tt, userId, quantity, at(-daysAgo, 9 + Math.floor(rand() * 10), Math.floor(rand() * 60)));
      need -= quantity;
    }
  };
  fillTo('tt-1041', 0);
  fillTo('tt-1052', 5);

  return db;
}

let memoryDb: MockDb | null = null;

export function loadDb(): MockDb {
  if (memoryDb) return memoryDb;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as MockDb;
      if (parsed?.version === 1) {
        memoryDb = parsed;
        return memoryDb;
      }
    }
  } catch {
    // dữ liệu hỏng hoặc không đọc được: tạo lại
  }
  memoryDb = createSeedDb();
  saveDb(memoryDb);
  return memoryDb;
}

export function saveDb(db: MockDb): void {
  memoryDb = db;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // chỉ giữ trong bộ nhớ
  }
}

export function resetMockDb(): void {
  memoryDb = createSeedDb();
  saveDb(memoryDb);
}
