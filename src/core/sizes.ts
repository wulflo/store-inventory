import type { SizeCode } from './types';

/**
 * Talles fijos (decisión del dueño, no editables).
 * El `sortOrder` define el orden en la grilla talles × colores.
 */
export const SIZES: ReadonlyArray<{ code: SizeCode; label: string; sortOrder: number }> = [
  { code: 'XS', label: 'XS', sortOrder: 10 },
  { code: 'S', label: 'S', sortOrder: 20 },
  { code: 'M', label: 'M', sortOrder: 30 },
  { code: 'L', label: 'L', sortOrder: 40 },
  { code: 'XL', label: 'XL', sortOrder: 50 },
  { code: 'XXL', label: 'XXL', sortOrder: 60 },
  { code: '3XL', label: '3XL', sortOrder: 70 },
];

export const SIZE_CODES: SizeCode[] = SIZES.map((s) => s.code);

export function sizeLabel(code: string): string {
  return SIZES.find((s) => s.code === code)?.label ?? code;
}

export function sizeSortOrder(code: string): number {
  return SIZES.find((s) => s.code === code)?.sortOrder ?? 999;
}
