import { el, icon } from '../dom';
import { card, emptyState, money } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { collectionSummaries, productSummaries } from '../../projection/queries';
import { showError, toastSuccess } from '../components/toast';
import { deleteProduct, updateProduct, updateVariant, generateVariants } from '../../domain/commands';
import { confirmDialog, openModal } from '../components/modal';
import { SIZES } from '../../core/sizes';
import { parseMoneyToCents } from '../../core/money';

export function productsView(app: App, shell: Shell): HTMLElement {
  const view = el('div');
  const container = el('div');

  view.appendChild(
    el(
      'div',
      { class: 'row-between wrap mb-4' },
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          on: { click: () => shell.router.navigate('/productos/nuevo') },
        },
        icon('plus', 18),
        'Nuevo producto',
      ),
    ),
  );
  view.appendChild(container);

  function render(): void {
    container.replaceChildren();

    const collections = collectionSummaries(app.state);
    const products = productSummaries(app.state);

    if (collections.length === 0) {
      container.appendChild(
        card({
          content: emptyState({
            icon: 'products',
            title: 'Todavía no hay catálogo',
            message: 'Creá tu primera colección y producto para empezar a vender.',
            action: el(
              'button',
              {
                class: 'btn btn-primary',
                type: 'button',
                on: { click: () => shell.router.navigate('/productos/nuevo') },
              },
              'Crear producto',
            ),
          }),
        }),
      );
      return;
    }

    for (const summary of collections) {
      const collProducts = products.filter((p) => p.product.collectionId === summary.collection.id);

      const productList = el('div', { class: 'list' });
      for (const ps of collProducts) {
        const variants = [...(app.state.variantsByProduct.get(ps.product.id) ?? [])]
          .map((vid) => app.state.variants.get(vid))
          .filter((v) => v && !v.deletedAt);

        productList.appendChild(
          el(
            'div',
            { class: 'list-item', style: { cursor: 'default' } },
            el(
              'div',
              { class: 'list-item-main' },
              el(
                'div',
                { class: 'row', style: { gap: '8px' } },
                el('span', { class: 'list-item-title', text: ps.product.name }),
                el('span', {
                  class: `badge badge-${ps.product.type === 'buzo' ? 'info' : 'primary'}`,
                  text: ps.product.type,
                }),
                !ps.product.isActive ? el('span', { class: 'badge', text: 'archivado' }) : null,
              ),
              el('div', {
                class: 'list-item-sub',
                text: [
                  ps.product.sku,
                  `${variants.length} variantes`,
                  `${ps.stockRemaining} en stock`,
                  `${ps.unitsSold} vendidas`,
                ].join(' · '),
              }),
            ),
            el(
              'div',
              { class: 'list-item-value' },
              el('div', { text: money(ps.product.basePriceCents) }),
              el('div', {
                class: 'xsmall',
                style: { color: ps.marginPercent >= 30 ? 'var(--success)' : 'var(--warning)' },
                text: `${ps.marginPercent.toFixed(0)}% margen`,
              }),
            ),
            el(
              'div',
              { class: 'row', style: { gap: '4px' } },
              el(
                'button',
                {
                  class: 'btn btn-sm btn-ghost',
                  type: 'button',
                  title: 'Editar producto',
                  on: { click: () => openEditProduct(app, ps.product.id, render) },
                },
                'Editar',
              ),
              el(
                'button',
                {
                  class: 'btn btn-sm btn-ghost',
                  type: 'button',
                  title: 'Variantes y stock mínimo',
                  on: { click: () => openVariants(app, ps.product.id) },
                },
                'Variantes',
              ),
              el(
                'button',
                {
                  class: 'btn-icon',
                  type: 'button',
                  title: 'Archivar producto',
                  on: {
                    click: async () => {
                      const ok = await confirmDialog({
                        title: 'Archivar producto',
                        message: `El producto "${ps.product.name}" dejará de aparecer en los pedidos nuevos.`,
                        confirmLabel: 'Archivar',
                      });
                      if (!ok) return;
                      try {
                        await deleteProduct(app, ps.product.id);
                        toastSuccess('Producto archivado.');
                      } catch (err) {
                        showError(err);
                      }
                    },
                  },
                },
                icon('trash', 16),
              ),
            ),
          ),
        );
      }

      container.appendChild(
        card({
          title: summary.collection.name,
          count: `${collProducts.length} producto(s)`,
          content: el(
            'div',
            {},
            el(
              'div',
              { class: 'grid grid-4 mb-4' },
              miniStat('Producidas', String(summary.unitsProduced)),
              miniStat('Vendidas', String(summary.unitsSold)),
              miniStat('En stock', String(summary.stockRemaining)),
              miniStat('Ganancia', money(summary.profitCents)),
            ),
            collProducts.length === 0
              ? emptyState({ icon: 'box', title: 'Sin productos en esta colección' })
              : productList,
          ),
        }),
      );
    }
  }

  render();
  return view;
}

function miniStat(label: string, value: string): HTMLElement {
  return el(
    'div',
    {},
    el('div', { class: 'xsmall dim', text: label }),
    el('div', { class: 'strong', style: { fontSize: '1.05rem' }, text: value }),
  );
}

/* ------------------------------------------------------------------ */

/** Edición de los datos principales del producto. */
export function openEditProduct(app: App, productId: string, onDone?: () => void): void {
  const product = app.state.products.get(productId);
  if (!product) return;

  const collections = [...app.state.collections.values()].filter((c) => !c.deletedAt);
  const nameInput = el('input', { type: 'text', value: product.name });
  const skuInput = el('input', { type: 'text', value: product.sku });
  const typeSelect = el(
    'select',
    {},
    el('option', { value: 'remera', text: 'Remera', selected: product.type === 'remera' }),
    el('option', { value: 'buzo', text: 'Buzo', selected: product.type === 'buzo' }),
  );
  const collectionSelect = el(
    'select',
    {},
    ...collections.map((c) =>
      el('option', { value: c.id, text: c.name, selected: c.id === product.collectionId }),
    ),
  );
  const priceInput = moneyInput(product.basePriceCents, () => {});
  const descInput = el('textarea', { rows: '2', value: product.description ?? '' });
  const fabricInput = moneyInput(product.costFabricCents, () => {});
  const printInput = moneyInput(product.costPrintCents, () => {});
  const laborInput = moneyInput(product.costLaborCents, () => {});
  const otherInput = moneyInput(product.costOtherCents, () => {});

  const modal = openModal({
    title: 'Editar producto',
    subtitle: product.sku,
    wide: true,
    body: el(
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
        el('div', { class: 'field' }, el('label', { text: 'Colección' }), collectionSelect),
      ),
      el('div', { class: 'field' }, el('label', { text: 'Precio de venta' }), priceInput),
      el('div', { class: 'field' }, el('label', { text: 'Descripción' }), descInput),
      el('div', { class: 'section-title mt-4', text: 'Costos por unidad' }),
      el(
        'div',
        { class: 'form-row form-row-3' },
        el('div', { class: 'field' }, el('label', { text: 'Tela' }), fabricInput),
        el('div', { class: 'field' }, el('label', { text: 'Estampado' }), printInput),
        el('div', { class: 'field' }, el('label', { text: 'Mano de obra' }), laborInput),
      ),
      el('div', { class: 'field' }, el('label', { text: 'Otros' }), otherInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Guardar cambios',
        on: {
          click: async () => {
            try {
              await updateProduct(app, productId, {
                name: nameInput.value.trim(),
                sku: skuInput.value.trim(),
                type: typeSelect.value as 'remera' | 'buzo',
                collectionId: collectionSelect.value,
                description: descInput.value.trim() || undefined,
                basePriceCents: parseMoneyInput(priceInput.value),
                costFabricCents: parseMoneyInput(fabricInput.value),
                costPrintCents: parseMoneyInput(printInput.value),
                costLaborCents: parseMoneyInput(laborInput.value),
                costOtherCents: parseMoneyInput(otherInput.value),
              });
              modal.close();
              toastSuccess('Producto actualizado.');
              onDone?.();
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}

function moneyInput(initialCents: number, onChange: (cents: number) => void): HTMLInputElement {
  const input = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: initialCents ? (initialCents / 100).toFixed(2).replace('.', ',') : '',
    placeholder: '0,00',
    on: {
      input: () => onChange(parseMoneyInput(input.value)),
    },
  });
  return input;
}

function parseMoneyInput(value: string): number {
  const cents = parseMoneyToCents(value);
  return cents ?? 0;
}

/** Modal de variantes: stock mínimo, costo, precio y generación masiva. */
export function openVariants(app: App, productId: string): void {
  const product = app.state.products.get(productId);
  if (!product) return;

  const body = el('div');

  const render = () => {
    body.replaceChildren();

    const variants = [...(app.state.variantsByProduct.get(productId) ?? [])]
      .map((vid) => app.state.variants.get(vid))
      .filter((v) => v && !v.deletedAt)
      .sort(
        (a, b) =>
          (a!.colorId ?? '').localeCompare(b!.colorId ?? '') ||
          SIZES.findIndex((s) => s.code === a!.sizeCode) - SIZES.findIndex((s) => s.code === b!.sizeCode),
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
          el('th', { text: 'SKU' }),
          el('th', { class: 'num', text: 'Stock' }),
          el('th', { class: 'num', text: 'Mín.' }),
          el('th', { class: 'num', text: 'Costo' }),
        ),
      ),
    );
    const tbody = el('tbody');

    for (const v of variants) {
      const variant = v!;
      const color = app.state.colors.get(variant.colorId);
      const agg = app.state.stock.get(variant.id);

      const minInput = el('input', {
        type: 'number',
        min: '0',
        value: String(variant.minStock),
        style: { width: '70px', padding: '5px 8px' },
        on: {
          change: async () => {
            try {
              await updateVariant(app, variant.id, {
                minStock: Math.max(0, Math.floor(Number(minInput.value) || 0)),
              });
              toastSuccess('Stock mínimo actualizado.');
            } catch (err) {
              showError(err);
            }
          },
        },
      });

      const costInput = el('input', {
        type: 'text',
        value: (variant.costCents / 100).toFixed(2).replace('.', ','),
        style: { width: '90px', padding: '5px 8px', textAlign: 'right' },
        on: {
          change: async () => {
            const raw = costInput.value.replace(/\./g, '').replace(',', '.');
            const cents = Math.round(Number(raw) * 100);
            if (!Number.isFinite(cents) || cents < 0) {
              showError(new Error('Costo inválido.'));
              render();
              return;
            }
            try {
              await updateVariant(app, variant.id, { costCents: cents });
              toastSuccess('Costo actualizado.');
            } catch (err) {
              showError(err);
            }
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
              el('span', { class: 'color-dot', style: { background: color?.hex ?? '#888' } }),
              el('span', { text: color?.name ?? '—' }),
            ),
          ),
          el('td', { text: variant.sizeCode }),
          el('td', { class: 'mono xsmall', text: variant.sku }),
          el('td', { class: 'num', text: String(agg?.totalQty ?? 0) }),
          el('td', { class: 'num' }, minInput),
          el('td', { class: 'num' }, costInput),
        ),
      );
    }
    table.appendChild(tbody);

    body.appendChild(
      el('div', { class: 'table-wrap mb-4' }, variants.length ? table : emptyState({
        icon: 'stock',
        title: 'Sin variantes',
        message: 'Generá las combinaciones de talle y color.',
      })),
    );

    body.appendChild(
      el(
        'button',
        {
          class: 'btn btn-sm',
          type: 'button',
          text: 'Generar variantes faltantes',
          on: { click: () => openGenerate(app, productId, render) },
        },
        icon('plus', 16),
        'Generar variantes',
      ),
    );
  };

  render();

  const modal = openModal({
    title: product.name,
    subtitle: product.sku,
    wide: true,
    body,
  });
}

function openGenerate(app: App, productId: string, onDone: () => void): void {
  const sizes = new Set(SIZES.map((s) => s.code));
  const colors = new Set(
    [...app.state.colors.values()].filter((c) => !c.deletedAt).map((c) => c.id),
  );

  const sizeBoxes = SIZES.map((s) =>
    el(
      'label',
      { class: 'checkbox' },
      el('input', { type: 'checkbox', checked: true, value: s.code }),
      el('span', { text: s.label }),
    ),
  );

  const colorBoxes = [...app.state.colors.values()]
    .filter((c) => !c.deletedAt)
    .map((c) =>
      el(
        'label',
        { class: 'checkbox' },
        el('input', { type: 'checkbox', checked: true, value: c.id }),
        el('span', { class: 'color-dot', style: { background: c.hex } }),
        el('span', { text: c.name }),
      ),
    );

  const modal = openModal({
    title: 'Generar variantes',
    subtitle: 'Se crean las combinaciones que falten.',
    body: el(
      'div',
      {},
      el('div', { class: 'section-title', text: 'Talles' }),
      el('div', { class: 'row wrap', style: { gap: '12px' } }, ...sizeBoxes),
      el('div', { class: 'section-title mt-4', text: 'Colores' }),
      el('div', { class: 'row wrap', style: { gap: '12px' } }, ...colorBoxes),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Generar',
        on: {
          click: async () => {
            const selectedSizes = sizeBoxes
              .map((b) => (b.querySelector('input') as HTMLInputElement).checked ? b.querySelector('input')!.value : null)
              .filter(Boolean) as string[];
            const selectedColors = colorBoxes
              .map((b) => (b.querySelector('input') as HTMLInputElement).checked ? b.querySelector('input')!.value : null)
              .filter(Boolean) as string[];

            try {
              const n = await generateVariants(app, productId, selectedSizes as any, selectedColors);
              modal.close();
              onDone();
              toastSuccess(n > 0 ? `Se crearon ${n} variantes.` : 'No había variantes faltantes.');
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });

  void sizes;
  void colors;
}
