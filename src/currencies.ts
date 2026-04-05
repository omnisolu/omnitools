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

export function currenciesMatch(a: string, b: string): boolean {
  return normalizeCurrency(a) === normalizeCurrency(b);
}
