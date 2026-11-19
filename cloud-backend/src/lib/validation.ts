import { z } from 'zod';

export const uuidSchema = z.uuid({ message: 'Định danh phải là UUID hợp lệ' });

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

/** Giá: số (hoặc chuỗi số) >= 0, tối đa 2 chữ số thập phân. Trả về chuỗi để lưu NUMERIC chính xác. */
export const priceSchema = z
  .union([z.number(), z.string().trim()])
  .transform((v, ctx) => {
    const s = typeof v === 'number' ? String(v) : v;
    const n = Number(s);
    if (s === '' || !Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: 'Giá phải là số' });
      return z.NEVER;
    }
    if (n < 0) {
      ctx.addIssue({ code: 'custom', message: 'Giá không được âm' });
      return z.NEVER;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'Giá tối đa 2 chữ số thập phân' });
      return z.NEVER;
    }
    if (n > 9_999_999_999) {
      ctx.addIssue({ code: 'custom', message: 'Giá quá lớn' });
      return z.NEVER;
    }
    return s;
  });

/** Số lượng vé: số nguyên >= 0 */
export const quantitySchema = z
  .number({ message: 'Số lượng phải là số' })
  .int('Số lượng phải là số nguyên')
  .min(0, 'Số lượng không được âm')
  .max(1_000_000, 'Số lượng quá lớn');

export const isoDateSchema = z.iso
  .datetime({ offset: true, message: 'Thời gian phải theo ISO 8601, vd 2026-12-31T19:00:00+07:00' })
  .transform((s) => new Date(s));

export function pageMeta(p: Pagination, total: number) {
  return { page: p.page, limit: p.limit, total, totalPages: Math.ceil(total / p.limit) };
}
