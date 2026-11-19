import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db';

/**
 * MẪU THÔNG ĐIỆP gửi sang Azure (xem docs/azure-message-contract.md).
 * Thay đổi không tương thích => tăng `version`.
 */
export type OrderEventType = 'ORDER_CREATED' | 'ORDER_CANCELLED';

export interface OrderEventMessage {
  messageId: string; // duy nhất, Azure dùng để khử trùng lặp (gửi at-least-once)
  type: OrderEventType;
  version: 1;
  source: 'gcp-ticketing';
  occurredAt: string; // ISO 8601 UTC
  data: {
    orderId: string;
    userId: string;
    eventId: string;
    eventTitle: string;
    eventCategory: string;
    eventStartTime: string;
    ticketTypeId: string;
    ticketTypeName: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
    currency: 'VND';
    status: 'CONFIRMED' | 'CANCELLED';
    orderCreatedAt: string;
    cancelledAt: string | null;
    cancelReason: string | null;
  };
}

export interface OrderSnapshot {
  id: string;
  user_id: string;
  event_id: string;
  ticket_type_id: string;
  quantity: number;
  unit_price: string;
  total_amount: string;
  status: 'CONFIRMED' | 'CANCELLED';
  created_at: Date;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  event_title: string;
  event_category: string;
  event_start_time: Date;
  ticket_type_name: string;
}

/**
 * Ghi sự kiện vào bảng outbox. PHẢI gọi bằng client đang trong giao dịch thay đổi đơn,
 * để thay đổi đơn và sự kiện được commit (hoặc rollback) cùng nhau.
 */
export async function enqueueOrderEvent(tx: Queryable, type: OrderEventType, o: OrderSnapshot): Promise<OrderEventMessage> {
  const msg: OrderEventMessage = {
    messageId: randomUUID(),
    type,
    version: 1,
    source: 'gcp-ticketing',
    occurredAt: new Date().toISOString(),
    data: {
      orderId: o.id,
      userId: o.user_id,
      eventId: o.event_id,
      eventTitle: o.event_title,
      eventCategory: o.event_category,
      eventStartTime: new Date(o.event_start_time).toISOString(),
      ticketTypeId: o.ticket_type_id,
      ticketTypeName: o.ticket_type_name,
      quantity: o.quantity,
      unitPrice: Number(o.unit_price),
      totalAmount: Number(o.total_amount),
      currency: 'VND',
      status: o.status,
      orderCreatedAt: new Date(o.created_at).toISOString(),
      cancelledAt: o.cancelled_at ? new Date(o.cancelled_at).toISOString() : null,
      cancelReason: o.cancel_reason,
    },
  };
  await tx.query(
    `INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, 'order', $2, $3, $4)`,
    [msg.messageId, o.id, type, JSON.stringify(msg)],
  );
  return msg;
}
