import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_OPTIONS = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, SCRYPT_OPTIONS, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return ['scrypt-v1', salt.toString('hex'), key.toString('hex')].join('$');
}

export async function verifyPassword(password: string, storedHash?: string): Promise<boolean> {
  const parts = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(storedHash ?? '');
  // Vẫn chạy scrypt khi tài khoản không tồn tại để giảm chênh lệch thời gian phản hồi.
  const salt = parts ? Buffer.from(parts[1], 'hex') : Buffer.alloc(16);
  const key = await deriveKey(password, salt);
  return parts !== null && timingSafeEqual(key, Buffer.from(parts[2], 'hex'));
}
