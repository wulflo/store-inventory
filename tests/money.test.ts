import { afterEach, describe, expect, it } from 'vitest';
import {
  arsCentsToDisplay,
  displayCentsToArs,
  formatMoney,
  getDisplayCurrency,
  setDisplayCurrency,
} from '../src/core/money';

afterEach(() => {
  setDisplayCurrency('ARS');
});

describe('moneda de visualización', () => {
  it('por defecto formatea en ARS sin convertir', () => {
    expect(getDisplayCurrency()).toEqual({ code: 'ARS', arsPerUnit: 1 });
    expect(formatMoney(1_250_000)).toBe('$ 12.500,00');
    expect(arsCentsToDisplay(1_250_000)).toBe(1_250_000);
    expect(displayCentsToArs(12_500)).toBe(12_500);
  });

  it('convierte centavos ARS a USD usando la cotización manual', () => {
    setDisplayCurrency('USD', 1_000);
    // ARS 12.500 / 1000 = USD 12,50
    expect(formatMoney(1_250_000)).toBe('US$ 12,50');
    expect(arsCentsToDisplay(1_250_000)).toBe(1_250);
    expect(displayCentsToArs(1_250)).toBe(1_250_000);
  });

  it('convierte a EUR y respeta la cotización guardada', () => {
    setDisplayCurrency('EUR', 1_500);
    expect(formatMoney(1_500_000)).toBe('€ 10,00');
    expect(getDisplayCurrency()).toEqual({ code: 'EUR', arsPerUnit: 1_500 });
  });

  it('ignora monedas y cotizaciones inválidas', () => {
    setDisplayCurrency('GBP', 500);
    expect(getDisplayCurrency().code).toBe('ARS');
    setDisplayCurrency('USD', 0);
    expect(getDisplayCurrency()).toEqual({ code: 'USD', arsPerUnit: 1 });
  });

  it('redondea una sola vez al mostrar', () => {
    setDisplayCurrency('USD', 1_000);
    expect(arsCentsToDisplay(1_234)).toBe(1); // 12,34 ARS / 1000 = 0,01234 USD
    expect(formatMoney(1_234)).toBe('US$ 0,01');
  });
});
