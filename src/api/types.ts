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

export interface TicketType {
  id: string;
  eventId: string;
  name: string;
  description: string;
  price: number; // VND
  totalQuantity: number; // số vé mở bán
  availableQuantity: number; // số vé còn lại
  reservedQuantity: number; // số vé đang được giữ trong đơn CONFIRMED
  soldOut: boolean;
}

export interface EventDetail extends EventBase {
  ticketTypes: TicketType[];
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
  totalQuantity: number;
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
  createdAt: string;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  cancellationDeadline: string;
  canCancel: boolean;
}

export interface CreateOrderInput {
  ticketTypeId: string;
  quantity: number;
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
