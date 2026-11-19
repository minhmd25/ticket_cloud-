import type { OrderEventMessage } from './message';

/**
 * MẪU THÔNG ĐIỆP AZURE (do người làm Azure quy định - xem docs/azure-message-contract.md).
 * 7 trường bắt buộc ở cấp ngoài cùng; trường thêm được Azure bỏ qua.
 */
export interface AzureTicketMessage {
  messageId: string; // = id dòng outbox, CỐ ĐỊNH khi gửi lại
  type: 'BOOKED' | 'CANCELLED';
  orderId: string;
  eventId: string;
  ticketTierId: string; // = id hạng vé (UUID)
  quantity: number; // số nguyên > 0
  occurredAt: string; // ISO-8601 CÓ múi giờ
  // Không gửi trường thêm: Azure xác nhận bỏ qua, không lưu (tên hạng vé lấy từ DB GCP theo ticketTierId).
}

const TYPE_MAP: Record<OrderEventMessage['type'], AzureTicketMessage['type']> = {
  ORDER_CREATED: 'BOOKED',
  ORDER_CANCELLED: 'CANCELLED',
};

/**
 * Chuyển thông điệp nội bộ (lưu trong outbox) sang mẫu của Azure.
 * Ánh xạ diễn ra LÚC GỬI => các dòng outbox cũ cũng gửi đúng mẫu, đổi mẫu chỉ sửa ở đây.
 */
export function toAzureMessage(msg: OrderEventMessage): AzureTicketMessage {
  const d = msg.data ?? ({} as OrderEventMessage['data']);
  return {
    messageId: msg.messageId,
    type: TYPE_MAP[msg.type] ?? (msg.type as never),
    orderId: d.orderId,
    eventId: d.eventId,
    ticketTierId: d.ticketTypeId,
    quantity: d.quantity,
    occurredAt: msg.occurredAt,
  };
}

// ---------------------------------------------------------------------------
// VALIDATOR - chuyển nguyên logic từ validator/validate-message.js của người làm Azure.
// Nguyên tắc: CHẶT HƠN hoặc BẰNG Azure, không bao giờ lỏng hơn
// (kiểm chứng bằng tests/fixtures/azure-message-vectors.json - sinh từ bộ kiểm tra thật của Azure).
// ---------------------------------------------------------------------------
const VALID_TYPES = new Set(['BOOKED', 'CANCELLED']);
const REQUIRED = ['messageId', 'type', 'orderId', 'eventId', 'ticketTierId', 'quantity', 'occurredAt'] as const;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\#?\u0000-\u001f]/;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function checkOccurredAt(v: unknown): string | null {
  if (typeof v !== 'string') return "'occurredAt' must be an ISO-8601 string";
  const m = ISO.exec(v);
  if (!m) return "'occurredAt' must look like 2026-11-12T10:15:30+07:00 (T separator, timezone offset REQUIRED: +07:00 or Z)";
  const [, Y, Mo, D, H, Mi, S, , , offH, offM] = m;
  const y = +Y, mo = +Mo, d = +D, h = +H, mi = +Mi, s = S === undefined ? 0 : +S;
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return "'occurredAt' is not a real calendar date";
  if (h > 23 || mi > 59 || s > 59) return "'occurredAt' has an impossible time";
  if (offH !== undefined && (+offH > 23 || +offM > 59)) return "'occurredAt' has an impossible timezone offset";
  return null;
}

function checkKey(name: string, v: string): string | null {
  if (Array.from(v).length > 200) return `'${name}' is too long (max 200 chars)`;
  if (FORBIDDEN.test(v)) return `'${name}' must not contain / \\ # ? or control characters`;
  return null;
}

export type ValidationResult = { ok: true } | { ok: false; error: string };

export function validateAzureMessage(msg: unknown): ValidationResult {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, error: 'message must be a JSON object' };
  const m = msg as Record<string, unknown>;

  const missing = REQUIRED.filter((f) => m[f] === undefined || m[f] === null || m[f] === '');
  if (missing.length) return { ok: false, error: `missing required fields: ${missing.join(', ')}` };

  if (typeof m.type !== 'string' || !VALID_TYPES.has(m.type)) {
    return { ok: false, error: `'type' must be BOOKED or CANCELLED, got ${JSON.stringify(m.type)}` };
  }
  const q = m.quantity;
  if (typeof q !== 'number' || !Number.isInteger(q) || q <= 0) {
    return { ok: false, error: "'quantity' must be a positive integer (number, not text)" };
  }
  for (const f of ['messageId', 'orderId', 'eventId', 'ticketTierId']) {
    if (typeof m[f] !== 'string') return { ok: false, error: `'${f}' must be a string` };
  }
  for (const f of ['messageId', 'eventId']) {
    const e = checkKey(f, m[f] as string);
    if (e) return { ok: false, error: e };
  }
  const e = checkOccurredAt(m.occurredAt);
  if (e) return { ok: false, error: e };
  return { ok: true };
}
