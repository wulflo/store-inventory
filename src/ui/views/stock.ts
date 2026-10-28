import { el, icon, matches } from '../dom';
import { card, emptyState, money } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { lowStockRows, stockRows } from '../../projection/queries';
import { showError, toastSuccess } from '../components/toast';
import { addStockMovement, deleteProduct } from '../../domain/commands';
import { confirmDialog, openModal } from '../components/modal';
import { formatDateTime } from '../../core/dates';
import { parseMoneyToCents } from '../../core/money';
import type { MovementType, Variant } from '../../core/types';

type Filter = 'todos' | 'alertas' | 'sin_stock';

export function stockView(app: App, shell: Shell): HTMLElement {
  let filter: Filter = 'todos';
  let query = '';
  let collectionFilter = 'todas';

  const view = el('div');
  const listBox = el('div');

  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Buscar producto, SKU o color…',
    on: {
      input: () => {
        query = searchInput.value;
        render();
      },
    },
  });

  const filterChips = el('div', { class: 'chip-row' });
  function renderChips() {
    filterChips.replaceChildren();
    const items: [Filter, string][] = [
      ['todos', 'Todos'],
      ['alertas', 'En alerta'],
      ['sin_stock', 'Sin stock'],
    ];
    for (const [key, label] of items) {
      filterChips.appendChild(
        el('button', {
          class: `chip${filter === key ? ' active' : ''}`,
          type: 'button',
          text: label,
          on: {
            click: () => {
              filter = key;
              renderChips();
              render();
            },
          },
        }),
      );
    }
  }
  renderChips();

  const collectionSelect = el(
    'select',
    {
      on: {
        change: () => {
          collectionFilter = collectionSelect.value;
          render();
        },
      },
    },
    el('option', { value: 'todas', text: 'Todas las colecciones' }),
    ...[...app.state.collections.values()]
      .filter((c) => !c.deletedAt)
      .map((c) => el('option', { value: c.id, text: c.name })),
  );

  view.appendChild(
    el(
      'div',
      { class: 'card mb-4' },
      el(
        'div',
        { class: 'search-box mb-4' },
        el('span', { class: 'search-icon' }, icon('search', 18)),
        searchInput,
      ),
      filterChips,
      el('div', { class: 'mt-3' }, collectionSelect),
    ),
  );

  view.appendChild(listBox);

  function render(): void {
    let rows = stockRows(app.state);

    if (filter === 'alertas') rows = rows.filter((r) => r.aggregate.lowStockAlert);
    if (filter === 'sin_stock') rows = rows.filter((r) => r.aggregate.totalQty <= 0);

    if (collectionFilter !== 'todas') {
      rows = rows.filter((r) => r.collection?.id === collectionFilter);
    }

    if (query) {
      rows = rows.filter((r) =>
        matches(
          [
            r.product?.name ?? '',
            r.variant?.sku ?? '',
            r.color?.name ?? '',
            r.collection?.name ?? '',
            r.variant?.sizeCode ?? '',
          ].join(' '),
          query,
        ),
      );
    }

    rows.sort((a, b) => {
      if (a.collection?.name !== b.collection?.name) {
        return (a.collection?.name ?? '').localeCompare(b.collection?.name ?? '');
      }
      if (a.product?.name !== b.product?.name) {
        return (a.product?.name ?? '').localeCompare(b.product?.name ?? '');
      }
      return (a.variant?.sortOrder ?? 0) - (b.variant?.sortOrder ?? 0);
    });

    listBox.replaceChildren();

    if (rows.length === 0) {
      listBox.appendChild(
        card({
          content: emptyState({
            icon: 'stock',
            title: 'Sin resultados',
            message: 'Probá con otro filtro o buscá distinto.',
          }),
        }),
      );
      return;
    }

    const totalUnits = rows.reduce((s, r) => s + r.aggregate.totalQty, 0);
    const reservedUnits = rows.reduce((s, r) => s + r.aggregate.reservedQty, 0);
    const availableUnits = rows.reduce((s, r) => s + r.aggregate.availableQty, 0);

    listBox.appendChild(
      el(
        'div',
        { class: 'grid grid-3 mb-4' },
        el(
          'div',
          { class: 'kpi' },
          el('div', { class: 'kpi-label', text: 'En stock' }),
          el('div', { class: 'kpi-value', text: String(totalUnits) }),
          el('div', { class: 'kpi-hint', text: 'unidades totales' }),
        ),
        el(
          'div',
          { class: 'kpi accent-warning' },
          el('div', { class: 'kpi-label', text: 'Comprometidas' }),
          el('div', { class: 'kpi-value', text: String(reservedUnits) }),
          el('div', { class: 'kpi-hint', text: 'reservadas por pedidos' }),
        ),
        el(
          'div',
          { class: 'kpi accent-success' },
          el('div', { class: 'kpi-label', text: 'Disponibles' }),
          el('div', { class: 'kpi-value', text: String(availableUnits) }),
          el('div', { class: 'kpi-hint', text: 'libres para vender' }),
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
          el('th', { text: 'Producto' }),
          el('th', { text: 'Color' }),
          el('th', { text: 'Talle' }),
          el('th', { class: 'num', text: 'Stock' }),
          el('th', { class: 'num', text: 'Comprom.' }),
          el('th', { class: 'num', text: 'Dispon.' }),
          el('th', { text: '' }),
        ),
      ),
    );

    const tbody = el('tbody');
    for (const row of rows) {
      const agg = row.aggregate;
      const last = row.variant ? app.state.stock.get(row.variant.id)?.lastMovementAt : undefined;
      tbody.appendChild(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            el('div', { class: 'strong', text: row.product?.name ?? '—' }),
            el('div', { class: 'xsmall dim', text: row.variant?.sku ?? '' }),
          ),
          el(
            'td',
            {},
            el(
              'span',
              { class: 'row', style: { gap: '6px' } },
              row.color ? el('span', { class: 'color-dot', style: { background: row.color.hex } }) : null,
              el('span', { text: row.color?.name ?? '—' }),
            ),
          ),
          el('td', { text: row.variant?.sizeCode ?? '—' }),
          el('td', { class: 'num strong', text: String(agg.totalQty) }),
          el('td', {
            class: 'num',
            style: { color: agg.reservedQty > 0 ? 'var(--warning)' : 'inherit' },
            text: String(agg.reservedQty),
          }),
          el('td', {
            class: 'num strong',
            style: {
              color:
                agg.availableQty <= 0
                  ? 'var(--danger)'
                  : agg.lowStockAlert
                    ? 'var(--warning)'
                    : 'var(--success)',
            },
            text: String(agg.availableQty),
          }),
          el(
            'td',
            {},
            el(
              'div',
              { class: 'row', style: { gap: '4px' } },
              el(
                'button',
                {
                  class: 'btn btn-sm',
                  type: 'button',
                  text: 'Fijar',
                  title: 'Fijar la cantidad real en stock',
                  on: { click: () => openSetStock(app, row.variant!) },
                },
              ),
              el(
                'button',
                {
                  class: 'btn btn-sm btn-ghost',
                  type: 'button',
                  text: 'Movimiento',
                  title: last ? `Último: ${formatDateTime(last)}` : '',
                  on: { click: () => openMovement(app, row.variant!) },
                },
              ),
              el(
                'button',
                {
                  class: 'btn btn-sm btn-ghost',
                  type: 'button',
                  title: 'Eliminar producto',
                  'aria-label': 'Eliminar producto',
                  on: {
                    click: async () => {
                      const product = row.product;
                      if (!product) return;
                      const ok = await confirmDialog({
                        title: 'Eliminar producto',
                        message: `¿Eliminar "${product.name}"? Se archiva el producto y todas sus variantes dejan de aparecer en Stock. Los pedidos históricos se conservan.`,
                        confirmLabel: 'Eliminar',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await deleteProduct(app, product.id);
                        toastSuccess('Producto eliminado.');
                        render();
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
        ),
      );
    }
    table.appendChild(tbody);

    listBox.appendChild(el('div', { class: 'table-wrap' }, table));
  }

  render();
  return view;
}

/* ------------------------------------------------------------------ */

/** Fija la cantidad real en stock generando el ajuste necesario. */
export function openSetStock(app: App, variant: Variant): void {
  const product = app.state.products.get(variant.productId);
  const color = app.state.colors.get(variant.colorId);
  const agg = app.state.stock.get(variant.id);
  const current = agg?.totalQty ?? 0;

  const qtyInput = el('input', {
    type: 'number',
    min: '0',
    value: String(current),
    inputmode: 'numeric',
  });
  const reasonInput = el('input', { type: 'text', placeholder: 'Motivo (ej. conteo manual)' });

  const modal = openModal({
    title: 'Fijar stock real',
    subtitle: `${product?.name ?? ''} · ${variant.sizeCode} · ${color?.name ?? ''}`,
    body: el(
      'div',
      {},
      el('p', {
        class: 'small muted mb-4',
        text: `Ahora hay ${current} unidades. Ingresá la cantidad real contada y se registrará el ajuste.`,
      }),
      el('div', { class: 'field' }, el('label', { text: 'Cantidad real' }), qtyInput),
      el('div', { class: 'field' }, el('label', { text: 'Motivo' }), reasonInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Guardar ajuste',
        on: {
          click: async () => {
            const target = Math.max(0, Math.floor(Number(qtyInput.value) || 0));
            const delta = target - current;
            if (delta === 0) {
              modal.close();
              return;
            }
            try {
              await addStockMovement(app, {
                variantId: variant.id,
                movementType: delta > 0 ? 'ajuste_pos' : 'ajuste_neg',
                quantity: delta,
                reason: reasonInput.value || 'Conteo manual',
              });
              modal.close();
              toastSuccess(
                `Stock fijado en ${target} (${delta > 0 ? '+' : ''}${delta} unidades).`,
              );
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}

export function openMovement(app: App, variant: Variant): void {
  const product = app.state.products.get(variant.productId);
  const color = app.state.colors.get(variant.colorId);
  const agg = app.state.stock.get(variant.id);

  const typeSelect = el(
    'select',
    {},
    el('option', { value: 'ajuste_pos', text: 'Ajuste positivo (entrada)' }),
    el('option', { value: 'ajuste_neg', text: 'Ajuste negativo (merma/rotura)' }),
    el('option', { value: 'devolucion', text: 'Devolución de cliente' }),
    el('option', { value: 'inicial', text: 'Carga inicial' }),
  );

  const qtyInput = el('input', { type: 'number', min: '1', value: '1', inputmode: 'numeric' });
  const reasonInput = el('input', { type: 'text', placeholder: 'Motivo (opcional)' });

  const modal = openModal({
    title: `Movimiento de stock`,
    subtitle: `${product?.name ?? ''} · ${variant.sizeCode} · ${color?.name ?? ''}`,
    body: el(
      'div',
      {},
      el(
        'div',
        { class: 'small muted mb-4' },
        `Ahora: ${agg?.totalQty ?? 0} en stock · ${agg?.reservedQty ?? 0} comprometidas · ${
          agg?.availableQty ?? 0
        } disponibles`,
      ),
      el('div', { class: 'field' }, el('label', { text: 'Tipo de movimiento' }), typeSelect),
      el('div', { class: 'field' }, el('label', { text: 'Cantidad' }), qtyInput),
      el('div', { class: 'field' }, el('label', { text: 'Motivo' }), reasonInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Registrar',
        on: {
          click: async () => {
            const qty = Math.floor(Number(qtyInput.value) || 0);
            if (qty <= 0) {
              showError(new Error('La cantidad debe ser mayor a cero.'));
              return;
            }
            const type = typeSelect.value as MovementType;
            const sign = type === 'ajuste_neg' ? -1 : 1;
            try {
              await addStockMovement(app, {
                variantId: variant.id,
                movementType: type,
                quantity: sign * qty,
                reason: reasonInput.value || undefined,
              });
              modal.close();
              toastSuccess('Movimiento registrado.');
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}

export { parseMoneyToCents, money };
