import { getLanguage } from './i18n';
/**
 * Fechas en español rioplatense. Todo interno en ms epoch UTC.
 * Solo la capa de presentación convierte a "día local".
 */

export const MS_DAY = 86400000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function addDays(ts: number, days: number): number {
  return ts + days * MS_DAY;
}

export function startOfWeek(ts: number): number {
  const d = new Date(startOfDay(ts));
  // Semana que empieza el lunes.
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export function endOfWeek(ts: number): number {
  return endOfDay(startOfWeek(ts) + 6 * MS_DAY);
}

export function startOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function endOfMonth(ts: number): number {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + 1, 0);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

export function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / MS_DAY);
}


function dateLocale(): string {
  return getLanguage() === 'en' ? 'en-US' : 'es-AR';
}

export function formatDate(ts?: number): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(dateLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(ts));
}

export function formatDateShort(ts?: number): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(dateLocale(), {
    day: '2-digit',
    month: 'short',
  }).format(new Date(ts));
}

export function formatDateTime(ts?: number): string {
  if (!ts) return '—';
  return new Intl.DateTimeFormat(dateLocale(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts));
}

export function formatWeekday(ts: number): string {
  return new Intl.DateTimeFormat(dateLocale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(ts));
}

/** "hoy", "mañana", "hace 3 días", "en 2 días", o la fecha. */
export function formatRelative(ts?: number, now = Date.now()): string {
  if (!ts) return '—';
  const diff = daysBetween(now, ts);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  if (diff === -1) return 'ayer';
  if (diff > 1 && diff <= 30) return `en ${diff} días`;
  if (diff < -1 && diff >= -30) return `hace ${Math.abs(diff)} días`;
  return formatDate(ts);
}

/** Convierte "YYYY-MM-DD" a ms epoch local (medianoche local). */
export function parseDateInput(value: string): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

/** Formatea a "YYYY-MM-DD" para <input type="date">. */
export function toDateInput(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Formatea a "HH:MM". */
export function formatTime(ts?: number): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Etiquetas relativas para estados. */
export function dueLabel(dueDate: number | undefined, now = Date.now()): string {
  if (!dueDate) return 'Sin fecha';
  const diff = daysBetween(now, dueDate);
  if (diff < 0) return `Vencido (${formatDate(dueDate)})`;
  if (diff === 0) return 'Vence hoy';
  if (diff === 1) return 'Vence mañana';
  if (diff <= 7) return `Vence en ${diff} días`;
  return formatDate(dueDate);
}
