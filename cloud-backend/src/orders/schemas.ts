import { z } from 'zod';
import { paginationSchema, uuidSchema } from '../lib/validation';

export const ORDER_STATUSES = ['CONFIRMED', 'CANCELLED'] as const;

export const createOrderSchema = z
  .object({
    ticketTypeId: uuidSchema,
    /** hạng vé GENERAL: bắt buộc. Hạng ASSIGNED: bỏ trống hoặc bằng số ghế */
    quantity: z.number({ message: 'Số lượng phải là số' }).int('Số lượng phải là số nguyên').min(1, 'Số lượng phải >= 1').optional(),
    /** hạng vé ASSIGNED: các ghế muốn đặt (cùng một hạng vé) */
    seatIds: z.array(uuidSchema).min(1, 'Cần chọn ít nhất một ghế').max(100).optional(),
  })
  // Không nhận userId/price/totalAmount từ client: người đặt lấy từ phiên, giá lấy từ DB.
  .strip()
  .superRefine((o, ctx) => {
    if (o.seatIds === undefined && o.quantity === undefined) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'Cần quantity (vé thường) hoặc seatIds (vé theo ghế)' });
    }
    if (o.seatIds) {
      if (new Set(o.seatIds).size !== o.seatIds.length) ctx.addIssue({ code: 'custom', path: ['seatIds'], message: 'Danh sách ghế bị trùng' });
      if (o.quantity !== undefined && o.quantity !== o.seatIds.length) {
        ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity phải bằng số ghế đã chọn' });
      }
    }
  })
  .transform((o) => ({
    ticketTypeId: o.ticketTypeId,
    quantity: o.seatIds ? o.seatIds.length : o.quantity!,
    // sắp xếp sẵn: mọi giao dịch ghi ghế theo cùng một thứ tự => không deadlock
    seatIds: o.seatIds ? [...o.seatIds].sort() : undefined,
  }));

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

/** quantity đã được chuẩn hóa (= số ghế khi có seatIds); seatIds đã sắp xếp */
export type CreateOrderInput = { ticketTypeId: string; quantity: number; seatIds?: string[] };
export type AdminOrdersQuery = z.infer<typeof adminOrdersQuerySchema>;
export type MyOrdersQuery = z.infer<typeof myOrdersQuerySchema>;
