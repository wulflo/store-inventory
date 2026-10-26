import { el, icon } from '../dom';
import { card, emptyState, money, PRODUCTION_STATUS_LABEL } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { productionOrderViews, productionSuggestions } from '../../projection/queries';
import { formatDate, formatWeekday, startOfWeek, endOfWeek } from '../../core/dates';
import { showError, toastSuccess } from '../components/toast';
import { completeProductionLine, updateProductionOrder } from '../../domain/commands';
import { openModal } from '../components/modal';

export function productionView(app: App, shell: Shell): HTMLElement {
  const view = el('div');
  const container = el('div');

  const tabs = el('div', { class: 'tabs' });
  let activeTab: 'semana' | 'ordenes' | 'sugerencias' = 'semana';

  function renderTabs() {
    tabs.replaceChildren();
    const items: [typeof activeTab, string][] = [
      ['semana', 'Esta semana'],
      ['ordenes', 'Órdenes'],
      ['sugerencias', 'Sugerencias'],
    ];
    for (const [key, label] of items) {
      tabs.appendChild(
        el('button', {
          class: `tab${activeTab === key ? ' active' : ''}`,
          type: 'button',
          text: label,
          on: {
            click: () => {
              activeTab = key;
              renderTabs();
              render();
            },
          },
        }),
      );
    }
  }

  view.appendChild(
    el(
      'div',
      { class: 'row-between wrap mb-4' },
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          on: { click: () => shell.router.navigate('/produccion/nueva') },
        },
        icon('plus', 18),
        'Nueva orden de producción',
      ),
    ),
  );
  view.appendChild(tabs);
  view.appendChild(container);

  function render(): void {
    container.replaceChildren();

    if (activeTab === 'semana') renderWeek();
    else if (activeTab === 'ordenes') renderOrders();
    else renderSuggestions();
  }

  /* ---------------- Esta semana ---------------- */
  function renderWeek(): void {
    const now = Date.now();
    const weekStart = startOfWeek(now);
    const weekEnd = endOfWeek(now);
    const views = productionOrderViews(app.state, now);
    const thisWeek = views.filter(
      (v) => v.order.scheduledDate >= weekStart && v.order.scheduledDate <= weekEnd && v.order.status !== 'cancelada',
    );

    container.appendChild(
      el('div', {
        class: 'small dim mb-4',
        text: `Semana del ${formatDate(weekStart)} al ${formatDate(weekEnd)}`,
      }),
    );

    if (thisWeek.length === 0) {
      container.appendChild(
        card({
          content: emptyState({
            icon: 'production',
            title: 'Sin producción programada esta semana',
            message: 'Mirá las sugerencias para saber qué conviene producir.',
            action: el(
              'button',
              {
                class: 'btn btn-primary',
                type: 'button',
                on: {
                  click: () => {
                    activeTab = 'sugerencias';
                    renderTabs();
                    render();
                  },
                },
              },
              'Ver sugerencias',
            ),
          }),
        }),
      );
      return;
    }

    for (const v of thisWeek) {
      container.appendChild(renderProductionCard(v));
    }
  }

  /* ---------------- Todas las órdenes ---------------- */
  function renderOrders(): void {
    const views = productionOrderViews(app.state);
    if (views.length === 0) {
      container.appendChild(
        card({
          content: emptyState({
            icon: 'production',
            title: 'No hay órdenes de producción',
            message: 'Creá una para agendar qué vas a fabricar.',
          }),
        }),
      );
      return;
    }
    for (const v of views) container.appendChild(renderProductionCard(v));
  }

  /* ---------------- Sugerencias ---------------- */
  function renderSuggestions(): void {
    const suggestions = productionSuggestions(app.state, 30).filter((s) => s.suggestQty > 0);

    container.appendChild(
      el('div', {
        class: 'small dim mb-4',
        text: 'Cruce de pedidos pendientes contra stock disponible. Las cantidades son una sugerencia.',
      }),
    );

    if (suggestions.length === 0) {
      container.appendChild(
        card({
          content: emptyState({
            icon: 'check',
            title: 'No falta stock',
            message: 'Todos los pedidos pendientes tienen stock disponible.',
          }),
        }),
      );
      return;
    }

    const list = el('div', { class: 'card' }, el('div', { class: 'list' }));
    const listEl = list.querySelector('.list')!;

    for (const s of suggestions) {
      listEl.appendChild(
        el(
          'div',
          { class: 'list-item', style: { cursor: 'default' } },
          s.color ? el('span', { class: 'color-dot', style: { background: s.color.hex } }) : null,
          el(
            'div',
            { class: 'list-item-main' },
            el('div', {
              class: 'list-item-title',
              text: `${s.product?.name ?? 'Producto'} · ${s.variant.sizeCode}`,
            }),
            el('div', {
              class: 'list-item-sub',
              text: `necesario ${s.neededQty} · disponible ${s.availableQty} · ${s.orderIds.length} pedido(s)`,
            }),
          ),
          el(
            'div',
            { class: 'list-item-value' },
            el('div', { style: { color: 'var(--danger)' }, text: String(s.suggestQty) }),
            el('div', { class: 'xsmall dim', text: 'a producir' }),
          ),
        ),
      );
    }
    container.appendChild(list);
  }

  /* ---------------- Tarjeta de orden ---------------- */
  function renderProductionCard(v: ReturnType<typeof productionOrderViews>[number]): HTMLElement {
    const collection = v.order.collectionId
      ? app.state.collections.get(v.order.collectionId)
      : undefined;
    const progress =
      v.totalPlanned > 0 ? ((v.totalPlanned - v.totalRemaining) / v.totalPlanned) * 100 : 0;

    return card({
      title: `Orden · ${formatWeekday(v.order.scheduledDate)}`,
      count: PRODUCTION_STATUS_LABEL[v.order.status],
      action: v.order.status === 'planificada'
        ? el('button', {
            class: 'btn btn-sm btn-primary',
            type: 'button',
            text: 'Empezar',
            on: {
              click: async () => {
                try {
                  await updateProductionOrder(app, v.order.id, { status: 'en_proceso' });
                  toastSuccess('Orden marcada como en proceso.');
                } catch (err) {
                  showError(err);
                }
              },
            },
          })
        : null,
      content: el(
        'div',
        {},
        el(
          'div',
          { class: 'row-between wrap mb-3' },
          el('div', { class: 'small muted', text: collection?.name ?? 'Sin colección' }),
          v.isOverdue ? el('span', { class: 'badge badge-danger', text: 'Atrasada' }) : null,
        ),
        el(
          'div',
          { class: 'meter-row mb-4' },
          el(
            'div',
            {},
            el(
              'div',
              { class: 'meter-label' },
              el('span', { text: 'Avance' }),
              el('span', {
                class: 'meter-value',
                text: `${v.totalPlanned - v.totalRemaining}/${v.totalPlanned}`,
              }),
            ),
            el(
              'div',
              { class: `bar ${progress >= 100 ? 'success' : ''}` },
              el('span', { style: { width: `${progress}%` } }),
            ),
          ),
        ),
        el(
          'div',
          { class: 'list' },
          ...v.lines.map((line) =>
            el(
              'div',
              { class: 'list-item', style: { cursor: 'default' } },
              line.color
                ? el('span', { class: 'color-dot', style: { background: line.color.hex } })
                : null,
              el(
                'div',
                { class: 'list-item-main' },
                el('div', {
                  class: 'list-item-title',
                  text: `${line.product?.name ?? 'Producto'} · ${line.variant?.sizeCode ?? ''}`,
                }),
                el('div', {
                  class: 'list-item-sub',
                  text: `${line.completedQty}/${line.plannedQty} producidas`,
                }),
              ),
              line.remainingQty > 0
                ? el(
                    'button',
                    {
                      class: 'btn btn-sm',
                      type: 'button',
                      text: 'Completar',
                      on: { click: () => openComplete(app, line.lineId, line.remainingQty) },
                    },
                  )
                : el('span', { class: 'badge badge-entregado', text: 'Completo' }),
            ),
          ),
        ),
      ),
    });
  }

  renderTabs();
  render();
  return view;
}

function openComplete(app: App, lineId: string, max: number): void {
  const input = el('input', {
    type: 'number',
    min: '1',
    max: String(max),
    value: String(max),
    inputmode: 'numeric',
  });

  const modal = openModal({
    title: 'Completar producción',
    subtitle: 'Se genera una entrada de stock automáticamente.',
    body: el('div', { class: 'field' }, el('label', { text: 'Unidades producidas' }), input),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Registrar',
        on: {
          click: async () => {
            const qty = Math.floor(Number(input.value) || 0);
            try {
              await completeProductionLine(app, lineId, qty);
              modal.close();
              toastSuccess(`${qty} unidad(es) ingressadas al stock.`);
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}

export { money };
