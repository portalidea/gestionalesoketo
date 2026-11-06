const DAY_MS = 24 * 60 * 60 * 1000;

export function amazonCutoffMidnightUtc(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Cutoff Amazon non valido");
  const [year, month, day] = date.split("-").map(Number);
  const midnight = new Date(Date.UTC(year, month - 1, day));
  if (midnight.toISOString().slice(0, 10) !== date) throw new Error("Cutoff Amazon non valido");
  function offset(instant: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(instant);
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(value => value.type === type)?.value);
    return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second")) - instant.getTime();
  }
  const first = new Date(midnight.getTime() - offset(midnight));
  return new Date(midnight.getTime() - offset(first));
}

export function buildAmazonImportWindow(cutoff: string, checkpoint: Date | null, now = new Date()) {
  const floor = amazonCutoffMidnightUtc(cutoff).getTime();
  if (!Number.isFinite(now.getTime()) || (checkpoint && !Number.isFinite(checkpoint.getTime()))) throw new Error("Timestamp Amazon non valido");
  const start = new Date(Math.max(floor, (checkpoint?.getTime() ?? floor) - 2 * DAY_MS));
  const end = new Date(Math.min(start.getTime() + 30 * DAY_MS, now.getTime()));
  if (end <= start) throw new Error("Finestra Amazon futura/non valida");
  return { start, end };
}
