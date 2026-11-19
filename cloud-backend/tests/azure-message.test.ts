import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toAzureMessage, validateAzureMessage } from '../src/outbox/azureMessage';
import type { OrderEventMessage } from '../src/outbox/message';
import { AzureQueuePublisher, normalizeQueueUrl, PublishError, redactSecrets } from '../src/outbox/publisher';

/** 89 ca do người làm Azure sinh từ bộ kiểm tra THẬT của Azure (logic.parse_message) */
const vectors: Array<{ name: string; message: unknown; azureValid: boolean; azureError: string | null }> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'azure-message-vectors.json'), 'utf8'),
);

const internal = (over: Partial<OrderEventMessage['data']> = {}, type: OrderEventMessage['type'] = 'ORDER_CREATED'): OrderEventMessage => ({
  messageId: '0b7c2a8e-5f1e-4c47-9d6a-2a4f8c1e9b10',
  type,
  version: 1,
  source: 'gcp-ticketing',
  occurredAt: '2026-11-12T03:15:30.123Z',
  data: {
    orderId: '99f4ad2a-605a-4663-bd28-d6add73d247e',
    userId: 'alice',
    eventId: 'cf02fc3f-82a0-4853-82e5-e2bbdcadba6c',
    eventTitle: 'Rock & <Roll>',
    eventCategory: 'concert',
    eventStartTime: '2026-12-11T12:00:00.000Z',
    ticketTypeId: 'b8e01407-37a5-4deb-8917-86992ce23ffa',
    ticketTypeName: 'VIP & <Hàng đầu>',
    quantity: 2,
    unitPrice: 1000,
    totalAmount: 2000,
    currency: 'VND',
    status: 'CONFIRMED',
    orderCreatedAt: '2026-11-12T03:15:30.000Z',
    cancelledAt: null,
    cancelReason: null,
    ...over,
  },
});

describe('Validator thông điệp Azure', () => {
  it(`khớp ${vectors.length} ca của Azure: KHÔNG có ca nào "mình nhận - Azure từ chối"`, () => {
    const unsafe = vectors.filter((v) => validateAzureMessage(v.message).ok && !v.azureValid);
    const stricter = vectors.filter((v) => !validateAzureMessage(v.message).ok && v.azureValid);
    expect(unsafe.map((v) => `${v.name} | azure: ${v.azureError}`)).toEqual([]);
    // Chặt hơn Azure thì chấp nhận được. Đúng 11 ca - GIỐNG HỆT validator JS gốc của người làm Azure
    // (id kiểu số/mảng, occurredAt dạng lạ) - hệ thống không bao giờ sinh ra các dạng này.
    expect(stricter.map((v) => v.name)).toEqual([
      'orderId number', 'messageId number', 'eventId number', 'ticketTierId number', 'orderId list',
      "occurredAt '2026-11-12 10:15:30+07:00'", "occurredAt '2026-11-12T10:15:30+07'", "occurredAt '2026-11-12T10:15:30+0700'",
      "occurredAt '2026-11-12T10:15:30+07:60'", "occurredAt '2026-11-12T10:15:30.1234567+07:00'", "occurredAt '2026-11-12T10:15:30 +07:00'",
    ]);
  });

  it('ánh xạ đúng 7 trường bắt buộc ở cấp ngoài cùng', () => {
    const m = toAzureMessage(internal());
    expect(m).toMatchObject({
      messageId: '0b7c2a8e-5f1e-4c47-9d6a-2a4f8c1e9b10',
      type: 'BOOKED',
      orderId: '99f4ad2a-605a-4663-bd28-d6add73d247e',
      eventId: 'cf02fc3f-82a0-4853-82e5-e2bbdcadba6c',
      ticketTierId: 'b8e01407-37a5-4deb-8917-86992ce23ffa',
      quantity: 2,
      occurredAt: '2026-11-12T03:15:30.123Z',
    });
    expect(validateAzureMessage(m)).toEqual({ ok: true });
    expect(toAzureMessage(internal({}, 'ORDER_CANCELLED')).type).toBe('CANCELLED');
    // không gửi thông tin cá nhân / giá sang Azure
    expect(m).not.toHaveProperty('userId');
    expect(m).not.toHaveProperty('data');
  });
});

describe('AzureQueuePublisher (server Storage Queue giả lập)', () => {
  let server: Server;
  let base = '';
  let status = 201;
  const received: { url: string; contentType?: string; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', contentType: req.headers['content-type'], body });
        if (status !== 201) return void res.writeHead(status, { 'Content-Type': 'application/xml' }).end(`<?xml version="1.0" encoding="utf-8"?><Error><Code>AuthenticationFailed</Code><Message>bad sig</Message></Error>`);
        res.writeHead(201, { 'Content-Type': 'application/xml' }).end(
          `<?xml version="1.0" encoding="utf-8"?><QueueMessagesList><QueueMessage><MessageId>m1</MessageId><InsertionTime>Thu, 12 Nov 2026 03:15:30 GMT</InsertionTime><ExpirationTime>Thu, 19 Nov 2026 03:15:30 GMT</ExpirationTime><PopReceipt>p</PopReceipt><TimeNextVisible>Thu, 12 Nov 2026 03:15:30 GMT</TimeNextVisible></QueueMessage></QueueMessagesList>`,
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/devaccount/ticket-events`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const SAS = 'sv=2025-01-01&sp=a&se=2026-12-15&sig=SuPeRsEcReT%3D';

  it('gửi JSON thô (không base64) bọc trong XML, & và < được escape, đúng đường dẫn /messages', async () => {
    status = 201;
    received.length = 0;
    // dán nguyên URL dạng REST ".../messages?<SAS>" cũng được
    const pub = new AzureQueuePublisher(`${base}/messages?${SAS}`, 2000);
    // ticketTierId không bị Azure giới hạn ký tự -> dùng để kiểm tra escape XML
    await pub.publish(internal({ ticketTypeId: 'tier & <x>' }));
    expect(received).toHaveLength(1);
    expect(received[0].url).toMatch(/^\/devaccount\/ticket-events\/messages\?/);
    const m = /<MessageText>([\s\S]*)<\/MessageText>/.exec(received[0].body);
    expect(m).not.toBeNull();
    const xmlText = m![1];
    expect(xmlText).not.toContain('<x>'); // < đã được escape
    const unescaped = xmlText.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const sent = JSON.parse(unescaped); // => JSON thô, không phải base64
    expect(sent).toEqual({
      messageId: '0b7c2a8e-5f1e-4c47-9d6a-2a4f8c1e9b10', type: 'BOOKED', orderId: '99f4ad2a-605a-4663-bd28-d6add73d247e',
      eventId: 'cf02fc3f-82a0-4853-82e5-e2bbdcadba6c', ticketTierId: 'tier & <x>', quantity: 2, occurredAt: '2026-11-12T03:15:30.123Z',
    }); // đúng 7 trường, không thừa
    expect(validateAzureMessage(sent)).toEqual({ ok: true });
  });

  it('gửi lại giữ NGUYÊN messageId', async () => {
    status = 201;
    received.length = 0;
    const pub = new AzureQueuePublisher(`${base}?${SAS}`, 2000);
    await pub.publish(internal());
    await pub.publish(internal());
    const ids = received.map((r) => /messageId(?:"|&quot;):(?:"|&quot;)([0-9a-f-]+)/.exec(r.body)![1]);
    expect(ids[0]).toBe(ids[1]);
  });

  it('thông điệp sai mẫu bị chặn TRƯỚC khi gửi (không thử lại); SAS hỏng => lỗi thử lại được, không lộ chữ ký', async () => {
    received.length = 0;
    const pub = new AzureQueuePublisher(`${base}?${SAS}`, 2000);
    const bad = await pub.publish(internal({ quantity: 0 })).catch((e) => e);
    expect(bad).toBeInstanceOf(PublishError);
    expect(bad.retryable).toBe(false);
    expect(bad.message).toContain('INVALID_MESSAGE');
    expect(received).toHaveLength(0);

    status = 403;
    const denied = await pub.publish(internal()).catch((e) => e);
    expect(denied).toBeInstanceOf(PublishError);
    expect(denied.retryable).toBe(true);
    expect(denied.message).toContain('403');
    expect(denied.message).not.toContain('SuPeRsEcReT');

    const down = await new AzureQueuePublisher(`http://127.0.0.1:1/devaccount/ticket-events?${SAS}`, 1000).publish(internal()).catch((e) => e);
    expect(down.retryable).toBe(true);
  });

  it('log minh chứng: một dòng JSON với status 201 THẬT và các ID; không có SAS; lỗi thì không ghi "succeeded"', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      status = 201;
      const pub = new AzureQueuePublisher(`${base}?${SAS}`, 2000);
      await pub.publish(internal({}, 'ORDER_CANCELLED'));
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      expect(JSON.parse(line)).toEqual({
        severity: 'INFO',
        event: 'azure_queue_send_succeeded',
        httpStatus: 201,
        eventId: 'cf02fc3f-82a0-4853-82e5-e2bbdcadba6c',
        orderId: '99f4ad2a-605a-4663-bd28-d6add73d247e',
        messageId: '0b7c2a8e-5f1e-4c47-9d6a-2a4f8c1e9b10',
        messageType: 'CANCELLED',
      });
      expect(line).not.toMatch(/SuPeRsEcReT|sig=|sv=|127\.0\.0\.1/);

      spy.mockClear();
      status = 403;
      await pub.publish(internal()).catch(() => undefined);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      status = 201;
    }
  });

  it('chuẩn hóa URL và che SAS', () => {
    expect(normalizeQueueUrl('https://acc.queue.core.windows.net/ticket-events/messages?sv=1&sig=x')).toBe('https://acc.queue.core.windows.net/ticket-events?sv=1&sig=x');
    expect(redactSecrets('GET https://a/q?sv=1&sig=abc%3D&se=2')).toBe('GET https://a/q?sv=1&sig=***&se=2');
  });
});
