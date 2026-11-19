import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { config } from '../config';

/**
 * Áp dụng các file migrations/*.sql theo thứ tự tên, mỗi file một giao dịch.
 * Đã chạy rồi thì bỏ qua (ghi trong bảng schema_migrations).
 * Advisory lock để nhiều instance khởi động cùng lúc không chạy chồng.
 */
export async function migrate(databaseUrl = config.databaseUrl, log = true): Promise<string[]> {
  const dir = resolve(__dirname, '..', '..', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        if (log) console.log(`[migrate] đã áp dụng ${f}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} lỗi: ${(err as Error).message}`);
      }
    }
    if (log && applied.length === 0) console.log('[migrate] không có migration mới');
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
    await pool.end();
  }
  return applied;
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
