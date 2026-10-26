/**
 * Dinero: SIEMPRE enteros en centavos ARS.
 *
 * Regla dura: nunca se usa float para almacenar ni calcular saldo final.
 * Los floats solo se usan como puente de parseo/format, y se redondea
 * inmediatamente a entero.
 */

export const DEFAULT_CURRENCY = 'ARS';

export interface CurrencyConfig {
  code: string;
  symbol: string;
  /** Decimales de subunit (2 para ARS). */
  decimals: number;
  locale: string;
}

export const CURRENCIES: Record<string, CurrencyConfig> = {
  ARS: { code: 'ARS', symbol: '$', decimals: 2, locale: 'es-AR' },
  USD: { code: 'USD', symbol: 'US$', decimals: 2, locale: 'es-AR' },
  EUR: { code: 'EUR', symbol: '€', decimals: 2, locale: 'es-AR' },
};

export function currencyConfig(code: string): CurrencyConfig {
  return CURRENCIES[code] ?? CURRENCIES[DEFAULT_CURRENCY];
}

/** Convierte pesos (float) a centavos (entero). */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** Convierte centavos (entero) a pesos (float). Solo para mostrar. */
export function toUnits(cents: number): number {
  return cents / 100;
}

/** Formatea centavos como "$ 12.500,00" (estilo rioplatense). */
export function formatMoney(cents: number, code: string = DEFAULT_CURRENCY): string {
  const cfg = currencyConfig(code);
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const units = abs / 100;
  const fixed = units.toFixed(cfg.decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = negative ? '-' : '';
  return `${sign}${cfg.symbol} ${grouped}${decPart ? ',' + decPart : ''}`;
}

/** Formatea centavos sin símbolo, para inputs. */
export function formatMoneyPlain(cents: number, decimals = 2): string {
  const abs = Math.abs(Math.round(cents));
  const fixed = (abs / 100).toFixed(decimals);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${cents < 0 ? '-' : ''}${grouped}${decPart ? ',' + decPart : ''}`;
}

/**
 * Parsea texto de usuario ("12.500,50", "12500.5", "$ 1.234") a centavos.
 * Devuelve null si no se puede parsear.
 */
export function parseMoneyToCents(input: string): number | null {
  const raw = input.trim().replace(/[^\d,.\-]/g, '');
  if (!raw) return null;

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');

  let normalized: string;
  if (lastComma > -1 && lastDot > -1) {
    // El separador decimal es el que aparece más a la derecha.
    normalized =
      lastComma > lastDot
        ? raw.replace(/\./g, '').replace(',', '.')
        : raw.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Solo comas: decimal si tiene 1-2 dígitos después, si no es separador de miles.
    const after = raw.length - lastComma - 1;
    normalized = after === 3 ? raw.replace(/,/g, '') : raw.replace(',', '.');
  } else {
    normalized = raw;
  }

  const num = Number(normalized);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/** Porcentaje de margen sobre precio de venta. */
export function marginPercent(priceCents: number, costCents: number): number {
  if (priceCents <= 0) return 0;
  return ((priceCents - costCents) / priceCents) * 100;
}
