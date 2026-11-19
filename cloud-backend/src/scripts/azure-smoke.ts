import { randomUUID } from 'node:crypto';
import { AnonymousCredential, QueueClient } from '@azure/storage-queue';
import { config } from '../config';
import { validateAzureMessage, type AzureTicketMessage } from '../outbox/azureMessage';
import { normalizeQueueUrl, redactSecrets } from '../outbox/publisher';

/**
 * Chạy thử kết nối Azure THẬT (cần AZURE_QUEUE_SAS_URL, AZURE_STATS_URL, AZURE_STATS_KEY trong .env):
 *   npm run azure:smoke
 * 1. Gửi 1 thông điệp BOOKED (eventId = "SMOKE-TEST", quantity = 1) vào queue -> kỳ vọng 201
 * 2. Gửi LẠI đúng thông điệp đó (cùng messageId) -> Azure phải bỏ qua (chống trùng)
 * 3. Hỏi /history?orderId=... mỗi 15s (tối đa 3 phút) tới khi thấy messageId -> Azure đã xử lý
 * 4. In /stats?groupBy=event&eventId=SMOKE-TEST -> bookedTickets phải là 1 (không phải 2)
 * Dữ liệu thử nằm riêng ở sự kiện "SMOKE-TEST", không lẫn vào sự kiện thật.
 */
async function main() {
  const { queueSasUrl } = config.publisher;
  const { url: statsUrl, key: statsKey } = config.stats;
  if (!queueSasUrl) throw new Error('Thiếu AZURE_QUEUE_SAS_URL trong .env');

  const orderId = `SMOKE-${Date.now()}`;
  const msg: AzureTicketMessage = {
    messageId: randomUUID(),
    type: 'BOOKED',
    orderId,
    eventId: 'SMOKE-TEST',
    ticketTierId: 'SMOKE-TIER',
    quantity: 1,
    occurredAt: new Date().toISOString(),
  };
  const v = validateAzureMessage(msg);
  if (!v.ok) throw new Error(`Thông điệp thử không hợp lệ: ${v.error}`);

  const queue = new QueueClient(normalizeQueueUrl(queueSasUrl), new AnonymousCredential(), { retryOptions: { maxTries: 1 } });
  console.log('Gửi:', JSON.stringify(msg));
  for (const label of ['lần 1', 'lần 2 (gửi lại, cùng messageId)']) {
    try {
      const r = await queue.sendMessage(JSON.stringify(msg));
      console.log(`  ${label}: HTTP ${r._response.status} (messageId queue: ${r.messageId})`);
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      throw new Error(`Gửi ${label} thất bại: ${e.statusCode ?? ''} ${redactSecrets(e.message)}`);
    }
  }

  if (!statsUrl || !statsKey) {
    console.log('\nThiếu AZURE_STATS_URL / AZURE_STATS_KEY nên bỏ qua bước kiểm tra /history và /stats.');
    return;
  }
  const get = async (path: string) => {
    const res = await fetch(statsUrl.replace(/\/$/, '') + path, { headers: { 'x-functions-key': statsKey }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    return { status: res.status, text };
  };

  console.log(`\nChờ Azure xử lý (thường 1-2 phút), hỏi /history?orderId=${orderId} mỗi 15s...`);
  const deadline = Date.now() + 3 * 60_000;
  let found = false;
  while (Date.now() < deadline) {
    const h = await get(`/history?${new URLSearchParams({ orderId })}`);
    if (h.status !== 200) console.log(`  /history trả ${h.status}: ${h.text.slice(0, 200)}`);
    if (h.text.includes(msg.messageId)) {
      found = true;
      console.log(`  ✔ Azure đã xử lý messageId ${msg.messageId}`);
      console.log(`  history: ${h.text.slice(0, 500)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 15_000));
    process.stdout.write('  ...\n');
  }
  if (!found) console.log('  ✘ Sau 3 phút vẫn chưa thấy trong /history. Có thể thông điệp vào ticket-events-poison - nhờ bên Azure kiểm tra.');

  const s = await get('/stats?groupBy=event&eventId=SMOKE-TEST');
  console.log(`\n/stats?groupBy=event&eventId=SMOKE-TEST -> ${s.status}: ${s.text.slice(0, 500)}`);
  console.log('(bookedTickets tăng đúng 1 dù đã gửi 2 lần => chống trùng hoạt động. Mỗi lần chạy script cộng thêm 1.)');
}

main().catch((err) => {
  console.error('LỖI:', redactSecrets(String(err?.message ?? err)));
  process.exit(1);
});
