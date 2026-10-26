import { el, icon } from '../dom';
import { card } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { createProduct, createColor, generateVariants } from '../../domain/commands';
import { showError, toastSuccess } from '../components/toast';
import { openModalLazy } from '../components/modal';
import { parseMoneyToCents } from '../../core/money';
import { SIZES } from '../../core/sizes';
import type { ProductType, Season } from '../../core/types';

export function newProductView(app: App, shell: Shell): HTMLElement {
  let step = 1;
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
  const stepBox = el('div');

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
      el('div', { class: 'row', style: { gap: '8px' } }, el('span', { class: 'small dim', text: `Paso ${step} de 3` })),
    ),
  );
  view.appendChild(stepBox);

  function render(): void {
    stepBox.replaceChildren();
    if (step === 1) renderStep1();
    else if (step === 2) renderStep2();
    else renderStep3();
  }

  /* ---------------- Paso 1: colección ---------------- */
  function renderStep1(): void {
    const select = el(
      'select',
      {
        on: {
          change: () => {
            collectionId = select.value;
          },
        },
      },
      el('option', { value: '', text: 'Elegí una colección…' }),
      ...[...app.state.collections.values()]
        .filter((c) => !c.deletedAt)
        .map((c) => el('option', { value: c.id, text: c.name })),
    );

    const hasCollections = [...app.state.collections.values()].some((c) => !c.deletedAt);

    stepBox.appendChild(
      card({
        title: '1 · Colección',
        content: el(
          'div',
          {},
          hasCollections
            ? el('div', { class: 'field' }, el('label', { text: 'Colección' }), select)
            : emptyCollectionNotice(),
          el(
            'div',
            { class: 'btn-group mt-4' },
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Continuar',
              on: {
                click: () => {
                  if (!collectionId) {
                    showError(new Error('Elegí una colección.'));
                    return;
                  }
                  step = 2;
                  render();
                },
              },
            }),
          ),
        ),
      }),
    );
  }

  function emptyCollectionNotice(): HTMLElement {
    return el(
      'div',
      {},
      el('p', {
        class: 'muted mb-4',
        text: 'Primero necesitás una colección. Creala acá y seguí.',
      }),
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          text: 'Crear colección',
          on: { click: () => openCreateCollection(app, () => render()) },
        },
      ),
    );
  }

  /* ---------------- Paso 2: datos ---------------- */
  function renderStep2(): void {
    const nameInput = el('input', {
      type: 'text',
      placeholder: 'Ej: Remera Básica Algodón',
      value: name,
      on: {
        input: () => {
          name = nameInput.value;
        },
      },
    });

    const skuInput = el('input', {
      type: 'text',
      placeholder: 'Ej: REM-001',
      value: sku,
      on: {
        input: () => {
          sku = skuInput.value;
        },
      },
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
      on: {
        input: () => {
          description = descInput.value;
        },
      },
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
          ? `Costo ${(cost / 100).toFixed(2)} · Margen ${(margin / 100).toFixed(2)} (${pct.toFixed(0)}%)`
          : 'Costo 0 · Margen 0';
    };
    priceInput.addEventListener('input', updateMargin);
    updateMargin();

    stepBox.appendChild(
      card({
        title: '2 · Datos del producto',
        content: el(
          'div',
          {},
          el(
            'div',
            { class: 'form-row' },
            el('div', { class: 'field' }, el('label', { text: 'Nombre' }), nameInput),
            el('div', { class: 'field' }, el('label', { text: 'SKU' }), skuInput),
          ),
          el(
            'div',
            { class: 'form-row' },
            el('div', { class: 'field' }, el('label', { text: 'Tipo' }), typeSelect),
            el(
              'div',
              { class: 'field' },
              el('label', { text: 'Precio de venta' }),
              priceInput,
              marginBox,
            ),
          ),
          el('div', { class: 'field' }, el('label', { text: 'Descripción' }), descInput),
          el('div', { class: 'section-title mt-4', text: 'Costos (por unidad)' }),
          el(
            'div',
            { class: 'form-row form-row-3' },
            el('div', { class: 'field' }, el('label', { text: 'Tela' }), fabricInput),
            el('div', { class: 'field' }, el('label', { text: 'Estampado' }), printInput),
            el('div', { class: 'field' }, el('label', { text: 'Mano de obra' }), laborInput),
          ),
          el('div', { class: 'field' }, el('label', { text: 'Otros' }), otherInput),
          el(
            'div',
            { class: 'btn-group mt-4' },
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Atrás',
              on: {
                click: () => {
                  step = 1;
                  render();
                },
              },
            }),
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Continuar',
              on: {
                click: () => {
                  if (!name.trim()) {
                    showError(new Error('Poné un nombre.'));
                    return;
                  }
                  if (!sku.trim()) {
                    showError(new Error('Poné un SKU.'));
                    return;
                  }
                  step = 3;
                  render();
                },
              },
            }),
          ),
        ),
      }),
    );
  }

  /* ---------------- Paso 3: variantes ---------------- */
  function renderStep3(): void {
    const sizeBoxes = SIZES.map((s) =>
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: selectedSizes.has(s.code),
          on: {
            change: (e: Event) => {
              const checked = (e.target as HTMLInputElement).checked;
              if (checked) selectedSizes.add(s.code);
              else selectedSizes.delete(s.code);
            },
          },
        }),
        el('span', { text: s.label }),
      ),
    );

    const allColors = [...app.state.colors.values()].filter((c) => !c.deletedAt);
    const colorBoxes = allColors.map((c) =>
      el(
        'label',
        { class: 'checkbox' },
        el('input', {
          type: 'checkbox',
          checked: selectedColors.has(c.id),
          on: {
            change: (e: Event) => {
              const checked = (e.target as HTMLInputElement).checked;
              if (checked) selectedColors.add(c.id);
              else selectedColors.delete(c.id);
            },
          },
        }),
        el('span', { class: 'color-dot', style: { background: c.hex } }),
        el('span', { text: c.name }),
      ),
    );

    const total = selectedSizes.size * selectedColors.size;

    stepBox.appendChild(
      card({
        title: '3 · Variantes',
        subtitle: 'Se genera una variante por cada talle × color.',
        content: el(
          'div',
          {},
          el('div', { class: 'section-title', text: 'Talles' }),
          el('div', { class: 'row wrap', style: { gap: '14px' } }, ...sizeBoxes),
          el(
            'div',
            { class: 'row-between mt-4 mb-3' },
            el('div', { class: 'section-title', style: { margin: '0' }, text: 'Colores' }),
            allColors.length === 0
              ? el(
                  'button',
                  {
                    class: 'btn btn-sm',
                    type: 'button',
                    text: '+ Nuevo color',
                    on: { click: () => openCreateColor(app, () => render()) },
                  },
                )
              : null,
          ),
          allColors.length === 0
            ? el('p', { class: 'muted', text: 'Necesitás al menos un color.' })
            : el('div', { class: 'row wrap', style: { gap: '14px' } }, ...colorBoxes),
          el(
            'div',
            { class: 'mt-4 small muted' },
            `Se crearán ${total} variante(s).`,
          ),
          el(
            'div',
            { class: 'btn-group mt-4' },
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Atrás',
              on: {
                click: () => {
                  step = 2;
                  render();
                },
              },
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

export function openCreateCollection(app: App, onCreated: () => void): void {
  const nameInput = el('input', { type: 'text', placeholder: 'Ej: Invierno 2026' });
  const seasonSelect = el(
    'select',
    {},
    ...(['invierno', 'verano', 'otono', 'primavera'] as Season[]).map((s) =>
      el('option', { value: s, text: s }),
    ),
  );
  const yearInput = el('input', { type: 'number', value: String(new Date().getFullYear()) });

  const modal = openModalLazy({
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
      await createCollection(app, {
        name: nameInput.value,
        season: seasonSelect.value as Season,
        year: Number(yearInput.value) || new Date().getFullYear(),
      });
      onCreated();
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
