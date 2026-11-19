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

export const ticketTypeInputSchema = z.object({
  name: z.string().trim().min(1, 'Tên hạng vé không được trống').max(100),
  description: z.string().max(2000).optional().default(''),
  price: priceSchema,
  totalQuantity: quantitySchema,
});

export const ticketTypeUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(2000),
    price: priceSchema,
    totalQuantity: quantitySchema,
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Cần ít nhất một trường để cập nhật');

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
