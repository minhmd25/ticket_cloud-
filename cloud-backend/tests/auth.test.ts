import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedDemoAccounts } from '../src/auth/demo-accounts';
import { hashPassword } from '../src/auth/passwords';
import { JwtAuthProvider } from '../src/auth/providers';
import { signTestToken } from '../src/auth/test-token';
import { config } from '../src/config';
import { createEvent, setupTestApp } from './helpers';

const SECRET = 'test-only-secret-for-account-integration';
const CUSTOMER_PASSWORD = 'example-customer-password';
const ADMIN_PASSWORD = 'example-admin-password';

describe('Backend tài khoản và phân quyền', () => {
  const ctx = setupTestApp({}, { ...config.auth, mode: 'local', jwtSecret: SECRET, tokenTtlSeconds: 3600 });
  const login = (username: string, password: string) => ctx.api().post('/api/auth/login').send({ username, password });

  async function authorize(username: string, password: string) {
    const res = await login(username, password).expect(200);
    return `Bearer ${res.body.token}`;
  }

  beforeEach(async () => {
    await ctx.db.query('TRUNCATE accounts');
    await seedDemoAccounts(ctx.db, CUSTOMER_PASSWORD, ADMIN_PASSWORD);
  });

  it('lưu hash có salt và chạy lại seed mà giữ nguyên thông tin đăng nhập', async () => {
    const { rows } = await ctx.db.query('SELECT username, role, password_hash FROM accounts ORDER BY username');
    expect(rows.map(({ username, role }) => [username, role])).toEqual([['admin1', 'admin'], ['alice', 'customer']]);
    expect(rows[0].password_hash).toMatch(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(rows[1].password_hash).toMatch(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(rows[0].password_hash.split('$')[1]).not.toBe(rows[1].password_hash.split('$')[1]);

    await seedDemoAccounts(ctx.db, 'replacement-customer', 'replacement-admin');
    expect((await ctx.db.query('SELECT username, role, password_hash FROM accounts ORDER BY username')).rows).toEqual(rows);
    await login('alice', CUSTOMER_PASSWORD).expect(200);
  });

  it('trả token và vai trò cho cả hai tài khoản, kể cả khi frontend còn header phiên cũ', async () => {
    for (const [username, password, role] of [
      ['alice', CUSTOMER_PASSWORD, 'customer'],
      ['admin1', ADMIN_PASSWORD, 'admin'],
    ]) {
      const res = await ctx.api().post('/api/auth/login').set('Authorization', 'Bearer old-session')
        .send({ username, password, role: 'admin' }).expect(200);
      expect(res.body).toEqual({ token: expect.any(String), expiresIn: 3600, userId: username, role });
      expect(res.headers['cache-control']).toBe('no-store');
      const profile = await ctx.api().get('/api/me').set('Authorization', `Bearer ${res.body.token}`).expect(200);
      expect(profile.body).toEqual({ userId: username, role });
      expect(profile.headers['cache-control']).toBe('no-store');
    }
  });

  it('trả cùng cấu trúc lỗi khi thiếu trường hoặc thông tin đăng nhập sai', async () => {
    for (const body of [{}, { username: 'alice' }, { password: 'password' }, { username: ' ', password: 'password' }]) {
      const res = await ctx.api().post('/api/auth/login').send(body).expect(400);
      expect(res.body).toEqual({ error: { code: 'VALIDATION_ERROR', message: expect.any(String) } });
    }
    const badPassword = await login('alice', 'wrong-password').expect(401);
    const badUsername = await login('unknown', CUSTOMER_PASSWORD).expect(401);
    expect(badPassword.body).toEqual({
      error: { code: 'INVALID_CREDENTIALS', message: 'Tài khoản hoặc mật khẩu không đúng' },
    });
    expect(badUsername.body).toEqual(badPassword.body);
  });

  it('từ chối phiên thiếu, sai định dạng, không hợp lệ hoặc hết hạn', async () => {
    const missing = await ctx.api().get('/api/me').expect(401);
    expect(missing.body.error.code).toBe('UNAUTHORIZED');
    const expired = jwt.sign({}, SECRET, {
      issuer: 'event-ticketing-backend', audience: 'event-ticketing-api', subject: 'alice', expiresIn: -10,
    });
    for (const header of ['Basic example', 'Bearer invalid', 'Bearer mock:alice:admin', `Bearer ${expired}`]) {
      const denied = await ctx.api().get('/api/me').set('Authorization', header).expect(401);
      expect(denied.body).toEqual(missing.body);
    }
    await ctx.api().get('/api/orders').expect(401);
    await ctx.api().get('/api/admin/events').expect(401);
  });

  it('chặn khách và cho quản trị tạo/sửa sự kiện và quản lý hạng vé', async () => {
    const customer = await authorize('alice', CUSTOMER_PASSWORD);
    const admin = await authorize('admin1', ADMIN_PASSWORD);
    const denied = await ctx.api().post('/api/admin/events').set('Authorization', customer).send({}).expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');

    const event = await createEvent(ctx, { auth: admin });
    await ctx.api().patch(`/api/admin/events/${event.id}`).set('Authorization', admin).send({ title: 'Đã sửa' }).expect(200);
    const path = `/api/admin/ticket-types/${event.ticketTypes[0].id}`;
    await ctx.api().patch(path).set('Authorization', customer).send({ price: 150000 }).expect(403);
    await ctx.api().patch(path).set('Authorization', admin).send({ price: 150000 }).expect(200);
  });

  it('nhận token của script npm run token ở chế độ local và jwt, vai trò vẫn lấy từ DB', async () => {
    const forAdmin = signTestToken({ sub: 'admin1', role: 'admin', ttlMinutes: 5 }, SECRET);
    const me = await ctx.api().get('/api/me').set('Authorization', `Bearer ${forAdmin}`).expect(200);
    expect(me.body).toEqual({ userId: 'admin1', role: 'admin' });

    // Tự xưng admin cho tài khoản khách không có tác dụng: vai trò đọc từ bảng accounts.
    const forged = signTestToken({ sub: 'alice', role: 'admin', ttlMinutes: 5 }, SECRET);
    await ctx.api().get('/api/admin/events').set('Authorization', `Bearer ${forged}`).expect(403);

    // Không có trong bảng accounts thì bị từ chối.
    const unknown = signTestToken({ sub: 'ghost', role: 'admin', ttlMinutes: 5 }, SECRET);
    await ctx.api().get('/api/me').set('Authorization', `Bearer ${unknown}`).expect(401);

    // Chế độ jwt (không kiểm tra iss/aud) vẫn đọc được token này.
    const jwtUser = await new JwtAuthProvider(SECRET, ['HS256']).verify(forAdmin);
    expect(jwtUser).toMatchObject({ userId: 'admin1', role: 'admin' });
  });

  it('đọc lại vai trò hiện tại và từ chối phiên của tài khoản đã bị xóa', async () => {
    const admin = await authorize('admin1', ADMIN_PASSWORD);
    await ctx.db.query("UPDATE accounts SET role = 'customer' WHERE user_id = 'admin1'");
    await ctx.api().get('/api/admin/events').set('Authorization', admin).expect(403);
    await ctx.db.query("DELETE FROM accounts WHERE user_id = 'admin1'");
    await ctx.api().get('/api/me').set('Authorization', admin).expect(401);
  });

  it('dùng mã từ phiên để đặt, xem và hủy đơn của đúng khách hàng', async () => {
    const bobPassword = 'example-second-customer';
    await ctx.db.query(
      "INSERT INTO accounts (user_id, username, password_hash, role) VALUES ('bob', 'bob', $1, 'customer')",
      [await hashPassword(bobPassword)],
    );
    const [alice, bob, admin] = await Promise.all([
      authorize('alice', CUSTOMER_PASSWORD),
      authorize('bob', bobPassword),
      authorize('admin1', ADMIN_PASSWORD),
    ]);
    const event = await createEvent(ctx, { auth: admin });
    const order = await ctx.api().post('/api/orders').set('Authorization', alice)
      .send({ ticketTypeId: event.ticketTypes[0].id, quantity: 1, userId: 'bob' }).expect(201);
    expect(order.body.userId).toBe('alice');

    const path = `/api/orders/${order.body.id}`;
    expect((await ctx.api().get('/api/orders').set('Authorization', bob).expect(200)).body.data).toEqual([]);
    await ctx.api().get(path).set('Authorization', bob).expect(404);
    await ctx.api().post(`${path}/cancel`).set('Authorization', bob).expect(404);
    await ctx.api().get(path).set('Authorization', alice).expect(200);
    const cancelled = await ctx.api().post(`${path}/cancel`).set('Authorization', alice).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelledBy: 'alice' });
  });
});
