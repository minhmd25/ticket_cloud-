import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requireAdmin, requireAuth } from './auth/middleware';
import type { EventService } from './events/service';
import {
  adminEventListQuerySchema,
  eventCreateSchema,
  eventListQuerySchema,
  eventUpdateSchema,
  ticketTypeInputSchema,
  ticketTypeUpdateSchema,
} from './events/schemas';
import { uuidSchema } from './lib/validation';
import {
  adminOrdersQuerySchema,
  cancelOrderSchema,
  createOrderSchema,
  idempotencyKeySchema,
  myOrdersQuerySchema,
} from './orders/schemas';
import type { OrderService } from './orders/service';
import type { OutboxAdmin, OutboxDispatcher } from './outbox/worker';
import type { StatsService } from './stats/client';

export interface Services {
  events: EventService;
  orders: OrderService;
  outboxAdmin: OutboxAdmin;
  dispatcher: OutboxDispatcher;
  stats: StatsService;
}

const id = (v: unknown) => uuidSchema.parse(v);

// ---- tham số thống kê (kiểm tra trước để không gửi tham số sai sang Azure) ----
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải dạng YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), 'Ngày không tồn tại');
const MAX_DAYS = 366;
const dayIndex = (s: string) => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
/** hôm nay theo giờ Việt Nam */
const todayVN = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const rangeCheck = (o: { from?: string; to?: string }, ctx: z.RefinementCtx) => {
  if (o.from && o.to) {
    if (o.to < o.from) ctx.addIssue({ code: 'custom', path: ['to'], message: '"to" phải >= "from"' });
    else if (dayIndex(o.to) - dayIndex(o.from) + 1 > MAX_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `Khoảng tối đa ${MAX_DAYS} ngày` });
  }
};
/** mặc định 30 ngày gần nhất (giờ VN) */
const dailyStatsQuerySchema = z
  .object({ from: ymd.optional(), to: ymd.optional(), eventId: uuidSchema.optional() })
  .transform((o) => {
    const to = o.to ?? todayVN();
    const from = o.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    return { ...o, from, to };
  })
  .superRefine(rangeCheck);
const eventStatsQuerySchema = z.object({ from: ymd.optional(), to: ymd.optional() }).superRefine(rangeCheck);

export function buildRoutes(s: Services): Router {
  const r = Router();

  // ======================= CÔNG KHAI =======================
  r.get('/events', async (req, res) => {
    res.json(await s.events.list(eventListQuerySchema.parse(req.query), true));
  });
  r.get('/events/categories', async (_req, res) => {
    res.json({ data: await s.events.listCategories() });
  });
  r.get('/events/:eventId', async (req, res) => {
    res.json(await s.events.getById(id(req.params.eventId), true));
  });

  // ======================= KHÁCH (đã đăng nhập) =======================
  r.get('/me', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(currentUser(req));
  });

  r.post('/orders', requireAuth, async (req, res) => {
    const input = createOrderSchema.parse(req.body);
    const key = idempotencyKeySchema.parse(req.header('Idempotency-Key') ?? undefined);
    const { order, replayed } = await s.orders.create(currentUser(req), input, key);
    res.status(replayed ? 200 : 201).json(order);
  });
  r.get('/orders', requireAuth, async (req, res) => {
    res.json(await s.orders.listMine(currentUser(req), myOrdersQuerySchema.parse(req.query)));
  });
  r.get('/orders/:orderId', requireAuth, async (req, res) => {
    res.json(await s.orders.getForUser(currentUser(req), id(req.params.orderId)));
  });
  r.post('/orders/:orderId/cancel', requireAuth, async (req, res) => {
    const body = cancelOrderSchema.parse(req.body ?? {});
    res.json(await s.orders.cancel(currentUser(req), id(req.params.orderId), body.reason));
  });

  // ======================= QUẢN TRỊ =======================
  const admin = Router();
  admin.use(requireAdmin); // quyền lấy từ Backend tài khoản (role = admin)

  admin.get('/events', async (req, res) => {
    res.json(await s.events.list(adminEventListQuerySchema.parse(req.query), false));
  });
  admin.post('/events', async (req, res) => {
    res.status(201).json(await s.events.create(eventCreateSchema.parse(req.body), currentUser(req).userId));
  });
  admin.get('/events/:eventId', async (req, res) => {
    res.json(await s.events.getById(id(req.params.eventId), false));
  });
  admin.patch('/events/:eventId', async (req, res) => {
    res.json(await s.events.update(id(req.params.eventId), eventUpdateSchema.parse(req.body), currentUser(req).userId));
  });
  admin.post('/events/:eventId/ticket-types', async (req, res) => {
    res.status(201).json(await s.events.addTicketType(id(req.params.eventId), ticketTypeInputSchema.parse(req.body)));
  });
  admin.patch('/ticket-types/:ticketTypeId', async (req, res) => {
    res.json(await s.events.updateTicketType(id(req.params.ticketTypeId), ticketTypeUpdateSchema.parse(req.body)));
  });

  admin.get('/orders', async (req, res) => {
    res.json(await s.orders.adminList(adminOrdersQuerySchema.parse(req.query)));
  });
  admin.get('/orders/:orderId', async (req, res) => {
    res.json(await s.orders.getForUser(currentUser(req), id(req.params.orderId)));
  });
  admin.post('/orders/:orderId/cancel', async (req, res) => {
    const body = cancelOrderSchema.parse(req.body ?? {});
    res.json(await s.orders.cancel(currentUser(req), id(req.params.orderId), body.reason));
  });

  // outbox -> Azure
  admin.get('/outbox/stats', async (_req, res) => {
    res.json(await s.outboxAdmin.stats());
  });
  admin.get('/outbox', async (req, res) => {
    const q = z
      .object({ status: z.enum(['PENDING', 'SENT', 'FAILED']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query);
    res.json({ data: await s.outboxAdmin.list(q.status, q.limit) });
  });
  admin.post('/outbox/retry', async (req, res) => {
    const body = z.object({ ids: z.array(uuidSchema).min(1).max(500).optional() }).parse(req.body ?? {});
    const requeued = await s.outboxAdmin.requeue(body.ids);
    const result = await s.dispatcher.dispatchOnce();
    res.json({ requeued, ...result });
  });
  admin.post('/outbox/dispatch', async (_req, res) => {
    res.json(await s.dispatcher.dispatchOnce());
  });

  // thống kê: số vé từ Azure + doanh thu từ DB
  admin.get('/stats/daily', async (req, res) => {
    const q = dailyStatsQuerySchema.parse(req.query);
    res.json(await s.stats.get({ groupBy: 'day', from: q.from, to: q.to, eventId: q.eventId, fillGaps: true }));
  });
  admin.get('/stats/events', async (req, res) => {
    const q = eventStatsQuerySchema.parse(req.query);
    res.json(await s.stats.get({ groupBy: 'event', from: q.from, to: q.to }));
  });
  admin.get('/stats/events/:eventId', async (req, res) => {
    const q = eventStatsQuerySchema.parse(req.query);
    const eventId = id(req.params.eventId);
    const r = await s.stats.get({ groupBy: 'event', eventId, from: q.from, to: q.to });
    res.json({ ...r, item: r.items.find((i) => i.key === eventId) ?? null });
  });
  // đối soát: Azure đã thực sự xử lý các thông điệp của đơn này chưa (/history)
  admin.get('/orders/:orderId/azure-sync', async (req, res) => {
    res.json(await s.stats.orderSync(id(req.params.orderId)));
  });

  r.use('/admin', admin);
  return r;
}
