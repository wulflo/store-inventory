import { el, icon } from '../dom';
import { card } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import {
  createProduct,
  createColor,
  generateVariants,
  setInitialStock,
} from '../../domain/commands';
import { showError, toastSuccess } from '../components/toast';
import { openModalLazy } from '../components/modal';
import { formatMoney, parseMoneyToCents } from '../../core/money';
import { SIZES } from '../../core/sizes';
import type { ProductType, Season, SizeCode } from '../../core/types';

const comboKey = (sizeCode: string, colorId: string): string => `${sizeCode}|${colorId}`;

export function newProductView(app: App, shell: Shell): HTMLElement {
  let collectionId = '';
  let name = '';
  let sku = '';
  let type: ProductType = 'remera';
  let description = '';
  let basePriceCents = 0;
  let costFabricCents = 0;
  let costPrintCents = 0;
  let costLaborCents = 0;
  let costOtherCents = 0;
  const selectedSizes = new Set(SIZES.map((s) => s.code));
  const selectedColors = new Set<string>(
    [...app.state.colors.values()].filter((c) => !c.deletedAt).map((c) => c.id),
  );
  /** Cantidad inicial por combinación `talle|color`. */
  const variantStock = new Map<string, number>();
  /** Precio unitario por combinación `talle|color`; si falta, se usa el base. */
  const variantPrices = new Map<string, number>();

  const view = el('div');
  const formBox = el('div');

  view.appendChild(
    el(
      'div',
      { class: 'row-between mb-4' },
      el(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => shell.router.navigate('/productos') },
        },
        icon('arrowLeft', 18),
        'Catálogo',
      ),
      el('span', { class: 'small dim', text: 'Alta rápida' }),
    ),
  );
  view.appendChild(formBox);

  function render(): void {
    const collections = [...app.state.collections.values()].filter((c) => !c.deletedAt);
    const colors = [...app.state.colors.values()].filter((c) => !c.deletedAt);
    if (!collectionId && collections.length > 0) collectionId = collections[0].id;

    const collectionSelect = el(
      'select',
      {
        on: {
          change: () => {
            collectionId = collectionSelect.value;
          },
        },
      },
      el('option', { value: '', text: 'Elegí una colección…' }),
      ...collections.map((c) =>
        el('option', {
          value: c.id,
          text: c.name,
          selected: c.id === collectionId,
        }),
      ),
    );

    const nameInput = el('input', {
      type: 'text',
      placeholder: 'Ej: Remera Básica Algodón',
      value: name,
      on: { input: () => { name = nameInput.value; } },
    });

    const skuInput = el('input', {
      type: 'text',
      placeholder: 'Ej: REM-001',
      value: sku,
      on: { input: () => { sku = skuInput.value; } },
    });

    const typeSelect = el(
      'select',
      {
        on: {
          change: () => {
            type = typeSelect.value as ProductType;
          },
        },
      },
      el('option', { value: 'remera', text: 'Remera', selected: type === 'remera' }),
      el('option', { value: 'buzo', text: 'Buzo', selected: type === 'buzo' }),
    );

    const descInput = el('textarea', {
      rows: '2',
      placeholder: 'Descripción (opcional)',
      value: description,
      on: { input: () => { description = descInput.value; } },
    });

    const priceInput = moneyInput(basePriceCents, (v) => (basePriceCents = v));
    const fabricInput = moneyInput(costFabricCents, (v) => (costFabricCents = v));
    const printInput = moneyInput(costPrintCents, (v) => (costPrintCents = v));
    const laborInput = moneyInput(costLaborCents, (v) => (costLaborCents = v));
    const otherInput = moneyInput(costOtherCents, (v) => (costOtherCents = v));

    const marginBox = el('div', { class: 'small muted mt-2' });
    const updateMargin = () => {
      const cost = costFabricCents + costPrintCents + costLaborCents + costOtherCents;
      const margin = basePriceCents - cost;
      const pct = basePriceCents > 0 ? (margin / basePriceCents) * 100 : 0;
      marginBox.textContent =
        basePriceCents > 0
          ? `Costo ${formatMoney(cost)} · Margen ${formatMoney(margin)} (${pct.toFixed(0)}%)`
          : 'Costo 0 · Margen 0';
    };
    for (const input of [priceInput, fabricInput, printInput, laborInput, otherInput]) {
      input.addEventListener('input', updateMargin);
    }
    updateMargin();

    const totalBox = el('div', { class: 'small muted mt-3' });
    const matrixBox = el('div', { class: 'mt-3' });

    const activeCombos = () =>
      SIZES.filter((size) => selectedSizes.has(size.code)).flatMap((size) =>
        colors
          .filter((color) => selectedColors.has(color.id))
          .map((color) => ({ size, color })),
      );

    const updateTotal = () => {
      const combos = activeCombos();
      const units = combos.reduce(
        (sum, combo) => sum + (variantStock.get(comboKey(combo.size.code, combo.color.id)) ?? 0),
        0,
      );
      totalBox.textContent =
        `${selectedSizes.size} talle(s) × ${selectedColors.size} color(es) = ${combos.length} variante(s)` +
        ` · ${units} unidad(es) iniciales.`;
    };

    const renderMatrix = () => {
      matrixBox.replaceChildren();
      const combos = activeCombos();

      if (combos.length === 0) {
        matrixBox.appendChild(
          el('p', {
            class: 'muted small',
            text: 'Elegí al menos un talle y un color para cargar cantidades y precios.',
          }),
        );
        updateTotal();
        return;
      }

      matrixBox.appendChild(
        el(
          'div',
          { class: 'row-between wrap mb-3' },
          el('div', {
            class: 'section-title',
            style: { margin: '0' },
            text: 'Stock y precios por variante',
          }),
          el(
            'div',
            { class: 'row', style: { gap: '6px' } },
            el('button', {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              text: 'Aplicar precio base a todas',
              on: {
                click: () => {
                  for (const combo of combos) {
                    variantPrices.set(comboKey(combo.size.code, combo.color.id), basePriceCents);
                  }
                  renderMatrix();
                },
              },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              text: 'Vaciar cantidades',
              on: {
                click: () => {
                  for (const combo of combos) {
                    variantStock.delete(comboKey(combo.size.code, combo.color.id));
                  }
                  renderMatrix();
                },
              },
            }),
          ),
        ),
      );

      const table = el('table', { class: 'data' });
      table.appendChild(
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { text: 'Color' }),
            el('th', { text: 'Talle' }),
            el('th', { class: 'num', text: 'Cantidad inicial' }),
            el('th', { class: 'num', text: 'Precio unitario' }),
          ),
        ),
      );

      const tbody = el('tbody');
      for (const { size, color } of combos) {
        const key = comboKey(size.code, color.id);
        const currentStock = variantStock.get(key) ?? 0;
        const currentPrice = variantPrices.get(key) ?? basePriceCents;

        const stockInput = el('input', {
          type: 'number',
          min: '0',
          step: '1',
          inputmode: 'numeric',
          class: 'qty-input',
          value: String(currentStock),
          title: 'Unidades disponibles apenas se crea el producto',
          on: {
            input: () => {
              const qty = Math.max(0, Math.floor(Number(stockInput.value) || 0));
              if (stockInput.value === '') variantStock.delete(key);
              else variantStock.set(key, qty);
              updateTotal();
            },
            blur: () => {
              const qty = Math.max(0, Math.floor(Number(stockInput.value) || 0));
              stockInput.value = String(qty);
              if (qty > 0) variantStock.set(key, qty);
              else variantStock.delete(key);
              updateTotal();
            },
          },
        });

        const priceInput = el('input', {
          type: 'text',
          inputmode: 'decimal',
          placeholder: '0,00',
          value: currentPrice ? (currentPrice / 100).toFixed(2).replace('.', ',') : '',
          style: { width: '110px', textAlign: 'right' },
          title: 'Precio de esta combinación. Podés usar uno distinto para ofertas o fechas especiales.',
          on: {
            input: () => {
              variantPrices.set(key, parseMoneyToCents(priceInput.value) ?? 0);
              updateTotal();
            },
            blur: () => {
              const cents = parseMoneyToCents(priceInput.value) ?? 0;
              variantPrices.set(key, cents);
              priceInput.value = cents ? (cents / 100).toFixed(2).replace('.', ',') : '';
            },
          },
        });

        tbody.appendChild(
          el(
            'tr',
            {},
            el(
              'td',
              {},
              el(
                'span',
                { class: 'row', style: { gap: '6px' } },
                el('span', { class: 'color-dot', style: { background: color.hex } }),
                el('span', { text: color.name }),
              ),
            ),
            el('td', { text: size.code }),
            el('td', { class: 'num' }, stockInput),
            el('td', { class: 'num' }, priceInput),
          ),
        );
      }
      table.appendChild(tbody);
      matrixBox.appendChild(el('div', { class: 'table-wrap' }, table));
      matrixBox.appendChild(
        el('p', {
          class: 'xsmall dim mt-2',
          text:
            'El stock inicial queda registrado como movimiento “inicial”. Los precios por variante se usan en pedidos nuevos; ' +
            'para una oferta puntual también podés ajustar el precio de la línea al cargar el pedido.',
        }),
      );
      updateTotal();
    };

    const sizeButtons = SIZES.map((s) => {
      const btn = el(
        'button',
        {
          class: `chip${selectedSizes.has(s.code) ? ' active' : ''}`,
          type: 'button',
          text: s.label,
          'aria-pressed': String(selectedSizes.has(s.code)),
          on: {
            click: () => {
              if (selectedSizes.has(s.code)) selectedSizes.delete(s.code);
              else selectedSizes.add(s.code);
              btn.classList.toggle('active');
              btn.setAttribute('aria-pressed', String(selectedSizes.has(s.code)));
              renderMatrix();
            },
          },
        },
      );
      return btn;
    });

    const colorButtons = colors.map((c) => {
      const btn = el(
        'button',
        {
          class: `chip${selectedColors.has(c.id) ? ' active' : ''}`,
          type: 'button',
          'aria-pressed': String(selectedColors.has(c.id)),
          on: {
            click: () => {
              if (selectedColors.has(c.id)) selectedColors.delete(c.id);
              else selectedColors.add(c.id);
              btn.classList.toggle('active');
              btn.setAttribute('aria-pressed', String(selectedColors.has(c.id)));
              renderMatrix();
            },
          },
        },
        el('span', { class: 'color-dot', style: { background: c.hex } }),
        el('span', { text: c.name }),
      );
      return btn;
    });
    renderMatrix();

    formBox.replaceChildren(
      card({
        title: 'Nuevo producto',
        subtitle: 'Un solo formulario: datos, precios, talles y colores.',
        content: el(
          'div',
          {},
          el(
            'div',
            { class: 'form-row' },
            el(
              'div',
              { class: 'field' },
              el(
                'label',
                { class: 'row-between' },
                el('span', { text: 'Colección' }),
                el('button', {
                  class: 'btn btn-sm btn-ghost',
                  type: 'button',
                  text: '+ Nueva',
                  on: {
                    click: () => openCreateCollection(app, () => render()),
                  },
                }),
              ),
              collectionSelect,
            ),
            el('div', { class: 'field' }, el('label', { text: 'Tipo' }), typeSelect),
          ),
          el(
            'div',
            { class: 'form-row' },
            el('div', { class: 'field' }, el('label', { text: 'Nombre' }), nameInput),
            el('div', { class: 'field' }, el('label', { text: 'SKU' }), skuInput),
          ),
          el(
            'div',
            { class: 'form-row' },
            el(
              'div',
              { class: 'field' },
              el('label', { text: 'Precio de venta' }),
              priceInput,
              marginBox,
            ),
            el('div', { class: 'field' }, el('label', { text: 'Descripción' }), descInput),
          ),
          el(
            'details',
            { class: 'aero-details mt-3' },
            el('summary', { text: 'Costos por unidad (opcional)' }),
            el(
              'div',
              { class: 'form-row form-row-3 mt-3' },
              el('div', { class: 'field' }, el('label', { text: 'Tela' }), fabricInput),
              el('div', { class: 'field' }, el('label', { text: 'Estampado' }), printInput),
              el('div', { class: 'field' }, el('label', { text: 'Mano de obra' }), laborInput),
            ),
            el('div', { class: 'field' }, el('label', { text: 'Otros' }), otherInput),
          ),
          el(
            'div',
            { class: 'row-between mt-4' },
            el('div', { class: 'section-title', style: { margin: '0' }, text: 'Talles' }),
            el('span', { class: 'xsmall dim', text: 'Todos activos por defecto' }),
          ),
          el('div', { class: 'chip-row' }, ...sizeButtons),
          el(
            'div',
            { class: 'row-between mt-4' },
            el('div', { class: 'section-title', style: { margin: '0' }, text: 'Colores' }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              text: '+ Nuevo color',
              on: { click: () => openCreateColor(app, () => render()) },
            }),
          ),
          colors.length === 0
            ? el('p', { class: 'muted', text: 'Necesitás al menos un color. Creá uno con “+ Nuevo color”.' })
            : el('div', { class: 'chip-row' }, ...colorButtons),
          matrixBox,
          totalBox,
          el(
            'div',
            { class: 'btn-group mt-4' },
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Cancelar',
              on: { click: () => shell.router.navigate('/productos') },
            }),
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Crear producto',
              on: { click: () => void save() },
            }),
          ),
        ),
      }),
    );
  }

  async function save(): Promise<void> {
    if (!collectionId) {
      showError(new Error('Elegí una colección.'));
      return;
    }
    if (!name.trim()) {
      showError(new Error('Poné un nombre.'));
      return;
    }
    if (!sku.trim()) {
      showError(new Error('Poné un SKU.'));
      return;
    }
    try {
      const sizes = [...selectedSizes] as SizeCode[];
      const colorIds = [...selectedColors];
      const totalCost =
        costFabricCents + costPrintCents + costLaborCents + costOtherCents;

      // Solo se manda el precio cuando el usuario lo cambió: así una variante
      // sin tocar sigue el precio base del producto.
      const overrides: Record<string, { priceCents?: number }> = {};
      for (const size of sizes) {
        for (const colorId of colorIds) {
          const key = comboKey(size, colorId);
          if (variantPrices.has(key)) {
            overrides[key] = { priceCents: variantPrices.get(key)! };
          }
        }
      }

      const { id } = await createProduct(app, {
        collectionId,
        sku,
        name,
        type,
        description: description || undefined,
        basePriceCents,
        costFabricCents,
        costPrintCents,
        costLaborCents,
        costOtherCents,
      });

      let variantsCreated = 0;
      let initialUnits = 0;

      if (sizes.length > 0 && colorIds.length > 0) {
        variantsCreated = await generateVariants(
          app,
          id,
          sizes,
          colorIds,
          { costCents: totalCost, priceCents: basePriceCents },
          overrides,
        );

        // El stock inicial se registra como movimiento append-only después de
        // crear las variantes. No depende de una orden de producción.
        const variants = [...(app.state.variantsByProduct.get(id) ?? [])]
          .map((variantId) => app.state.variants.get(variantId))
          .filter((variant) => variant && !variant.deletedAt);
        for (const variant of variants) {
          const qty = variantStock.get(comboKey(variant!.sizeCode, variant!.colorId)) ?? 0;
          if (qty > 0) {
            await setInitialStock(
              app,
              variant!.id,
              qty,
              'Stock inicial al crear producto',
            );
            initialUnits += qty;
          }
        }
      }

      const detail = [
        variantsCreated > 0 ? `${variantsCreated} variante(s)` : '',
        initialUnits > 0 ? `${initialUnits} unidad(es) en stock` : '',
      ]
        .filter(Boolean)
        .join(' y ');
      toastSuccess(detail ? `Producto creado con ${detail}.` : 'Producto creado.');
      shell.router.navigate('/productos');
    } catch (err) {
      showError(err);
    }
  }

  render();
  return view;
}

/* ------------------------------------------------------------------ */

function moneyInput(initialCents: number, onChange: (cents: number) => void): HTMLInputElement {
  const input = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: initialCents ? (initialCents / 100).toFixed(2).replace('.', ',') : '',
    placeholder: '0,00',
    on: {
      input: () => {
        const cents = parseMoneyToCents(input.value);
        onChange(cents ?? 0);
      },
    },
  });
  return input;
}

export function openCreateCollection(app: App, onCreated: (collectionId?: string) => void): void {
  const nameInput = el('input', { type: 'text', placeholder: 'Ej: Invierno 2026' });
  const seasonSelect = el(
    'select',
    {},
    ...(['invierno', 'verano', 'otono', 'primavera'] as Season[]).map((s) =>
      el('option', { value: s, text: s }),
    ),
  );
  const yearInput = el('input', { type: 'number', value: String(new Date().getFullYear()) });

  openModalLazy({
    title: 'Nueva colección',
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', { text: 'Nombre' }), nameInput),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Temporada' }), seasonSelect),
        el('div', { class: 'field' }, el('label', { text: 'Año' }), yearInput),
      ),
    ),
    onConfirm: async () => {
      const { createCollection } = await import('../../domain/commands');
      const { id } = await createCollection(app, {
        name: nameInput.value,
        season: seasonSelect.value as Season,
        year: Number(yearInput.value) || new Date().getFullYear(),
      });
      onCreated(id);
    },
  });
}

export function openCreateColor(app: App, onCreated: () => void): void {
  const nameInput = el('input', { type: 'text', placeholder: 'Ej: Verde militar' });
  const hexInput = el('input', { type: 'color', value: '#4a5568', style: { height: '42px' } });

  openModalLazy({
    title: 'Nuevo color',
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', { text: 'Nombre' }), nameInput),
      el('div', { class: 'field' }, el('label', { text: 'Color' }), hexInput),
    ),
    onConfirm: async () => {
      await createColor(app, { name: nameInput.value, hex: hexInput.value });
      onCreated();
    },
  });
}
