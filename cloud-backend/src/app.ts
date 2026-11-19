import express, { type Express } from 'express';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { authenticate } from './auth/middleware';
import { buildLoginRoutes } from './auth/routes';
import type { AuthProvider } from './auth/types';
import type { Config } from './config';
import { errorHandler, notFoundHandler } from './errors';
import { EventService } from './events/service';
import { OrderService } from './orders/service';
import type { EventPublisher } from './outbox/publisher';
import { OutboxAdmin, OutboxDispatcher } from './outbox/worker';
import { QueueService } from './queue/service';
import { QueueWorker } from './queue/worker';
import { buildRoutes, type Services } from './routes';
import { SeatMapService } from './seating/service';
import type { StatsService } from './stats/client';

/** Lưu sơ đồ ghế (tới 5000 ghế) cần body lớn hơn mức 100kb của các API khác */
const LARGE_BODY_ROUTE = /^\/api\/admin\/events\/[^/]+\/seat-map$/;

export interface AppDeps {
  db: Pool;
  config: Config;
  auth: AuthProvider;
  publisher: EventPublisher;
  stats: StatsService;
  now?: () => Date;
}

export function createApp(deps: AppDeps): { app: Express; services: Services } {
  const services: Services = {
    events: new EventService(deps.db),
    orders: new OrderService(deps.db, deps.config.rules, deps.now),
    outboxAdmin: new OutboxAdmin(deps.db),
    dispatcher: new OutboxDispatcher(deps.db, deps.publisher, deps.config.outbox),
    stats: deps.stats,
    seatMaps: new SeatMapService(deps.db),
    queue: new QueueService(deps.db, deps.config.queue),
    queueWorker: new QueueWorker(deps.db, deps.config.queue),
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true); // chạy sau load balancer của Cloud Run
  const smallJson = express.json({ limit: '100kb' });
  const largeJson = express.json({ limit: '2mb' });
  app.use((req, res, next) => (req.method === 'PUT' && LARGE_BODY_ROUTE.test(req.path) ? largeJson : smallJson)(req, res, next));

  // CORS cho frontend
  const allowedOrigins = deps.config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.get('Origin');
    res.vary('Origin');
    if (allowedOrigins.includes('*')) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, If-None-Match');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Trang test thủ công (không phải frontend thật) - tắt ở production
  if (deps.config.devConsole) {
    app.use('/dev', express.static(resolve(__dirname, '..', 'dev-console')));
  }

  app.get('/', (_req, res) => {
    res.json({
      service: 'event-ticketing-backend',
      devConsole: deps.config.devConsole ? '/dev' : 'tắt',
      docs: 'Xem docs/API.md trong mã nguồn',
      health: '/health',
      auth: `${deps.auth.name}${deps.auth.name === 'mock' ? ' (header Authorization: Bearer mock:<userId>:<customer|admin>)' : ''}`,
      endpoints: {
        public: [
          ...(deps.auth.login ? ['POST /api/auth/login'] : []),
          'GET /api/events?category=',
          'GET /api/events/categories',
          'GET /api/events/:eventId',
          'GET /api/events/:eventId/seat-map (ETag)',
          'GET /api/events/:eventId/seats/status',
        ],
        customer: [
          'POST /api/orders',
          'GET /api/orders',
          'GET /api/orders/:orderId',
          'POST /api/orders/:orderId/cancel',
          'GET /api/me',
          'POST /api/events/:eventId/queue',
          'GET|DELETE /api/events/:eventId/queue/me',
        ],
        admin: [
          'GET|POST /api/admin/events',
          'GET|PATCH /api/admin/events/:eventId',
          'POST /api/admin/events/:eventId/ticket-types',
          'PATCH /api/admin/ticket-types/:ticketTypeId',
          'GET|PUT /api/admin/events/:eventId/seat-map',
          'POST /api/admin/events/:eventId/seat-map/copy-from/:sourceEventId',
          'PATCH /api/admin/events/:eventId/seats',
          'GET /api/admin/events/:eventId/seats/status',
          'GET|PUT /api/admin/events/:eventId/queue, POST /api/admin/events/:eventId/queue/tick',
          'GET /api/admin/orders?eventId=&status=',
          'POST /api/admin/orders/:orderId/cancel',
          'GET /api/admin/outbox, GET /api/admin/outbox/stats, POST /api/admin/outbox/retry',
          'GET /api/admin/stats/overview, GET /api/admin/stats/events/:eventId',
        ],
      },
    });
  });

  app.get('/health', async (_req, res) => {
    try {
      await deps.db.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok', auth: deps.auth.name, publisher: deps.publisher.name });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });

  app.use('/api/auth', buildLoginRoutes(deps.auth));
  app.use('/api', authenticate(deps.auth), buildRoutes(services));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, services };
}
