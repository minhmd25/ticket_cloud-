import { createApp } from './app';
import { createAuthProvider } from './auth/providers';
import { config } from './config';
import { createPool } from './db';
import { createPublisher } from './outbox/publisher';
import { createStatsService } from './stats/client';

async function main() {
  const db = createPool();
  const auth = createAuthProvider(config.auth, db);
  const publisher = createPublisher(config.publisher);
  const stats = createStatsService(config.stats, db);
  const { app, services } = createApp({ db, config, auth, publisher, stats });

  const server = app.listen(config.port, () => {
    console.log(`[api] lắng nghe :${config.port} | auth=${auth.name} publisher=${publisher.name} stats=${config.stats.mode}`);
  });
  if (config.outbox.enabled) {
    services.dispatcher.start();
    console.log(`[outbox] worker chạy mỗi ${config.outbox.pollIntervalMs}ms`);
  }
  if (config.queue.tickMs > 0) {
    services.queueWorker.start();
    console.log(`[queue] worker hàng chờ chạy mỗi ${config.queue.tickMs}ms`);
  }

  const shutdown = (sig: string) => {
    console.log(`[api] nhận ${sig}, đang tắt...`);
    services.dispatcher.stop();
    services.queueWorker.stop();
    server.close(() => void db.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
