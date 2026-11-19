import { Pool, PoolClient, types } from 'pg';
import { config } from './config';

// NUMERIC -> giữ dạng string để không mất chính xác tiền tệ; COUNT/BIGINT -> number
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export type Db = Pool;
export type Tx = PoolClient;
/** Thứ có thể chạy query: pool hoặc client đang trong giao dịch */
export type Queryable = Pick<Pool, 'query'> | PoolClient;

export function createPool(connectionString = config.databaseUrl): Pool {
  if (!Number.isInteger(config.dbPoolMax) || config.dbPoolMax < 1) {
    throw new Error('DB_POOL_MAX phải là số nguyên dương');
  }
  return new Pool({ connectionString, max: config.dbPoolMax });
}

/**
 * Chạy fn trong một giao dịch. Mọi lỗi ném ra => ROLLBACK toàn bộ.
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* kết nối có thể đã hỏng; bỏ qua */
    }
    throw err;
  } finally {
    client.release();
  }
}
