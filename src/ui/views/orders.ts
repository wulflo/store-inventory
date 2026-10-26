import { el, icon, matches } from '../dom';
import { card, emptyState, money, ORDER_STATUS_LABEL, paymentBadge, statusBadge } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { activeOrders, orderTotals } from '../../projection/queries';
import { dueLabel, formatDate, formatRelative } from '../../core/dates';
import type { OrderStatus, PaymentStatus } from '../../core/types';

type StatusFilter = OrderStatus | 'todos';
type PaymentFilter = PaymentStatus | 'todos';

export function ordersView(app: App, shell: Shell): HTMLElement {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  let statusFilter: StatusFilter = (params.get('estado') as StatusFilter) ?? 'todos';
  let paymentFilter: PaymentFilter = (params.get('pago') as PaymentFilter) ?? 'todos';
  let collectionFilter = params.get('coleccion') ?? 'todas';
  let query = '';

  const view = el('div');
  const listContainer = el('div');

  /* ---------------- Barra de filtros ---------------- */
  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Buscar cliente, SKU o pedido…',
    on: {
      input: () => {
        query = searchInput.value;
        render();
      },
    },
  });

  const statusChips = el(
    'div',
    { class: 'chip-row' },
    ...(['todos', 'pendiente', 'en_produccion', 'listo', 'entregado', 'cancelado'] as const).map(
      (s) =>
        el(
          'button',
          {
            class: `chip${statusFilter === s ? ' active' : ''}`,
            type: 'button',
            dataset: { status: s },
            on: {
              click: (e: Event) => {
                statusFilter = s;
                for (const chip of statusChips.querySelectorAll('.chip')) {
                  chip.classList.toggle('active', chip === e.currentTarget);
                }
                render();
              },
            },
          },
          s === 'todos' ? 'Todos' : ORDER_STATUS_LABEL[s],
        ),
    ),
  );

  const paymentChips = el(
    'div',
    { class: 'chip-row' },
    ...(['todos', 'sin_pagar', 'sena', 'parcial', 'pagado'] as const).map((s) =>
      el(
        'button',
        {
          class: `chip${paymentFilter === s ? ' active' : ''}`,
          type: 'button',
          dataset: { pago: s },
          on: {
            click: (e: Event) => {
              paymentFilter = s;
              for (const chip of paymentChips.querySelectorAll('.chip')) {
                chip.classList.toggle('active', chip === e.currentTarget);
              }
              render();
            },
          },
        },
        s === 'todos' ? 'Todos los pagos' : s.replace('_', ' '),
      ),
    ),
  );

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
      .map((c) => el('option', { value: c.id, text: c.name, selected: collectionFilter === c.id })),
  );

  view.appendChild(
    el(
      'div',
      { class: 'card mb-4' },
      el('div', { class: 'search-box mb-4' }, el('span', { class: 'search-icon' }, icon('search', 18)), searchInput),
      statusChips,
      el('div', { class: 'mt-3' }, paymentChips),
      el('div', { class: 'form-row mt-3' }, collectionSelect),
    ),
  );

  view.appendChild(listContainer);

  /* ---------------- Render ---------------- */
  function render(): void {
    const rows = activeOrders(app.state)
      .filter((o) => {
        if (statusFilter !== 'todos' && o.status !== statusFilter) return false;
        if (paymentFilter !== 'todos') {
          const totals = orderTotals(app.state, o);
          if (totals.paymentStatus !== paymentFilter) return false;
        }
        if (collectionFilter !== 'todas' && o.collectionId !== collectionFilter) return false;
        if (query) {
          const customer = app.state.customers.get(o.customerId)?.name ?? '';
          const haystack = [customer, o.notes ?? '', o.id].join(' ');
          if (!matches(haystack, query)) return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

    listContainer.replaceChildren();

    if (rows.length === 0) {
      listContainer.appendChild(
        card({
          content: emptyState({
            icon: 'orders',
            title: 'No hay pedidos con estos filtros',
            message: 'Probá cambiando los filtros o creá un pedido nuevo.',
            action: el(
              'button',
              {
                class: 'btn btn-primary',
                type: 'button',
                on: { click: () => shell.router.navigate('/pedidos/nuevo') },
              },
              icon('plus', 18),
              'Nuevo pedido',
            ),
          }),
        }),
      );
      return;
    }

    const totalRevenue = rows.reduce((s, o) => s + orderTotals(app.state, o).totalCents, 0);
    const totalBalance = rows.reduce((s, o) => s + orderTotals(app.state, o).balanceCents, 0);

    listContainer.appendChild(
      el(
        'div',
        { class: 'row-between mb-3 wrap' },
        el('span', { class: 'small muted', text: `${rows.length} pedido(s)` }),
        el(
          'span',
          { class: 'small muted' },
          `Total: ${money(totalRevenue)} · Pendiente: ${money(totalBalance)}`,
        ),
      ),
    );

    const list = el('div', { class: 'card' });
    const listEl = el('div', { class: 'list' });

    for (const order of rows) {
      const totals = orderTotals(app.state, order);
      const customer = app.state.customers.get(order.customerId);
      const collection = order.collectionId
        ? app.state.collections.get(order.collectionId)
        : undefined;

      listEl.appendChild(
        el(
          'div',
          {
            class: 'list-item',
            on: { click: () => shell.router.navigate(`/pedidos/${order.id}`) },
          },
          el(
            'div',
            { class: 'list-item-main' },
            el(
              'div',
              { class: 'row', style: { gap: '8px' } },
              el('span', { class: 'list-item-title', text: customer?.name ?? 'Cliente eliminado' }),
              statusBadge(order.status),
              paymentBadge(totals.paymentStatus),
            ),
            el('div', {
              class: 'list-item-sub',
              text: [
                `${totals.units} prd · ${money(totals.totalCents)}`,
                collection?.name,
                dueLabel(order.dueDate),
                formatRelative(order.createdAt),
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
          el(
            'div',
            { class: 'list-item-value' },
            el('div', { text: money(totals.totalCents) }),
            totals.balanceCents > 0
              ? el('div', {
                  class: 'xsmall',
                  style: { color: 'var(--warning)' },
                  text: `debe ${money(totals.balanceCents)}`,
                })
              : el('div', { class: 'xsmall dim', text: formatDate(order.createdAt) }),
          ),
        ),
      );
    }

    list.appendChild(listEl);
    listContainer.appendChild(list);
  }

  render();
  return view;
}
