import { z } from 'zod';
import { isoDateSchema, paginationSchema, priceSchema, quantitySchema } from '../lib/validation';

export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;

const categorySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Loại hình không được trống')
  .max(50)
  .regex(/^[a-z0-9_-]+$/, 'Loại hình chỉ gồm chữ thường không dấu, số, "-" hoặc "_" (vd: concert, sport)');

/**
 * GENERAL : bán theo số lượng, admin nhập totalQuantity.
 * ASSIGNED: bán theo ghế trên sơ đồ, totalQuantity do backend tính = số ghế (không bị khóa) của hạng.
 */
export const SEATING_MODES = ['GENERAL', 'ASSIGNED'] as const;

export const ticketTypeInputSchema = z
  .object({
    name: z.string().trim().min(1, 'Tên hạng vé không được trống').max(100),
    description: z.string().max(2000).optional().default(''),
    price: priceSchema,
    seating: z.enum(SEATING_MODES).optional().default('GENERAL'),
    totalQuantity: quantitySchema.optional(),
  })
  .superRefine((t, ctx) => {
    if (t.seating === 'GENERAL' && t.totalQuantity === undefined) {
      ctx.addIssue({ code: 'custom', path: ['totalQuantity'], message: 'Cần nhập tổng số vé' });
    }
    if (t.seating === 'ASSIGNED' && t.totalQuantity !== undefined && t.totalQuantity !== 0) {
      ctx.addIssue({ code: 'custom', path: ['totalQuantity'], message: 'Hạng vé theo ghế tính số vé theo sơ đồ ghế, không nhập totalQuantity' });
    }
  })
  .transform((t) => ({ ...t, totalQuantity: t.seating === 'ASSIGNED' ? 0 : t.totalQuantity! }));

export const ticketTypeUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    price: priceSchema,
    totalQuantity: quantitySchema,
    seating: z.enum(SEATING_MODES),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Cần ít nhất một trường để cập nhật')
  .refine((o) => !(o.seating === 'ASSIGNED' && o.totalQuantity !== undefined), {
    message: 'Hạng vé theo ghế tính số vé theo sơ đồ ghế, không nhập totalQuantity',
    path: ['totalQuantity'],
  });

export const eventCreateSchema = z
  .object({
    title: z.string().trim().min(1, 'Tên sự kiện không được trống').max(200),
    description: z.string().max(10000).optional().default(''),
    category: categorySchema,
    venue: z.string().trim().min(1, 'Địa điểm không được trống').max(255),
    startTime: isoDateSchema,
    endTime: isoDateSchema,
    status: z.enum(['DRAFT', 'PUBLISHED']).optional().default('DRAFT'),
    imageUrl: z.url().max(2000).nullable().optional(),
    ticketTypes: z.array(ticketTypeInputSchema).max(50).optional().default([]),
  })
  .refine((e) => e.endTime > e.startTime, { message: 'Giờ kết thúc phải sau giờ bắt đầu', path: ['endTime'] })
  .refine((e) => new Set(e.ticketTypes.map((t) => t.name.toLowerCase())).size === e.ticketTypes.length, {
    message: 'Tên các hạng vé trong cùng sự kiện không được trùng',
    path: ['ticketTypes'],
  });

export const eventUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10000),
    category: categorySchema,
    venue: z.string().trim().min(1).max(255),
    startTime: isoDateSchema,
    endTime: isoDateSchema,
    status: z.enum(EVENT_STATUSES),
    imageUrl: z.url().max(2000).nullable(),
    /** lý do ghi vào các đơn bị hủy theo sự kiện; chỉ dùng cùng status = CANCELLED */
    cancelReason: z.string().trim().min(1).max(500),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Cần ít nhất một trường để cập nhật')
  .refine((o) => o.cancelReason === undefined || o.status === 'CANCELLED', {
    message: 'cancelReason chỉ dùng khi đặt status = CANCELLED',
    path: ['cancelReason'],
  });

export const eventListQuerySchema = paginationSchema.extend({
  category: z.string().trim().toLowerCase().optional(),
  q: z.string().trim().max(100).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  /** mặc định chỉ lấy sự kiện chưa kết thúc */
  includePast: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

export const adminEventListQuerySchema = eventListQuerySchema.extend({
  status: z.enum(EVENT_STATUSES).optional(),
});

export type EventCreateInput = z.infer<typeof eventCreateSchema>;
export type EventUpdateInput = z.infer<typeof eventUpdateSchema>;
export type TicketTypeInput = z.infer<typeof ticketTypeInputSchema>;
export type TicketTypeUpdateInput = z.infer<typeof ticketTypeUpdateSchema>;
export type EventListQuery = z.infer<typeof adminEventListQuerySchema>;
