import { el, icon } from '../dom';
import { card } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { createProduct, createColor, generateVariants } from '../../domain/commands';
import { showError, toastSuccess } from '../components/toast';
import { openModalLazy } from '../components/modal';
import { formatMoney, parseMoneyToCents } from '../../core/money';
import { SIZES } from '../../core/sizes';
import type { ProductType, Season } from '../../core/types';

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
    const updateTotal = () => {
      totalBox.textContent = `${selectedSizes.size} talle(s) × ${selectedColors.size} color(es) = ${
        selectedSizes.size * selectedColors.size
      } variante(s).`;
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
              updateTotal();
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
              updateTotal();
            },
          },
        },
        el('span', { class: 'color-dot', style: { background: c.hex } }),
        el('span', { text: c.name }),
      );
      return btn;
    });
    updateTotal();

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

      if (selectedSizes.size > 0 && selectedColors.size > 0) {
        await generateVariants(app, id, [...selectedSizes] as any, [...selectedColors], {
          costCents: costFabricCents + costPrintCents + costLaborCents + costOtherCents,
          priceCents: basePriceCents,
        });
      }

      toastSuccess('Producto creado.');
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
