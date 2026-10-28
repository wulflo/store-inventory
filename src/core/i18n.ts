export type Language = 'es' | 'en';

const STORAGE_KEY = 'language';

let current: Language = 'es';
if (typeof localStorage !== 'undefined') {
  const stored = localStorage.getItem(STORAGE_KEY) as Language | null;
  if (stored === 'es' || stored === 'en') current = stored;
}

const dictionaries: Record<Language, Record<string, string>> = {
  es: {},
  en: {},
};

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang === 'en' ? 'en' : 'es';
  localStorage.setItem(STORAGE_KEY, current);
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

export function t(key: string): string {
  return dictionaries[current][key] ?? dictionaries.es[key] ?? key;
}

// Apply on load.
if (typeof document !== 'undefined') document.documentElement.lang = current;
