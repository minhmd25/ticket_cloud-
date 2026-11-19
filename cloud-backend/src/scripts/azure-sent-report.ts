import { config } from '../config';
import { createPool } from '../db';

/**
 * Liệt kê CHÍNH XÁC những thông điệp đã thật sự tới Azure (sent_via = 'azure-queue'),
 * để gửi cho người làm Azure xóa dữ liệu thử trước buổi demo.
 *   npm run azure:report            -> in bảng Markdown (dán thẳng vào tin nhắn)
 *   npm run azure:report -- --json  -> in JSON (nếu bên Azure muốn xóa bằng script)
 * Thông điệp của smoke test (npm run azure:smoke) không đi qua outbox -> đều có eventId "SMOKE-TEST".
 */
async function main() {
  const asJson = process.argv.includes('--json');
  const db = createPool(config.databaseUrl);
  try {
    const r = await db.query(
      `SELECT id AS message_id, event_type, aggregate_id AS order_id, payload->'data'->>'eventId' AS event_id,
              payload->'data'->>'eventTitle' AS event_title, payload->'data'->>'quantity' AS quantity, sent_at
         FROM outbox_events WHERE sent_via = 'azure-queue' ORDER BY seq`,
    );
    const pending = await db.query(`SELECT count(*)::int AS n FROM outbox_events WHERE status IN ('PENDING','FAILED')`);
    const rows = r.rows.map((x) => ({
      messageId: x.message_id,
      type: x.event_type === 'ORDER_CREATED' ? 'BOOKED' : 'CANCELLED',
      orderId: x.order_id,
      eventId: x.event_id,
      eventTitle: x.event_title,
      quantity: Number(x.quantity),
      sentAt: new Date(x.sent_at).toISOString(),
    }));

    if (asJson) {
      console.log(JSON.stringify({ smokeEventId: 'SMOKE-TEST', messages: rows }, null, 2));
      return;
    }

    const events = new Map<string, { title: string; messages: number }>();
    for (const m of rows) {
      const e = events.get(m.eventId) ?? { title: m.eventTitle, messages: 0 };
      e.messages++;
      events.set(m.eventId, e);
    }
    const orders = [...new Set(rows.map((m) => m.orderId))];

    console.log('## Dữ liệu thử đã gửi sang Azure\n');
    console.log('1. Toàn bộ dữ liệu của eventId **`SMOKE-TEST`** (smoke test; orderId dạng `SMOKE-...`).');
    if (!rows.length) {
      console.log('2. Không có thông điệp nào khác: outbox chưa gửi gì qua azure-queue.');
    } else {
      console.log(`2. ${rows.length} thông điệp từ backend (${orders.length} đơn, ${events.size} sự kiện):\n`);
      console.log('| eventId | Sự kiện | Số thông điệp |\n|---|---|---|');
      for (const [id, e] of events) console.log(`| \`${id}\` | ${e.title} | ${e.messages} |`);
      console.log('\n| messageId | type | orderId | eventId | quantity | gửi lúc (UTC) |\n|---|---|---|---|---|---|');
      for (const m of rows) console.log(`| \`${m.messageId}\` | ${m.type} | \`${m.orderId}\` | \`${m.eventId}\` | ${m.quantity} | ${m.sentAt} |`);
    }
    if (pending.rows[0].n) {
      console.log(`\n⚠ Còn ${pending.rows[0].n} thông điệp PENDING/FAILED trong outbox. Hãy reset DB (npm run seed -- --reset) trước khi bên Azure xóa, để chúng không được gửi sau đó.`);
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
