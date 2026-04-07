/** 将 ISO 日期（YYYY-MM-DD，如来自 date 输入）显示为 YYYY/MM/DD */
export function formatIsoDateDisplay(iso: string | undefined | null): string {
  const t = (iso ?? "").trim();
  if (!t) return "—";
  const parts = t.split("-");
  if (parts.length !== 3) return t;
  const [y, m, d] = parts;
  if (!y || !m || !d) return t;
  return `${y}/${m}/${d}`;
}

/** 显示报销期间：2026/04/02 - 2026/04/09 */
export function formatIsoDateRange(
  from: string | undefined | null,
  to: string | undefined | null
): string {
  const a = formatIsoDateDisplay(from);
  const b = formatIsoDateDisplay(to);
  if (a === "—" && b === "—") return "—";
  return `${a} - ${b}`;
}
