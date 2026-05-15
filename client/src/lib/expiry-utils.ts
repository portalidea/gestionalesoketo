/**
 * Utility per visualizzazione scadenze con colori.
 *
 * Logica:
 * - daysToExpiry < 0: rosso scuro + barrato (scaduto)
 * - daysToExpiry < 7: rosso (critico)
 * - daysToExpiry < warningDays: giallo/ambra (warning)
 * - daysToExpiry >= warningDays: nessun highlight
 */

/**
 * Calcola i giorni alla scadenza da una data stringa "YYYY-MM-DD" o Date.
 */
export function daysToExpiry(expirationDate: string | Date | null | undefined): number | null {
  if (!expirationDate) return null;
  const expDate = typeof expirationDate === "string"
    ? new Date(expirationDate)
    : expirationDate;
  if (isNaN(expDate.getTime())) return null;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  expDate.setHours(0, 0, 0, 0);
  return Math.floor((expDate.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Ritorna la classe CSS per il colore della scadenza.
 * @param days - giorni alla scadenza (output di daysToExpiry)
 * @param warningDays - soglia warning (default 30, dal campo expiryWarningDays del prodotto)
 */
export function getExpiryColorClass(days: number | null, warningDays = 30): string {
  if (days === null) return "";
  if (days < 0) return "text-red-700 line-through";
  if (days < 7) return "text-red-500 font-semibold";
  if (days < warningDays) return "text-amber-500 font-medium";
  return "";
}

/**
 * Ritorna un'etichetta leggibile per la scadenza.
 */
export function getExpiryLabel(days: number | null): string {
  if (days === null) return "";
  if (days < 0) return `Scaduto da ${Math.abs(days)}g`;
  if (days === 0) return "Scade oggi";
  if (days === 1) return "Scade domani";
  return `${days}g rimanenti`;
}

/**
 * Ritorna il variant del Badge per la scadenza.
 */
export function getExpiryBadgeVariant(days: number | null): "destructive" | "secondary" | "outline" | "default" {
  if (days === null) return "outline";
  if (days < 0) return "destructive";
  if (days < 7) return "destructive";
  return "secondary";
}
