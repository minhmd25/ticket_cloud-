import { seedDemoAccounts } from '../auth/demo-accounts';
import { config } from '../config';
import { createPool } from '../db';
import { migrate } from './migrate';

function password(name: string, demoDefault?: string): string {
  const value = process.env[name] ?? demoDefault;
  if (!value || value.trim().length < 12 || value.length > 256) {
    throw new Error(`${name} phải có từ 12 đến 256 ký tự`);
  }
  return value;
}

async function main() {
  const demo = process.argv.includes('--demo');
  if (demo && config.nodeEnv === 'production') {
    throw new Error('NODE_ENV=production yêu cầu mật khẩu mẫu được cấp qua biến môi trường');
  }
  const customerPassword = password('DEMO_CUSTOMER_PASSWORD', demo ? 'DemoCustomer2026!' : undefined);
  const adminPassword = password('DEMO_ADMIN_PASSWORD', demo ? 'DemoAdmin2026!' : undefined);

  await migrate();
  const db = createPool();
  try {
    await seedDemoAccounts(db, customerPassword, adminPassword);
    console.log('[seed:accounts] Tài khoản thử đã sẵn sàng: alice (customer), admin1 (admin)');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
