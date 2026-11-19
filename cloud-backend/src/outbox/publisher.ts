import { AnonymousCredential, QueueClient } from '@azure/storage-queue';
import type { Config } from '../config';
import { logInfo } from '../lib/log';
import { toAzureMessage, validateAzureMessage, type AzureTicketMessage } from './azureMessage';
import type { OrderEventMessage } from './message';

/** Kênh gửi sự kiện sang Azure. Ném PublishError nếu thất bại (worker quyết định thử lại hay FAILED). */
export interface EventPublisher {
  readonly name: string;
  publish(msg: OrderEventMessage): Promise<void>;
}

export class PublishError extends Error {
  constructor(message: string, public readonly retryable = true) {
    super(message);
  }
}

/** Che phần chữ ký SAS nếu lỡ lọt vào thông báo lỗi / log */
export function redactSecrets(s: string): string {
  return s.replace(/([?&]sig=)[^&\s"']+/gi, '$1***');
}

/**
 * Chuyển sang mẫu Azure và KIỂM TRA TRƯỚC KHI GỬI.
 * Queue trả 201 cho MỌI nội dung, nên thông điệp sai mẫu phải bị chặn ở đây
 * (=> FAILED ngay, không thử lại) thay vì "gửi thành công" rồi rơi vào ticket-events-poison.
 */
export function prepareAzureMessage(msg: OrderEventMessage): AzureTicketMessage {
  const out = toAzureMessage(msg);
  const v = validateAzureMessage(out);
  if (!v.ok) throw new PublishError(`INVALID_MESSAGE: ${v.error}`, false);
  return out;
}

/** MOCK: kiểm tra mẫu như thật rồi ghi log; bật `fail` để giả lập Azure lỗi. */
export class MockPublisher implements EventPublisher {
  readonly name = 'mock';
  readonly sent: AzureTicketMessage[] = [];
  constructor(public fail = false, private readonly log = false) {}
  async publish(msg: OrderEventMessage): Promise<void> {
    const azureMsg = prepareAzureMessage(msg);
    if (this.fail) throw new PublishError('Mock: Azure không phản hồi (giả lập)');
    this.sent.push(azureMsg);
    if (this.log) console.log(`[outbox:mock] -> Azure ${azureMsg.type} order=${azureMsg.orderId} messageId=${azureMsg.messageId}`);
  }
}

/**
 * AZURE STORAGE QUEUE "ticket-events" qua SAS URL (quyền chỉ GHI).
 *  - Dùng thư viện chính thức @azure/storage-queue: tự bọc XML + escape & < ; nội dung là JSON thô, KHÔNG base64.
 *  - Tắt retry nội bộ của SDK (maxTries=1): việc thử lại do outbox đảm nhiệm, giữ nguyên messageId.
 *  - 400/413 (yêu cầu sai, thông điệp quá lớn) => không thử lại. 401/403 (SAS sai/hết hạn), 5xx, lỗi mạng => thử lại
 *    theo backoff; sau khi thay SAS mới, sự kiện tự đi tiếp hoặc admin bấm "gửi lại".
 */
export class AzureQueuePublisher implements EventPublisher {
  readonly name = 'azure-queue';
  private readonly client: QueueClient;

  constructor(sasUrl: string, timeoutMs: number) {
    if (!sasUrl) throw new Error('PUBLISHER_MODE=azure-queue cần AZURE_QUEUE_SAS_URL');
    this.client = new QueueClient(normalizeQueueUrl(sasUrl), new AnonymousCredential(), {
      retryOptions: { maxTries: 1, tryTimeoutInMs: timeoutMs },
    });
  }

  async publish(msg: OrderEventMessage): Promise<void> {
    const azureMsg = prepareAzureMessage(msg);
    let httpStatus: number;
    try {
      const res = await this.client.sendMessage(JSON.stringify(azureMsg));
      httpStatus = res._response.status;
    } catch (err) {
      const e = err as Error & { statusCode?: number; code?: string };
      const status = e.statusCode;
      const hint = status === 401 || status === 403 ? ' (SAS token sai hoặc đã hết hạn?)' : '';
      const detail = redactSecrets(`${status ?? e.code ?? 'NETWORK'}: ${e.message}`).slice(0, 500);
      throw new PublishError(`Azure Queue lỗi ${detail}${hint}`, !(status === 400 || status === 413));
    }
    // minh chứng gửi thành công: status THẬT Azure trả về + các ID để đối chiếu (không có URL/SAS)
    logInfo('azure_queue_send_succeeded', {
      httpStatus,
      eventId: azureMsg.eventId,
      orderId: azureMsg.orderId,
      messageId: azureMsg.messageId,
      messageType: azureMsg.type,
    });
  }
}

/**
 * Người làm Azure đưa URL dạng REST ".../ticket-events/messages?<SAS>".
 * SDK cần URL của queue ".../ticket-events?<SAS>" => bỏ "/messages" nếu có.
 */
export function normalizeQueueUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.pathname = u.pathname.replace(/\/messages\/?$/i, '');
  return u.toString();
}

export function createPublisher(cfg: Config['publisher']): EventPublisher {
  if (cfg.mode === 'azure-queue') return new AzureQueuePublisher(cfg.queueSasUrl, cfg.timeoutMs);
  if (cfg.mode === 'mock') return new MockPublisher(cfg.mockFail, true);
  throw new Error(`PUBLISHER_MODE không hợp lệ: ${cfg.mode} (mock | azure-queue)`);
}
