import { describe, expect, it } from 'vitest';
import { ACCENTS, accentColors, normalizeAccent, normalizeTheme } from '../src/ui/theme';

describe('tema y acento', () => {
  it('normaliza valores guardados como JSON y cae en el tema claro', () => {
    expect(normalizeTheme('"dark"')).toBe('dark');
    expect(normalizeTheme('dark')).toBe('dark');
    expect(normalizeTheme('cualquier-cosa')).toBe('light');
    expect(normalizeTheme(undefined)).toBe('light');
  });

  it('solo acepta acentos conocidos', () => {
    expect(normalizeAccent('"violet"')).toBe('violet');
    expect(normalizeAccent('teal')).toBe('teal');
    expect(normalizeAccent('no-existe')).toBe('blue');
    expect(normalizeAccent(undefined)).toBe('blue');
  });

  it('devuelve la variante correcta para cada tema', () => {
    expect(accentColors('green', 'light').primary).toBe('#0f7a43');
    expect(accentColors('green', 'dark').primary).toBe('#6ee7a8');
    expect(ACCENTS.every((accent) => accent.light.primary && accent.dark.primary)).toBe(true);
  });
});
