/** 付款方式：纯文本，禁止易被当作 HTML/脚本 的字符 */
export const PAYMENT_METHOD_MAX_LEN = 100;

/**
 * 去除控制字符、尖括号与反引号，合并空白，截断长度。
 * 用于输入框 onChange 与提交前再次规范化。
 */
export function sanitizePaymentMethodInput(raw: string): string {
  let s = String(raw ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[<>]/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > PAYMENT_METHOD_MAX_LEN) s = s.slice(0, PAYMENT_METHOD_MAX_LEN);
  return s;
}
