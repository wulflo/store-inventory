/**
 * Tema claro/oscuro y color de acento.
 *
 * Los roles M3 se aplican como variables inline sobre <html> para que el
 * acento elegido gane sobre los valores por defecto de styles.css.
 */

export type ThemeName = 'light' | 'dark';
export type AccentId = 'blue' | 'violet' | 'green' | 'teal' | 'orange' | 'pink';

interface AccentColors {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  hover: string;
}

export interface Accent {
  id: AccentId;
  label: string;
  light: AccentColors;
  dark: AccentColors;
}

export const ACCENTS: readonly Accent[] = [
  {
    id: 'blue',
    label: 'Azul',
    light: {
      primary: '#2f6df6',
      onPrimary: '#ffffff',
      primaryContainer: '#e7efff',
      onPrimaryContainer: '#1a4aa3',
      hover: '#1f5ad9',
    },
    dark: {
      primary: '#8c9dff',
      onPrimary: '#303f67',
      primaryContainer: '#303f67',
      onPrimaryContainer: '#e7efff',
      hover: '#a3b4ff',
    },
  },
  {
    id: 'violet',
    label: 'Violeta',
    light: {
      primary: '#6d3bd1',
      onPrimary: '#ffffff',
      primaryContainer: '#f0e7ff',
      onPrimaryContainer: '#4a1d96',
      hover: '#5b2fb3',
    },
    dark: {
      primary: '#c4b5fd',
      onPrimary: '#3b1d70',
      primaryContainer: '#43267d',
      onPrimaryContainer: '#ede9fe',
      hover: '#d6c9ff',
    },
  },
  {
    id: 'green',
    label: 'Verde',
    light: {
      primary: '#0f7a43',
      onPrimary: '#ffffff',
      primaryContainer: '#ddf5e8',
      onPrimaryContainer: '#064e2b',
      hover: '#0a6437',
    },
    dark: {
      primary: '#6ee7a8',
      onPrimary: '#00391f',
      primaryContainer: '#0a4d2c',
      onPrimaryContainer: '#d1fae5',
      hover: '#8ff0bd',
    },
  },
  {
    id: 'teal',
    label: 'Turquesa',
    light: {
      primary: '#006b63',
      onPrimary: '#ffffff',
      primaryContainer: '#d7f5f1',
      onPrimaryContainer: '#00413c',
      hover: '#005a53',
    },
    dark: {
      primary: '#5eead4',
      onPrimary: '#003731',
      primaryContainer: '#0b4f49',
      onPrimaryContainer: '#ccfbf1',
      hover: '#8ff5e4',
    },
  },
  {
    id: 'orange',
    label: 'Naranja',
    light: {
      primary: '#a84b00',
      onPrimary: '#ffffff',
      primaryContainer: '#ffeadb',
      onPrimaryContainer: '#6b2b00',
      hover: '#8f3f00',
    },
    dark: {
      primary: '#ffb68a',
      onPrimary: '#4a1f00',
      primaryContainer: '#5c2a00',
      onPrimaryContainer: '#ffdcc8',
      hover: '#ffc7a6',
    },
  },
  {
    id: 'pink',
    label: 'Rosa',
    light: {
      primary: '#b4235a',
      onPrimary: '#ffffff',
      primaryContainer: '#ffe4ee',
      onPrimaryContainer: '#7a0f3a',
      hover: '#991b4b',
    },
    dark: {
      primary: '#ffb1c8',
      onPrimary: '#4a0e24',
      primaryContainer: '#5e1832',
      onPrimaryContainer: '#ffd9e3',
      hover: '#ffc3d5',
    },
  },
];

const ACCENT_IDS = new Set<string>(ACCENTS.map((accent) => accent.id));

export function normalizeTheme(value: string | null | undefined): ThemeName {
  return value?.replace(/^"|"$/g, '') === 'dark' ? 'dark' : 'light';
}

export function normalizeAccent(value: string | null | undefined): AccentId {
  const clean = value?.replace(/^"|"$/g, '');
  return clean && ACCENT_IDS.has(clean) ? (clean as AccentId) : 'blue';
}

export function accentColors(accent: AccentId, theme: ThemeName): AccentColors {
  const found = ACCENTS.find((item) => item.id === accent) ?? ACCENTS[0];
  return theme === 'dark' ? found.dark : found.light;
}

/** Aplica tema + acento y los recuerda en localStorage. */
export function applyTheme(theme: string | null | undefined, accent: string | null | undefined): void {
  const themeName = normalizeTheme(theme);
  const accentId = normalizeAccent(accent);
  const colors = accentColors(accentId, themeName);
  const root = document.documentElement;

  root.dataset.theme = themeName;
  root.dataset.accent = accentId;

  root.style.setProperty('--seed-primary', colors.primary);
  root.style.setProperty('--md-sys-color-primary', colors.primary);
  root.style.setProperty('--md-sys-color-on-primary', colors.onPrimary);
  root.style.setProperty('--md-sys-color-primary-container', colors.primaryContainer);
  root.style.setProperty('--md-sys-color-on-primary-container', colors.onPrimaryContainer);
  root.style.setProperty('--md-sys-color-tertiary', colors.primary);
  root.style.setProperty('--md-sys-color-on-tertiary', colors.onPrimary);
  root.style.setProperty('--md-sys-color-tertiary-container', colors.primaryContainer);
  root.style.setProperty('--md-sys-color-on-tertiary-container', colors.onPrimaryContainer);
  root.style.setProperty('--md-sys-color-inverse-primary', colors.primary);
  root.style.setProperty('--primary-hover', colors.hover);
  root.style.setProperty('--primary-contrast', colors.onPrimary);

  localStorage.setItem('theme', themeName);
  localStorage.setItem('accent', accentId);

  window.dispatchEvent(
    new CustomEvent('inventario:themechange', {
      detail: { theme: themeName, accent: accentId },
    }),
  );
}
