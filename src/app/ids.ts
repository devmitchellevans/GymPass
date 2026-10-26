function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Same format the server used to generate (GP-XXXXXXXX), now created on-device so it works offline. */
export function createMemberId(): string {
  const hex = Array.from(randomBytes(4), (b) => b.toString(16).padStart(2, '0')).join('');
  return `GP-${hex.toUpperCase()}`;
}

export function createUuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // randomUUID is only exposed in secure contexts; this keeps plain-http dev sessions working.
  return Array.from(randomBytes(16), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** yyyy-mm-dd in the device's local time (toISOString would use UTC and can be a day off). */
export function formatLocalDate(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

export function todayLocalDate(): string {
  return formatLocalDate(new Date());
}

/** Adds calendar months, clamping to the end of a shorter month (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsLocal(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  return formatLocalDate(target);
}

export function addDaysLocal(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return formatLocalDate(new Date(y, m - 1, d + days));
}

/** Accepts "GP-1A2B3C4D", "gp-1a2b3c4d" or just "1A2B3C4D" (typed at a kiosk). */
export function normalizeMemberId(raw: string): string {
  const value = raw.trim().toUpperCase().replace(/\s+/g, '');
  return /^[0-9A-F]{8}$/.test(value) ? `GP-${value}` : value;
}

export function looksLikeMemberId(raw: string): boolean {
  return /^GP-[0-9A-F]{8}$/.test(normalizeMemberId(raw));
}
