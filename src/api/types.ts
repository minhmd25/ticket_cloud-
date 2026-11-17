// Kiểu dữ liệu theo hợp đồng API trong docs/API-CONTRACT.md.

export type Role = 'customer' | 'admin';

export interface User {
  id: string;
  username: string;
  role: Role;
  fullName?: string;
}

export interface LoginResponse {
  token: string;
  user: User;
}

export type EventCategory = 'concert' | 'sports' | 'musical';

export interface EventSummary {
  id: string;
  name: string;
  category: EventCategory;
  startTime: string; // ISO 8601
  venue: string;
}

export interface TicketType {
  id: string;
  eventId: string;
  name: string;
  price: number; // VND
  totalQuantity: number; // số vé mở bán
  remainingQuantity: number; // số vé còn lại
}

export interface EventDetail extends EventSummary {
  description: string;
  ticketTypes: TicketType[];
}

export interface EventInput {
  name: string;
  category: EventCategory;
  description: string;
  startTime: string;
  venue: string;
}

export interface TicketTypeInput {
  name: string;
  price: number;
  totalQuantity: number;
}

export type OrderStatus = 'CONFIRMED' | 'CANCELLED';

export interface Order {
  id: string; // mã đơn
  eventId: string;
  eventName: string;
  eventStartTime: string;
  ticketTypeId: string;
  ticketTypeName: string;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  status: OrderStatus;
  createdAt: string;
  cancelledAt: string | null;
  userId: string;
  username: string;
}

export interface CreateOrderInput {
  ticketTypeId: string;
  quantity: number;
}

export interface AdminOrderFilter {
  eventId?: string;
  status?: OrderStatus;
}

export type StatsGroupBy = 'day' | 'event';

export interface StatsQuery {
  groupBy: StatsGroupBy;
  from: string; // YYYY-MM-DD (giờ Việt Nam), tính cả ngày này
  to: string; // YYYY-MM-DD
}

export interface StatsItem {
  key: string; // ngày YYYY-MM-DD hoặc mã sự kiện
  label: string; // nhãn hiển thị
  booked: number; // số vé đặt
  cancelled: number; // số vé hủy
}

export interface StatsResponse {
  groupBy: StatsGroupBy;
  from: string;
  to: string;
  items: StatsItem[];
  totals: { booked: number; cancelled: number };
  generatedAt: string;
}
