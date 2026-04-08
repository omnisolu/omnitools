/** 与 server/subscription-sqlite.mjs 及 REST API 对齐 */

export type SubscriptionCurrency = "USD" | "CAD";

export type SubscriptionCycle = "monthly" | "yearly";

export type SubscriptionStatus = "active" | "paused" | "pending";

export interface Subscription {
  id: string;
  userName: string;
  userEmail: string;
  serviceName: string;
  project: string;
  /** 该币种最小货币单位（分） */
  amountMinor: number;
  currency: SubscriptionCurrency;
  /** 折合 USD 的分（服务端按汇率换算） */
  amountUsdMinor: number;
  cycle: SubscriptionCycle;
  /** ISO 日期 YYYY-MM-DD */
  nextBillingDate: string;
  cardLastFour: string;
  cardExpiryMmYy: string | null;
  status: SubscriptionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionsSummary {
  /** 所有订阅折合 USD 的分合计 */
  totalUsdMinor: number;
  /** 1 USD 兑多少 CAD（用于 CAD→USD） */
  cadPerUsd: number;
  baseCurrency: "USD";
}

export interface GetSubscriptionsResponse {
  ok: true;
  items: Subscription[];
  summary: SubscriptionsSummary;
}

export interface SubscriptionSingleResponse {
  ok: true;
  subscription: Subscription;
}

export interface CreateSubscriptionRequest {
  userName: string;
  userEmail: string;
  serviceName: string;
  project: string;
  /** 分（整数）；也可传 amount 为「元」的小数字符串由服务端解析 */
  amountMinor?: number;
  amount?: string | number;
  currency?: SubscriptionCurrency;
  cycle: SubscriptionCycle;
  nextBillingDate: string;
  cardLastFour: string;
  cardExpiryMmYy?: string | null;
  status?: SubscriptionStatus;
}

export interface PatchSubscriptionRequest {
  userName?: string;
  userEmail?: string;
  serviceName?: string;
  project?: string;
  amountMinor?: number;
  amount?: string | number;
  currency?: SubscriptionCurrency;
  cycle?: SubscriptionCycle;
  nextBillingDate?: string;
  cardLastFour?: string;
  cardExpiryMmYy?: string | null;
  status?: SubscriptionStatus;
}

export interface OkResponse {
  ok: true;
}

export interface ApiErrorBody {
  error: string;
}
