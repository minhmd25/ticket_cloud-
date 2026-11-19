/**
 * Log có cấu trúc: một dòng JSON mỗi sự kiện, Cloud Logging tự đọc `severity` và các trường.
 * CHỈ truyền vào status và các ID cần đối chiếu. Không bao giờ truyền URL kèm SAS,
 * function key, JWT hay header Authorization.
 */
export function logInfo(event: string, fields: Record<string, string | number | boolean | undefined>): void {
  console.log(JSON.stringify({ severity: 'INFO', event, ...fields }));
}
