import { z } from 'zod';
import { isoDateSchema } from '../lib/validation';

export const queueSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** giờ mở bán, ISO 8601 có múi giờ */
    saleStartAt: isoDateSchema,
    /** số người được ở trong trang mua cùng lúc */
    maxActive: z.number().int().min(1).max(10000),
    /** số phút mỗi người được mua sau khi vào */
    accessMinutes: z.number().int().min(1).max(120),
  })
  .strict();

export type QueueSettingsInput = z.infer<typeof queueSettingsSchema>;
