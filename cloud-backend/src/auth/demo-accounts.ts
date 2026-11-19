import type { Queryable } from '../db';
import { hashPassword } from './passwords';

export async function seedDemoAccounts(db: Queryable, customerPassword: string, adminPassword: string): Promise<void> {
  const [customerHash, adminHash] = await Promise.all([hashPassword(customerPassword), hashPassword(adminPassword)]);
  // Các mã này khớp với người dùng đã dùng trong dữ liệu demo của module đặt vé.
  await db.query(
    `INSERT INTO accounts (user_id, username, password_hash, role)
     VALUES ('alice', 'alice', $1, 'customer'), ('admin1', 'admin1', $2, 'admin')
     ON CONFLICT (user_id) DO NOTHING`,
    [customerHash, adminHash],
  );
}
