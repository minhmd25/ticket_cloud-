import { z } from 'zod';
import { uuidSchema } from '../lib/validation';

/** Số ghế tối đa của một sơ đồ */
export const MAX_SEATS = 5000;
export const MAX_SECTIONS = 100;
export const MAX_DECORATIONS = 200;

/** Zod 4 đã từ chối Infinity/NaN với z.number() */
const finite = (msg: string) => z.number({ message: msg });

export const seatSectionInputSchema = z.object({
  key: z.string().trim().regex(/^[A-Za-z0-9_-]{1,50}$/, 'Mã khu chỉ gồm chữ không dấu, số, "-" hoặc "_" (tối đa 50 ký tự)'),
  name: z.string().trim().min(1, 'Tên khu không được trống').max(100),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Màu phải dạng #RRGGBB').nullable().optional(),
});

export const seatInputSchema = z.object({
  label: z.string().trim().min(1, 'Nhãn ghế không được trống').max(20, 'Nhãn ghế tối đa 20 ký tự'),
  row: z.string().trim().max(20).nullable().optional(),
  section: z.string().trim().max(50).nullable().optional(),
  ticketTypeId: uuidSchema,
  x: finite('x phải là số'),
  y: finite('y phải là số'),
  rotation: finite('rotation phải là số').min(-360).max(360).optional().default(0),
  accessible: z.boolean().optional().default(false),
  blocked: z.boolean().optional().default(false),
});

/** Trang trí chỉ để vẽ (sân khấu, lối đi, chữ...). Backend không hiểu nội dung, chỉ giới hạn kích thước. */
const decorationSchema = z.looseObject({ type: z.string().trim().min(1).max(30) });

export const seatMapInputSchema = z
  .object({
    /** version hiện tại của sơ đồ mà admin đang sửa; 0 khi sự kiện chưa có sơ đồ */
    version: z.number().int().min(0),
    width: z.number().int().min(100).max(20000),
    height: z.number().int().min(100).max(20000),
    seatSize: finite('seatSize phải là số').gt(0).max(500).optional().default(24),
    sections: z.array(seatSectionInputSchema).max(MAX_SECTIONS).optional().default([]),
    seats: z.array(seatInputSchema).max(MAX_SEATS, `Sơ đồ có tối đa ${MAX_SEATS} ghế`),
    decorations: z.array(decorationSchema).max(MAX_DECORATIONS).optional().default([]),
  })
  .strict()
  .refine((m) => JSON.stringify(m.decorations).length <= 200_000, { message: 'Phần trang trí quá lớn', path: ['decorations'] });

export const seatPatchSchema = z
  .object({
    seatIds: z.array(uuidSchema).min(1).max(MAX_SEATS),
    blocked: z.boolean(),
  })
  .strict();

export const seatMapCopySchema = z.object({ version: z.number().int().min(0) }).strict();

export type SeatMapInput = z.infer<typeof seatMapInputSchema>;
export type SeatInput = SeatMapInput['seats'][number];
export type SeatPatchInput = z.infer<typeof seatPatchSchema>;
