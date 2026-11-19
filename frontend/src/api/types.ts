// Kiểu dữ liệu theo API của backend chung (cloud-backend/docs/API.md).

export type Role = 'customer' | 'admin';

export interface User {
  id: string; // userId do backend cấp
  username: string;
  role: Role;
}

export interface LoginResponse {
  token: string;
  expiresIn?: number;
  user: User;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

export interface PageQuery {
  page?: number;
  limit?: number;
}

export type EventStatus = 'DRAFT' | 'PUBLISHED' | 'CANCELLED';

export interface EventBase {
  id: string;
  title: string;
  description: string;
  category: string; // chữ thường không dấu: concert, sport, musical, ...
  venue: string;
  startTime: string; // ISO 8601
  endTime: string;
  status: EventStatus;
  imageUrl: string | null;
}

export interface EventSummary extends EventBase {
  minPrice: number | null;
  maxPrice: number | null;
  totalAvailable: number;
}

/** GENERAL: bán theo số lượng. ASSIGNED: khách chọn ghế trên sơ đồ. */
export type Seating = 'GENERAL' | 'ASSIGNED';

export interface TicketType {
  id: string;
  eventId: string;
  name: string;
  description: string;
  price: number; // VND
  seating: Seating;
  totalQuantity: number; // số vé mở bán (hạng ASSIGNED: số ghế không bị khóa)
  availableQuantity: number; // số vé còn lại
  reservedQuantity: number; // số vé đang được giữ trong đơn CONFIRMED
  soldOut: boolean;
}

/** Cấu hình hàng chờ công khai trong chi tiết sự kiện. */
export interface EventQueueInfo {
  enabled: boolean;
  saleStartAt: string;
  maxActive: number;
  accessMinutes: number;
}

export interface EventDetail extends EventBase {
  ticketTypes: TicketType[];
  /** null nếu sự kiện chưa có sơ đồ ghế. */
  seatMap: { version: number } | null;
  /** null nếu sự kiện không dùng hàng chờ. */
  queue: EventQueueInfo | null;
  /** Chỉ có khi admin sửa sự kiện: số đơn vừa bị hủy theo sự kiện. */
  cancelledOrders?: number;
}

export interface CategoryCount {
  category: string;
  eventCount: number;
}

export interface EventListQuery extends PageQuery {
  category?: string;
  q?: string;
  includePast?: boolean;
}

export interface AdminEventListQuery extends EventListQuery {
  status?: EventStatus;
}

export interface EventInput {
  title: string;
  category: string;
  description: string;
  venue: string;
  startTime: string;
  endTime: string;
  status: 'DRAFT' | 'PUBLISHED';
}

export type EventPatch = Partial<Omit<EventInput, 'status'>> & { status?: EventStatus; cancelReason?: string };

export interface TicketTypeInput {
  name: string;
  price: number;
  /** Bỏ trống (hoặc 0) với hạng ASSIGNED: số vé tính theo sơ đồ ghế. */
  totalQuantity?: number;
  seating?: Seating;
  description?: string;
}

export type OrderStatus = 'CONFIRMED' | 'CANCELLED';

export interface Order {
  id: string; // mã đơn (UUID)
  userId: string;
  status: OrderStatus;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  currency: string;
  event: {
    id: string;
    title: string;
    category: string;
    venue: string;
    startTime: string;
    status: EventStatus;
  };
  ticketType: { id: string; name: string };
  /** Ghế của đơn, [] với vé thường. Đơn đã hủy vẫn giữ danh sách để xem lại. */
  seats: Array<{ id: string; label: string }>;
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  cancellationDeadline: string;
  canCancel: boolean;
}

/** Vé thường gửi `quantity`, vé chọn ghế gửi `seatIds` (mỗi đơn một hạng vé). */
export interface CreateOrderInput {
  ticketTypeId: string;
  quantity?: number;
  seatIds?: string[];
}

export interface MyOrdersQuery extends PageQuery {
  status?: OrderStatus;
}

export interface AdminOrdersQuery extends PageQuery {
  eventId?: string;
  status?: OrderStatus;
}

export interface OrderSummary {
  orders: number;
  tickets: number;
  amount: number;
}

export interface AdminOrderPage extends Page<Order> {
  summary: Partial<Record<OrderStatus, OrderSummary>>;
}

export interface StatsCounts {
  bookedTickets: number;
  cancelledTickets: number;
  bookedOrders: number;
  cancelledOrders: number;
  netTickets: number;
  bookedRevenue: number;
  cancelledRevenue: number;
  netRevenue: number;
}

export interface StatsItem extends StatsCounts {
  key: string; // ngày YYYY-MM-DD hoặc mã sự kiện
  eventTitle?: string | null;
}

export type StatsGroupBy = 'day' | 'event';

export interface StatsQuery {
  from: string; // YYYY-MM-DD (giờ Việt Nam), tính cả ngày này
  to: string;
}

export interface StatsResponse {
  source: string;
  stale: boolean; // true: Azure lỗi, đang trả số liệu lưu tạm
  fetchedAt: string;
  query: { groupBy: StatsGroupBy; from: string; to: string };
  items: StatsItem[];
  totals: StatsCounts;
  notes?: { tickets?: string; revenue?: string };
}

// ---------- Sơ đồ ghế (API.md mục 5) ----------

export interface SeatSection {
  key: string;
  name: string;
  color?: string | null;
}

/** Hình trang trí do admin đặt. Frontend vẽ `stage` (khối chữ nhật) và `label` (chữ). */
export interface SeatDecoration {
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  text?: string;
  [key: string]: unknown;
}

export interface Seat {
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

export interface SeatMap {
  eventId: string;
  version: number;
  width: number;
  height: number;
  seatSize: number;
  sections: SeatSection[];
  decorations: SeatDecoration[];
  seats: Seat[];
  updatedAt: string;
}

export interface SeatStatus {
  eventId: string;
  version: number;
  sold: string[];
  blocked: string[];
}

/** Body của PUT /admin/events/:id/seat-map (ghế chưa có id). */
export interface SeatMapInput {
  version: number;
  width: number;
  height: number;
  seatSize?: number;
  sections: SeatSection[];
  seats: Array<Omit<Seat, 'id'>>;
  decorations: SeatDecoration[];
}

// ---------- Hàng chờ ảo (API.md mục 6) ----------

export type QueueStatus = 'WAITING' | 'ADMITTED' | 'COMPLETED' | 'EXPIRED' | 'LEFT';

export interface QueueEntry {
  eventId: string;
  status: QueueStatus;
  queueEnabled: boolean;
  position: number | null;
  aheadOfYou: number | null;
  waitingCount: number;
  saleStartAt: string;
  saleStarted: boolean;
  admittedAt: string | null;
  expiresAt: string | null;
  /** null: ngừng hỏi lại. */
  retryAfterSeconds: number | null;
  serverTime: string;
}

export interface QueueSettingsInput {
  enabled: boolean;
  saleStartAt: string;
  maxActive: number;
  accessMinutes: number;
}

export interface QueueSettings extends QueueSettingsInput {
  eventId: string;
  randomizedAt: string | null;
  counts: Partial<Record<QueueStatus, number>>;
  updatedAt: string;
}

export interface QueueTickResult {
  tick: { events: number; admitted: number; expired: number; dropped: number };
  settings: QueueSettings;
}
