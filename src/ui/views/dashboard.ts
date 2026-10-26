import { el, icon } from '../dom';
import { card, emptyState, kpi, money, ORDER_STATUS_LABEL } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { dashboard } from '../../projection/queries';
import { dueLabel, formatRelative } from '../../core/dates';
import { orderTotals } from '../../projection/queries';

export function dashboardView(app: App, shell: Shell): HTMLElement {
  const d = dashboard(app.state);

  const view = el('div');

  /* ---------------- KPIs ---------------- */
  view.appendChild(
    el(
      'div',
      { class: 'grid grid-4 mb-4' },
      kpi({
        label: 'Ventas del mes',
        value: money(d.monthRevenueCents),
        hint: `${d.openOrdersCount} pedidos abiertos`,
        accent: 'primary',
        icon: 'money',
      }),
      kpi({
        label: 'Ganancia del mes',
        value: money(d.monthProfitCents),
        hint: `gastos: ${money(d.monthExpensesCents)}`,
        accent: 'success',
        icon: 'reports',
      }),
      kpi({
        label: 'Por cobrar',
        value: money(d.toCollect.reduce((s, o) => s + o.balanceCents, 0)),
        hint: `${d.toCollect.length} pedidos con saldo`,
        accent: 'warning',
        icon: 'orders',
      }),
      kpi({
        label: 'A producir',
        value: String(d.toProduce.reduce((s, p) => s + p.suggestQty, 0)),
        hint: 'unidades sugeridas',
        accent: 'danger',
        icon: 'production',
      }),
    ),
  );

  /* ---------------- Entregar hoy ---------------- */
  const deliverCard = card({
    title: 'Qué entregar hoy',
    count: d.toDeliverToday.length,
    action: el(
      'button',
      {
        class: 'card-link',
        type: 'button',
        on: { click: () => shell.router.navigate('/pedidos') },
      },
      'Ver pedidos',
    ),
    content:
      d.toDeliverToday.length === 0
        ? emptyState({
            icon: 'check',
            title: 'Nada para entregar hoy',
            message: 'When you schedule a delivery for today, it shows up here.',
          })
        : el(
            'div',
            { class: 'list' },
            ...d.toDeliverToday.map((item) => {
              const totals = orderTotals(app.state, item.order);
              return el(
                'div',
                {
                  class: 'list-item',
                  on: { click: () => shell.router.navigate(`/pedidos/${item.order.id}`) },
                },
                el(
                  'div',
                  { class: 'list-item-main' },
                  el('div', {
                    class: 'list-item-title',
                    text: item.customer?.name ?? 'Cliente eliminado',
                  }),
                  el('div', {
                    class: 'list-item-sub',
                    text: `${ORDER_STATUS_LABEL[item.order.status]} · ${dueLabel(item.order.dueDate)}`,
                  }),
                ),
                item.overdue
                  ? el('span', { class: 'badge badge-danger', text: 'Vencido' })
                  : null,
                el(
                  'div',
                  { class: 'list-item-value' },
                  el('div', { text: money(totals.totalCents) }),
                  el('div', {
                    class: 'xsmall dim',
                    text: totals.balanceCents > 0 ? `debe ${money(totals.balanceCents)}` : 'pagado',
                  }),
                ),
              );
            }),
          ),
  });
  view.appendChild(deliverCard);

  /* ---------------- Producción de la semana ---------------- */
  const produceCard = card({
    title: 'Qué producir esta semana',
    count: d.productionThisWeek.length,
    action: el(
      'button',
      {
        class: 'card-link',
        type: 'button',
        on: { click: () => shell.router.navigate('/produccion') },
      },
      'Ir a producción',
    ),
    content:
      d.productionThisWeek.length === 0 && d.toProduce.length === 0
        ? emptyState({
            icon: 'production',
            title: 'Sin producción pendiente',
            message: 'Cuando tengas pedidos con faltantes, te sugerimos qué producir.',
          })
        : el(
            'div',
            { class: 'list' },
            ...d.productionThisWeek.slice(0, 6).map((po) =>
              el(
                'div',
                {
                  class: 'list-item',
                  on: { click: () => shell.router.navigate('/produccion') },
                },
                el('div', { class: 'list-item-main' }, el('div', {
                  class: 'list-item-title',
                  text: `Orden de producción · ${formatRelative(po.order.scheduledDate)}`,
                }), el('div', {
                  class: 'list-item-sub',
                  text: `${po.totalRemaining} unidades pendientes`,
                })),
                po.isOverdue
                  ? el('span', { class: 'badge badge-danger', text: 'Atrasada' })
                  : el('span', { class: 'badge badge-planificada', text: po.order.status }),
              ),
            ),
            ...d.toProduce.slice(0, 6).map((s) =>
              el(
                'div',
                {
                  class: 'list-item',
                  on: { click: () => shell.router.navigate('/produccion/nueva') },
                },
                s.color
                  ? el('span', { class: 'color-dot', style: { background: s.color.hex } })
                  : null,
                el(
                  'div',
                  { class: 'list-item-main' },
                  el('div', {
                    class: 'list-item-title',
                    text: `${s.product?.name ?? 'Producto'} · ${s.variant.sizeCode}`,
                  }),
                  el('div', {
                    class: 'list-item-sub',
                    text: `faltan ${s.suggestQty} (hay ${s.availableQty} disponibles)`,
                  }),
                ),
                el('div', { class: 'list-item-value' }, el('div', { text: String(s.suggestQty) })),
              ),
            ),
          ),
  });
  view.appendChild(produceCard);

  /* ---------------- Cobrar ---------------- */
  const collectCard = card({
    title: 'Qué cobrar',
    count: d.toCollect.length,
    action: el(
      'button',
      {
        class: 'card-link',
        type: 'button',
        on: { click: () => shell.router.navigate('/pedidos?pago=pendiente') },
      },
      'Ver todos',
    ),
    content:
      d.toCollect.length === 0
        ? emptyState({
            icon: 'check',
            title: 'Nada pendiente de cobro',
            message: 'Todos los pedidos están pagados.',
          })
        : el(
            'div',
            { class: 'list' },
            ...d.toCollect.map((item) =>
              el(
                'div',
                {
                  class: 'list-item',
                  on: { click: () => shell.router.navigate(`/pedidos/${item.order.id}`) },
                },
                el(
                  'div',
                  { class: 'list-item-main' },
                  el('div', {
                    class: 'list-item-title',
                    text: item.customer?.name ?? 'Cliente eliminado',
                  }),
                  el('div', {
                    class: 'list-item-sub',
                    text:
                      item.daysOverdue > 0
                        ? `${item.daysOverdue} días de atraso`
                        : dueLabel(item.order.dueDate),
                  }),
                ),
                el('div', { class: 'list-item-value' }, money(item.balanceCents)),
              ),
            ),
          ),
  });
  view.appendChild(collectCard);

  /* ---------------- Stock ---------------- */
  const stockCard = card({
    title: 'Stock que se está agotando',
    count: d.lowStock.length + d.outOfStock.length,
    action: el(
      'button',
      {
        class: 'card-link',
        type: 'button',
        on: { click: () => shell.router.navigate('/stock') },
      },
      'Ver stock',
    ),
    content:
      d.lowStock.length === 0 && d.outOfStock.length === 0
        ? emptyState({
            icon: 'stock',
            title: 'Todo el stock está por encima del mínimo',
            message: 'Te avisamos acá cuando algo se esté por agotar.',
          })
        : el(
            'div',
            { class: 'list' },
            ...[...d.outOfStock, ...d.lowStock].slice(0, 8).map((row) =>
              el(
                'div',
                {
                  class: 'list-item',
                  on: { click: () => shell.router.navigate('/stock') },
                },
                row.color
                  ? el('span', { class: 'color-dot', style: { background: row.color.hex } })
                  : null,
                el(
                  'div',
                  { class: 'list-item-main' },
                  el('div', {
                    class: 'list-item-title',
                    text: `${row.product?.name ?? 'Producto'} · ${row.variant?.sizeCode}`,
                  }),
                  el('div', {
                    class: 'list-item-sub',
                    text: `${row.collection?.name ?? ''}`,
                  }),
                ),
                el(
                  'div',
                  { class: 'list-item-value' },
                  el('div', {
                    text: String(row.aggregate.availableQty),
                    style: { color: row.aggregate.availableQty <= 0 ? 'var(--danger)' : 'var(--warning)' },
                  }),
                  el('div', { class: 'xsmall dim', text: 'disponibles' }),
                ),
              ),
            ),
          ),
  });
  view.appendChild(stockCard);

  /* ---------------- Top productos ---------------- */
  const topCard = card({
    title: 'Qué se vende más',
    count: d.topProducts.length,
    action: el(
      'button',
      {
        class: 'card-link',
        type: 'button',
        on: { click: () => shell.router.navigate('/reportes') },
      },
      'Ver reportes',
    ),
    content:
      d.topProducts.length === 0
        ? emptyState({
            icon: 'products',
            title: 'Todavía no hay ventas',
            message: 'Cuando cargues pedidos vas a ver acá lo que más sale.',
          })
        : el(
            'div',
            { class: 'list' },
            ...d.topProducts.map((p) =>
              el(
                'div',
                {
                  class: 'list-item',
                  on: { click: () => shell.router.navigate('/productos') },
                },
                el('div', { class: 'list-item-main' }, el('div', {
                  class: 'list-item-title',
                  text: p.product.name,
                }), el('div', {
                  class: 'list-item-sub',
                  text: `${p.unitsSold} vendidas · ${p.collection?.name ?? ''}`,
                })),
                el(
                  'div',
                  { class: 'list-item-value' },
                  el('div', { text: money(p.revenueCents) }),
                  el('div', {
                    class: 'xsmall',
                    style: { color: p.marginPercent >= 30 ? 'var(--success)' : 'var(--warning)' },
                    text: `${p.marginPercent.toFixed(0)}% margen`,
                  }),
                ),
              ),
            ),
          ),
  });
  view.appendChild(topCard);

  void icon;
  return view;
}
