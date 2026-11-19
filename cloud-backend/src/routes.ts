import { Router, type Request, type Response } from 'express';
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
import { queueSettingsSchema } from './queue/schemas';
import type { QueueService } from './queue/service';
import type { QueueWorker } from './queue/worker';
import { seatMapCopySchema, seatMapInputSchema, seatPatchSchema } from './seating/schemas';
import { seatMapEtag, type SeatMapService } from './seating/service';
import type { StatsService } from './stats/client';

export interface Services {
  events: EventService;
  orders: OrderService;
  outboxAdmin: OutboxAdmin;
  dispatcher: OutboxDispatcher;
  stats: StatsService;
  seatMaps: SeatMapService;
  queue: QueueService;
  queueWorker: QueueWorker;
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

  // Sơ đồ ghế: ít thay đổi, có thể tới 5000 ghế => ETag theo version, trình duyệt gửi If-None-Match, nhận 304.
  const sendSeatMap = (publicView: boolean) => async (req: Request, res: Response) => {
    const eventId = id(req.params.eventId);
    const version = await s.seatMaps.currentVersion(eventId, publicView);
    res.set('Cache-Control', 'no-cache');
    res.set('ETag', seatMapEtag(version));
    if (req.fresh) {
      res.status(304).end();
      return;
    }
    const map = await s.seatMaps.get(eventId, publicView);
    res.set('ETag', seatMapEtag(map.version));
    res.json(map);
  };
  r.get('/events/:eventId/seat-map', sendSeatMap(true));
  // Trạng thái ghế: thay đổi liên tục, frontend hỏi lại định kỳ
  r.get('/events/:eventId/seats/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await s.seatMaps.status(id(req.params.eventId), true));
  });

  // ======================= HÀNG CHỜ (đã đăng nhập) =======================
  r.post('/events/:eventId/queue', requireAuth, async (req, res) => {
    const { entry, created } = await s.queue.join(id(req.params.eventId), currentUser(req));
    res.set('Cache-Control', 'no-store');
    res.status(created ? 201 : 200).json(entry);
  });
  r.get('/events/:eventId/queue/me', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await s.queue.me(id(req.params.eventId), currentUser(req)));
  });
  r.delete('/events/:eventId/queue/me', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await s.queue.leave(id(req.params.eventId), currentUser(req)));
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

  // sơ đồ ghế
  admin.get('/events/:eventId/seat-map', sendSeatMap(false));
  admin.put('/events/:eventId/seat-map', async (req, res) => {
    const map = await s.seatMaps.save(id(req.params.eventId), seatMapInputSchema.parse(req.body), currentUser(req).userId);
    res.set('ETag', seatMapEtag(map.version));
    res.json(map);
  });
  admin.post('/events/:eventId/seat-map/copy-from/:sourceEventId', async (req, res) => {
    const body = seatMapCopySchema.parse(req.body ?? {});
    const map = await s.seatMaps.copyFrom(id(req.params.eventId), id(req.params.sourceEventId), body.version, currentUser(req).userId);
    res.set('ETag', seatMapEtag(map.version));
    res.json(map);
  });
  admin.patch('/events/:eventId/seats', async (req, res) => {
    res.json(await s.seatMaps.patchSeats(id(req.params.eventId), seatPatchSchema.parse(req.body), currentUser(req).userId));
  });
  admin.get('/events/:eventId/seats/status', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await s.seatMaps.status(id(req.params.eventId), false));
  });

  // hàng chờ ảo
  admin.get('/events/:eventId/queue', async (req, res) => {
    res.json(await s.queue.getSettings(id(req.params.eventId)));
  });
  admin.put('/events/:eventId/queue', async (req, res) => {
    res.json(await s.queue.putSettings(id(req.params.eventId), queueSettingsSchema.parse(req.body), currentUser(req).userId));
  });
  /** chạy worker hàng chờ một nhịp ngay cho sự kiện này (demo, không phải chờ QUEUE_TICK_MS) */
  admin.post('/events/:eventId/queue/tick', async (req, res) => {
    const eventId = id(req.params.eventId);
    const tick = await s.queueWorker.tickOnce(eventId);
    res.json({ tick, settings: await s.queue.getSettings(eventId) });
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
