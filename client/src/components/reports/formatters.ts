/** Format number as Italian currency: € 1.234,56 */
export function formatEur(value: number): string {
  return value.toLocaleString("it-IT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Format number with Italian locale (1.234,56) */
export function formatNum(value: number, decimals = 0): string {
  return value.toLocaleString("it-IT", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Format percentage: 66,1% */
export function formatPct(value: number): string {
  return value.toLocaleString("it-IT", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }) + "%";
}

/** Format date as Italian short: 15/03/2026 */
export function formatDateIT(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("it-IT");
}

/** Format date as short: 15 mar */
export function formatDateShort(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
}

/** Recharts tooltip formatter for EUR */
export function tooltipEur(value: number): string {
  return formatEur(value);
}
