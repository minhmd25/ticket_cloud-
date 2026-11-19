import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublishError } from '../src/outbox/publisher';
import { backoffMs } from '../src/outbox/worker';
import { ADMIN, ALICE, book, createEvent, setupTestApp } from './helpers';

const ctx = setupTestApp();

const outboxRows = async () =>
  (await ctx.db.query('SELECT * FROM outbox_events ORDER BY seq')).rows as Array<Record<string, any>>;

describe('Outbox: lưu & gửi sự kiện đặt/hủy sang Azure', () => {
  it('đặt và hủy ghi sự kiện vào outbox cùng giao dịch, đúng mẫu thông điệp', async () => {
    const ev = await createEvent(ctx, { category: 'sport', ticketTypes: [{ name: 'A', price: 200000, totalQuantity: 10 }] });
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 2);
    await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE).send({ reason: 'test' });

    const rows = await outboxRows();
    expect(rows.map((r) => r.event_type)).toEqual(['ORDER_CREATED', 'ORDER_CANCELLED']);
    expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
    expect(rows[0].payload).toMatchObject({
      messageId: rows[0].id,
      type: 'ORDER_CREATED',
      version: 1,
      source: 'gcp-ticketing',
      data: { orderId: o.body.id, userId: 'alice', eventId: ev.id, eventCategory: 'sport', quantity: 2, unitPrice: 200000, totalAmount: 400000, currency: 'VND', status: 'CONFIRMED' },
    });
    expect(rows[1].payload.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'test' });
    expect(rows[1].payload.data.cancelledAt).toBeTruthy();
  });

  it('worker gửi theo đúng thứ tự và đánh dấu SENT', async () => {
    const ev = await createEvent(ctx);
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);

    // lượt 1 chỉ gửi ORDER_CREATED; ORDER_CANCELLED phải chờ CREATED được SENT
    expect(await ctx.services.dispatcher.dispatchOnce()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(await ctx.services.dispatcher.dispatchOnce()).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(ctx.publisher.sent.map((m) => m.type)).toEqual(['BOOKED', 'CANCELLED']);
    expect((await outboxRows()).every((x) => x.status === 'SENT' && x.sent_at && x.sent_via === 'mock')).toBe(true);

    // chạy lại không gửi trùng
    expect((await ctx.services.dispatcher.dispatchOnce()).claimed).toBe(0);
  });

  it('GỬI THẤT BẠI: đơn vẫn thành công, sự kiện giữ PENDING, hẹn thử lại (backoff); Azure hồi phục => gửi được', async () => {
    ctx.publisher.fail = true;
    const ev = await createEvent(ctx);
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    expect(o.status).toBe(201); // đặt vé KHÔNG phụ thuộc Azure

    const r1 = await ctx.services.dispatcher.dispatchOnce();
    expect(r1).toEqual({ claimed: 1, sent: 0, failed: 1 });
    let [row] = await outboxRows();
    expect(row).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(row.last_error).toContain('Azure');
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + backoffMs(1) - 2000);

    // chưa tới hạn thử lại => không lấy
    expect((await ctx.services.dispatcher.dispatchOnce()).claimed).toBe(0);

    // Azure hồi phục, tới hạn thử lại
    ctx.publisher.fail = false;
    await ctx.db.query(`UPDATE outbox_events SET next_attempt_at = now()`);
    const r2 = await ctx.services.dispatcher.dispatchOnce();
    expect(r2.sent).toBe(1);
    [row] = await outboxRows();
    expect(row).toMatchObject({ status: 'SENT', attempts: 2, last_error: null });
    expect(ctx.publisher.sent).toHaveLength(1);
  });

  it('không gửi ORDER_CANCELLED khi ORDER_CREATED của cùng đơn chưa gửi được', async () => {
    const ev = await createEvent(ctx);
    const o = await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    ctx.publisher.fail = true;
    await ctx.services.dispatcher.dispatchOnce(); // CREATED lỗi -> chờ backoff
    ctx.publisher.fail = false;
    await ctx.api().post(`/api/orders/${o.body.id}/cancel`).set('Authorization', ALICE);

    const r = await ctx.services.dispatcher.dispatchOnce();
    expect(r.claimed).toBe(0); // CANCELLED bị chặn vì CREATED chưa SENT
    expect(ctx.publisher.sent).toHaveLength(0);

    await ctx.db.query(`UPDATE outbox_events SET next_attempt_at = now()`);
    await ctx.services.dispatcher.dispatchOnce();
    await ctx.services.dispatcher.dispatchOnce();
    expect(ctx.publisher.sent.map((m) => m.type)).toEqual(['BOOKED', 'CANCELLED']);
  });

  it('quá số lần thử => FAILED; admin xem và gửi lại qua API', async () => {
    ctx.publisher.fail = true;
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    for (let i = 0; i < 3; i++) {
      await ctx.db.query(`UPDATE outbox_events SET next_attempt_at = now()`);
      await ctx.services.dispatcher.dispatchOnce();
    }
    let [row] = await outboxRows();
    expect(row).toMatchObject({ status: 'FAILED', attempts: 3 });

    const stats = await ctx.api().get('/api/admin/outbox/stats').set('Authorization', ADMIN);
    expect(stats.body.FAILED.count).toBe(1);
    const list = await ctx.api().get('/api/admin/outbox?status=FAILED').set('Authorization', ADMIN);
    expect(list.body.data[0]).toMatchObject({ id: row.id, type: 'ORDER_CREATED', status: 'FAILED' });

    ctx.publisher.fail = false;
    const retry = await ctx.api().post('/api/admin/outbox/retry').set('Authorization', ADMIN).send({ ids: [row.id] });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ requeued: 1, sent: 1 });
    [row] = await outboxRows();
    expect(row.status).toBe('SENT');

    expect((await ctx.api().post('/api/admin/outbox/retry').set('Authorization', ALICE)).status).toBe(403);
  });

  it('hai worker chạy song song không gửi trùng', async () => {
    const ev = await createEvent(ctx, { ticketTypes: [{ name: 'A', price: 1, totalQuantity: 100 }] });
    for (let i = 0; i < 20; i++) await book(ctx, `Bearer mock:w${i}:customer`, ev.ticketTypes[0].id, 1);
    const [a, b, c] = await Promise.all([
      ctx.services.dispatcher.dispatchOnce(),
      ctx.services.dispatcher.dispatchOnce(),
      ctx.services.dispatcher.dispatchOnce(),
    ]);
    expect(a.sent + b.sent + c.sent).toBe(20);
    expect(new Set(ctx.publisher.sent.map((m) => m.messageId)).size).toBe(20);
  });

  it('thông điệp SAI MẪU => FAILED ngay lần đầu (không gửi, không thử lại), ghi rõ lỗi', async () => {
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    // làm hỏng payload (giả lập lỗi dữ liệu): quantity = 0
    await ctx.db.query(`UPDATE outbox_events SET payload = jsonb_set(payload, '{data,quantity}', '0')`);
    const r = await ctx.services.dispatcher.dispatchOnce();
    expect(r).toEqual({ claimed: 1, sent: 0, failed: 1 });
    const [row] = await outboxRows();
    expect(row).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect(row.last_error).toContain("INVALID_MESSAGE: 'quantity' must be a positive integer");
    expect(ctx.publisher.sent).toHaveLength(0);
  });

  it('messageId gửi sang Azure = id dòng outbox, không đổi qua các lần thử lại', async () => {
    ctx.publisher.fail = true;
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    await ctx.services.dispatcher.dispatchOnce();
    ctx.publisher.fail = false;
    await ctx.db.query(`UPDATE outbox_events SET next_attempt_at = now()`);
    await ctx.services.dispatcher.dispatchOnce();
    const [row] = await outboxRows();
    expect(ctx.publisher.sent.map((m) => m.messageId)).toEqual([row.id]);
  });
});

describe('Outbox: lease và mã nhận việc (claim_token)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Chặn lần publish đầu tiên cho tới khi gọi open() */
  const blockFirstPublish = (thenFail = false) => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const state = { calls: 0 };
    const orig = ctx.publisher.publish.bind(ctx.publisher);
    vi.spyOn(ctx.publisher, 'publish').mockImplementation(async (m) => {
      state.calls++;
      if (state.calls === 1) {
        await gate;
        if (thenFail) throw new PublishError('Azure chậm (giả lập)', true);
      }
      return orig(m);
    });
    return { open, state };
  };
  const waitUntil = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('bấm "Gửi lại" trong lúc worker đang gửi: không đụng dòng đang gửi, không gửi trùng', async () => {
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    const block = blockFirstPublish();
    const running = ctx.services.dispatcher.dispatchOnce();
    await waitUntil(() => block.state.calls === 1);

    const [row] = await outboxRows();
    expect(row.claim_token).toBeTruthy();
    expect(new Date(row.locked_until).getTime() - Date.now()).toBeGreaterThan(50_000); // leaseMs = 60s

    const retry = await ctx.api().post('/api/admin/outbox/retry').set('Authorization', ADMIN).send({ ids: [row.id] });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ requeued: 0, claimed: 0 });
    expect(await ctx.services.outboxAdmin.requeue()).toBe(0); // gửi lại "tất cả" cũng bỏ qua dòng đang gửi

    block.open();
    expect(await running).toEqual({ claimed: 1, sent: 1, failed: 0 });
    expect(block.state.calls).toBe(1);
    expect(ctx.publisher.sent).toHaveLength(1);
    expect((await outboxRows())[0]).toMatchObject({ status: 'SENT', attempts: 1, claim_token: null, locked_until: null });
  });

  it('lease hết hạn, lượt khác đã gửi xong: kết quả lỗi đến muộn của lượt cũ không ghi đè SENT', async () => {
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    const block = blockFirstPublish(true);
    const slow = ctx.services.dispatcher.dispatchOnce();
    await waitUntil(() => block.state.calls === 1);

    await ctx.db.query(`UPDATE outbox_events SET locked_until = now() - interval '1 second'`); // giả lập lease hết hạn
    expect(await ctx.services.dispatcher.dispatchOnce()).toEqual({ claimed: 1, sent: 1, failed: 0 });

    block.open();
    expect(await slow).toEqual({ claimed: 1, sent: 0, failed: 1 });
    const [row] = await outboxRows();
    expect(row).toMatchObject({ status: 'SENT', attempts: 2, last_error: null, claim_token: null });
    expect(ctx.publisher.sent).toHaveLength(1);
  });

  it('FAILED vẫn gửi lại được qua API khi worker không giữ dòng', async () => {
    ctx.publisher.fail = true;
    const ev = await createEvent(ctx);
    await book(ctx, ALICE, ev.ticketTypes[0].id, 1);
    await ctx.db.query(`UPDATE outbox_events SET status = 'FAILED', attempts = 3`);
    ctx.publisher.fail = false;
    const retry = await ctx.api().post('/api/admin/outbox/retry').set('Authorization', ADMIN).send({});
    expect(retry.body).toMatchObject({ requeued: 1, sent: 1 });
  });
});
