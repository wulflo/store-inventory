import { el, icon, matches } from '../dom';
import { card, emptyState, money, MOVEMENT_LABEL } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { movementViews } from '../../projection/queries';
import { formatDateTime, parseDateInput, startOfDay } from '../../core/dates';
import type { MovementType } from '../../core/types';

export function movementsView(app: App, shell: Shell): HTMLElement {
  let typeFilter: MovementType | 'todos' = 'todos';
  let query = '';
  let from: number | undefined;
  let to: number | undefined;

  const view = el('div');
  const listBox = el('div');

  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Buscar producto, SKU o motivo…',
    on: {
      input: () => {
        query = searchInput.value;
        render();
      },
    },
  });

  const typeChips = el('div', { class: 'chip-row' });
  function renderChips() {
    typeChips.replaceChildren();
    const items: [MovementType | 'todos', string][] = [
      ['todos', 'Todos'],
      ['produccion', 'Producción'],
      ['venta', 'Ventas'],
      ['ajuste_pos', 'Ajustes +'],
      ['ajuste_neg', 'Ajustes −'],
      ['devolucion', 'Devoluciones'],
      ['inicial', 'Carga inicial'],
    ];
    for (const [key, label] of items) {
      typeChips.appendChild(
        el('button', {
          class: `chip${typeFilter === key ? ' active' : ''}`,
          type: 'button',
          text: label,
          on: {
            click: () => {
              typeFilter = key;
              renderChips();
              render();
            },
          },
        }),
      );
    }
  }
  renderChips();

  const fromInput = el('input', {
    type: 'date',
    on: {
      change: () => {
        from = parseDateInput(fromInput.value) ?? undefined;
        render();
      },
    },
  });

  const toInput = el('input', {
    type: 'date',
    on: {
      change: () => {
        to = parseDateInput(toInput.value) ?? undefined;
        if (to !== undefined) to += 86399999;
        render();
      },
    },
  });

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
      typeChips,
      el(
        'div',
        { class: 'form-row mt-3' },
        el('div', { class: 'field' }, el('label', { text: 'Desde' }), fromInput),
        el('div', { class: 'field' }, el('label', { text: 'Hasta' }), toInput),
      ),
    ),
  );

  view.appendChild(listBox);

  function render(): void {
    let rows = movementViews(app.state);

    if (typeFilter !== 'todos') rows = rows.filter((r) => r.movementType === typeFilter);
    if (from !== undefined) rows = rows.filter((r) => r.performedAt >= from!);
    if (to !== undefined) rows = rows.filter((r) => r.performedAt <= to!);
    if (query) {
      rows = rows.filter((r) =>
        matches(
          [r.productName, r.sku, r.colorName, r.reason ?? '', r.collectionName].join(' '),
          query,
        ),
      );
    }

    listBox.replaceChildren();

    if (rows.length === 0) {
      listBox.appendChild(
        card({
          content: emptyState({
            icon: 'stock',
            title: 'Sin movimientos',
            message: 'No hay movimientos que coincidan con los filtros.',
          }),
        }),
      );
      return;
    }

    const totalIn = rows.filter((r) => r.quantity > 0).reduce((s, r) => s + r.quantity, 0);
    const totalOut = rows.filter((r) => r.quantity < 0).reduce((s, r) => s + Math.abs(r.quantity), 0);

    listBox.appendChild(
      el(
        'div',
        { class: 'row-between wrap mb-3' },
        el('span', { class: 'small muted', text: `${rows.length} movimiento(s)` }),
        el(
          'span',
          { class: 'small muted' },
          `Entradas ${totalIn} · Salidas ${totalOut}`,
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
          el('th', { text: 'Fecha' }),
          el('th', { text: 'Producto' }),
          el('th', { text: 'Variante' }),
          el('th', { text: 'Tipo' }),
          el('th', { class: 'num', text: 'Cant.' }),
          el('th', { class: 'num', text: 'Costo unit.' }),
          el('th', { text: 'Motivo' }),
        ),
      ),
    );

    const tbody = el('tbody');
    for (const r of rows) {
      tbody.appendChild(
        el(
          'tr',
          {},
          el('td', { class: 'small', text: formatDateTime(r.performedAt) }),
          el(
            'td',
            {},
            el('div', { class: 'strong', text: r.productName }),
            el('div', { class: 'xsmall dim', text: r.collectionName }),
          ),
          el(
            'td',
            { class: 'small' },
            el(
              'span',
              { class: 'row', style: { gap: '6px' } },
              el('span', { class: 'color-dot', style: { background: r.colorHex } }),
              el('span', { text: `${r.colorName} · ${r.sizeCode}` }),
            ),
          ),
          el('td', {}, el('span', { class: `badge badge-${r.movementType}`, text: MOVEMENT_LABEL[r.movementType] })),
          el('td', {
            class: 'num strong',
            style: { color: r.quantity > 0 ? 'var(--success)' : 'var(--danger)' },
            text: r.quantity > 0 ? `+${r.quantity}` : String(r.quantity),
          }),
          el('td', { class: 'num small', text: money(r.unitCostCents) }),
          el('td', { class: 'small muted', text: r.reason ?? '—' }),
        ),
      );
    }
    table.appendChild(tbody);
    listBox.appendChild(el('div', { class: 'table-wrap' }, table));
  }

  render();
  void shell;
  void startOfDay;
  return view;
}
