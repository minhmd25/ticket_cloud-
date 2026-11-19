import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../lib/validation';

export const ORDER_STATUSES = ['CONFIRMED', 'CANCELLED'] as const;

export const createOrderSchema = z
  .object({
    ticketTypeId: uuidSchema,
    quantity: z.number({ message: 'Số lượng phải là số' }).int('Số lượng phải là số nguyên').min(1, 'Số lượng phải >= 1'),
  })
  // Không nhận userId/price/totalAmount từ client: người đặt lấy từ phiên, giá lấy từ DB.
  .strip();

export const cancelOrderSchema = z.object({ reason: z.string().trim().max(500).optional() }).optional().default({});

export const myOrdersQuerySchema = paginationSchema.extend({
  status: z.enum(ORDER_STATUSES).optional(),
});

export const adminOrdersQuerySchema = paginationSchema.extend({
  eventId: uuidSchema.optional(),
  ticketTypeId: uuidSchema.optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  userId: z.string().max(100).optional(),
});

export const idempotencyKeySchema = z.string().trim().min(1).max(100).optional();

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;
