/** 常用币种代码（datalist 建议，可手输其它） */
export const COMMON_CURRENCY_CODES = [
  "CAD",
  "USD",
  "CNY",
  "EUR",
  "GBP",
  "JPY",
  "HKD",
  "AUD",
  "CHF",
  "SGD",
] as const;

export function normalizeCurrency(code: string): string {
  return code.trim().toUpperCase();
}

/** 是否在常用列表中（用于下拉与「其他」手动输入分支） */
export function isCommonCurrencyCode(code: string): boolean {
  const n = normalizeCurrency(code);
  return (COMMON_CURRENCY_CODES as readonly string[]).includes(n);
}

export function currenciesMatch(a: string, b: string): boolean {
  return normalizeCurrency(a) === normalizeCurrency(b);
}
