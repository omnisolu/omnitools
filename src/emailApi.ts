import type { ExpenseLine, HeaderInfo, SmtpSettings } from "./types";
import type { ExpenseLineRecord, ReimbursementRecord } from "./records";

function apiUrl(path: string): string {
  const base = (import.meta.env.VITE_EMAIL_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";
  return base ? `${base}${path}` : path;
}

/** 普通 API（避免邮件服务未启动时长时间卡在「加载中」） */
const FETCH_TIMEOUT_MS = 15_000;
/** 上传 PDF / 多附件 */
const FETCH_UPLOAD_TIMEOUT_MS = 120_000;
/** 测试发信（SMTP 握手可能较慢） */
const FETCH_SMTP_TEST_TIMEOUT_MS = 60_000;

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

function timeoutErrorMessage(seconds: number, what: string): string {
  return `${what}在 ${seconds} 秒内无响应（已超时）。请确认：开发环境已运行「npm run dev」（含端口 3001 邮件 API）；生产环境已执行 systemctl start omnitools-email，且 Nginx 将 /api/ 反代到 127.0.0.1:3001。`;
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  what: string
): Promise<Response> {
  const controller = new AbortController();
  const id = window.setTimeout(() => controller.abort(), timeoutMs);
  const merged: RequestInit = { ...init, signal: controller.signal };
  try {
    return await fetch(input, merged);
  } catch (e) {
    if (isAbortError(e)) {
      throw new Error(timeoutErrorMessage(Math.round(timeoutMs / 1000), what));
    }
    throw e;
  } finally {
    window.clearTimeout(id);
  }
}

function parseErrorMessage(body: string): string {
  const text = body?.trim();
  if (!text) {
    return "请求失败";
  }

  if (text.startsWith("<")) {
    if (/502 Bad Gateway/i.test(text)) {
      return "后端 API（omnitools-email，同一进程处理报销提交与邮件等）返回 502（无法连接上游）。请检查：1) sudo systemctl status omnitools-email  2) curl -sS http://127.0.0.1:3001/api/health 是否返回 JSON。";
    }
    if (/504 Gateway Time-out/i.test(text) || /gateway timeout/i.test(text)) {
      return "后端 API 请求超时（Nginx 在时限内未收到 Node 响应；保存提交走 /api/submit-reimbursement，与发邮件同属该服务）。请检查：1) sudo journalctl -u omnitools-email -n 50  2) 本机 curl http://127.0.0.1:3001/api/health  3) Nginx 中 location /api/ 是否 proxy_pass 到 127.0.0.1:3001。";
    }
    return "后端 API 返回 HTML 错误页面，请检查 omnitools-email 或代理配置。";
  }

  try {
    const j = JSON.parse(body) as { error?: string };
    return j.error || body;
  } catch {
    return body || "请求失败";
  }
}

function parseJsonOrThrow<T>(text: string, context: string): T {
  const t = text.trim();
  if (!t) {
    throw new Error(`${context}：服务器返回空内容。`);
  }
  if (t.startsWith("<!") || t.startsWith("<html") || t.startsWith("<HTML")) {
    throw new Error(
      `${context}：收到 HTML 而非 JSON。通常表示 Nginx 未把 /api 转发到 Node，或把请求交给了 SPA。请确认站点中 location /api/ 在 location / 之前，且 proxy_pass 指向 127.0.0.1:3001。`
    );
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new Error(`${context}：响应不是合法 JSON。请确认 omnitools-email 已启动且 /api 反代正确。`);
  }
}

/** 联调/排错：仅确认 Node 进程响应，不访问业务表 */
export async function getEmailApiHealth(): Promise<{ ok: boolean; service?: string }> {
  const res = await fetchWithTimeout(apiUrl("/api/health"), undefined, FETCH_TIMEOUT_MS, "检查邮件 API");
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  return parseJsonOrThrow<{ ok: boolean; service?: string }>(text, "检查邮件 API");
}

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const res = await fetchWithTimeout(apiUrl("/api/smtp"), undefined, FETCH_TIMEOUT_MS, "加载 SMTP 配置");
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  return parseJsonOrThrow<SmtpSettings | null>(text, "加载 SMTP 配置");
}

export async function saveSmtpSettings(smtp: SmtpSettings): Promise<void> {
  const res = await fetchWithTimeout(
    apiUrl("/api/smtp"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(smtp),
    },
    FETCH_TIMEOUT_MS,
    "保存 SMTP 配置"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}

export interface SubmitReimbursementManifest {
  header: HeaderInfo;
  cashAdvance: number;
  managerName: string;
  businessPurpose: string;
  lines: Array<{
    expenseLineId: string;
    date: string;
    description: string;
    category: string;
    lineCurrency: string;
    exchangeRate: number;
    gst: number;
    grossAmount: number;
    attachmentCount: number;
  }>;
}

export async function submitExpenseReimbursementToServer(options: {
  pdfBytes: Uint8Array;
  expenses: ExpenseLine[];
  manifest: SubmitReimbursementManifest;
}): Promise<{ reimbursementId: string }> {
  const { pdfBytes, expenses, manifest } = options;
  const form = new FormData();
  form.append(
    "pdf",
    new Blob([pdfBytes as BlobPart], { type: "application/pdf" }),
    "merged.pdf"
  );
  form.append("manifest", JSON.stringify(manifest));
  for (const e of expenses) {
    for (const f of e.files) {
      form.append("attachments", f, f.name);
    }
  }
  const res = await fetchWithTimeout(
    apiUrl("/api/submit-reimbursement"),
    {
      method: "POST",
      body: form,
    },
    FETCH_UPLOAD_TIMEOUT_MS,
    "提交报销"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = parseJsonOrThrow<{ reimbursementId?: string }>(text, "提交报销");
  if (!j.reimbursementId) {
    throw new Error("服务器未返回报销编号。");
  }
  return { reimbursementId: j.reimbursementId };
}

export async function fetchReimbursementsFromServer(): Promise<
  Array<{ reimbursement: ReimbursementRecord; expenses: ExpenseLineRecord[] }>
> {
  const res = await fetchWithTimeout(
    apiUrl("/api/reimbursements"),
    undefined,
    FETCH_TIMEOUT_MS,
    "加载报销记录"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = parseJsonOrThrow<{
    ok?: boolean;
    data?: Array<{ reimbursement: ReimbursementRecord; expenses: ExpenseLineRecord[] }>;
  }>(text, "加载报销记录");
  if (!j.data) {
    throw new Error("服务器未返回报销列表。");
  }
  return j.data;
}

export async function sendExpensePdfEmail(options: {
  smtp: SmtpSettings;
  to: string;
  pdfBytes: Uint8Array;
  filename: string;
  subject: string;
}): Promise<void> {
  const { smtp, to, pdfBytes, filename, subject } = options;
  const form = new FormData();
  form.append("to", to);
  form.append("subject", subject);
  form.append("filename", filename);
  form.append("smtp", JSON.stringify(smtp));
  form.append("pdf", new Blob([pdfBytes as BlobPart], { type: "application/pdf" }), filename);

  const res = await fetchWithTimeout(
    apiUrl("/api/send-expense-pdf"),
    {
      method: "POST",
      body: form,
    },
    FETCH_UPLOAD_TIMEOUT_MS,
    "发送报销 PDF 邮件"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}

export async function sendSmtpTestEmail(smtp: SmtpSettings): Promise<void> {
  const res = await fetchWithTimeout(
    apiUrl("/api/test-smtp"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(smtp),
    },
    FETCH_SMTP_TEST_TIMEOUT_MS,
    "SMTP 测试发信"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}
