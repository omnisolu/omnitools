import type {
  CreateSubscriptionRequest,
  GetSubscriptionsResponse,
  PatchSubscriptionRequest,
  Subscription,
  SubscriptionSingleResponse,
} from "./subscriptionTypes";

function apiUrl(path: string): string {
  const base =
    (import.meta.env.VITE_EMAIL_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";
  return base ? `${base}${path}` : path;
}

const FETCH_TIMEOUT_MS = 15_000;

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}

function timeoutErrorMessage(seconds: number, what: string): string {
  return `${what}在 ${seconds} 秒内无响应（已超时）。请确认：开发环境已运行「npm run dev」（含端口 3001 邮件 API）；生产环境已启动 omnitools-email，且 Nginx 将 /api/ 反代到 Node。`;
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
      `${context}：收到 HTML 而非 JSON。请确认 Nginx 将 /api 转发到 Node。`
    );
  }
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new Error(`${context}：响应不是合法 JSON。`);
  }
}

export async function fetchSubscriptions(): Promise<GetSubscriptionsResponse> {
  const res = await fetchWithTimeout(
    apiUrl("/api/subscriptions"),
    undefined,
    FETCH_TIMEOUT_MS,
    "加载订阅列表"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  return parseJsonOrThrow<GetSubscriptionsResponse>(text, "加载订阅列表");
}

export async function createSubscription(
  body: CreateSubscriptionRequest
): Promise<Subscription> {
  const res = await fetchWithTimeout(
    apiUrl("/api/subscriptions"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    FETCH_TIMEOUT_MS,
    "创建订阅"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = parseJsonOrThrow<SubscriptionSingleResponse>(text, "创建订阅");
  return j.subscription;
}

export async function patchSubscription(
  id: string,
  body: PatchSubscriptionRequest
): Promise<Subscription> {
  const res = await fetchWithTimeout(
    apiUrl(`/api/subscriptions/${encodeURIComponent(id)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    FETCH_TIMEOUT_MS,
    "更新订阅"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = parseJsonOrThrow<SubscriptionSingleResponse>(text, "更新订阅");
  return j.subscription;
}

export async function toggleSubscriptionStatus(id: string): Promise<Subscription> {
  const res = await fetchWithTimeout(
    apiUrl(`/api/subscriptions/${encodeURIComponent(id)}/toggle-status`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    FETCH_TIMEOUT_MS,
    "切换订阅状态"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
  const j = parseJsonOrThrow<SubscriptionSingleResponse>(text, "切换订阅状态");
  return j.subscription;
}

export async function deleteSubscription(id: string): Promise<void> {
  const res = await fetchWithTimeout(
    apiUrl(`/api/subscriptions/${encodeURIComponent(id)}`),
    { method: "DELETE" },
    FETCH_TIMEOUT_MS,
    "删除订阅"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}

export async function sendSubscriptionReminder(id: string): Promise<void> {
  const res = await fetchWithTimeout(
    apiUrl(`/api/subscriptions/${encodeURIComponent(id)}/remind`),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    FETCH_TIMEOUT_MS,
    "发送提醒邮件"
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseErrorMessage(text));
  }
}
