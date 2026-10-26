import { el, icon } from '../dom';
import { card, emptyState, money, ORDER_STATUS_LABEL, paymentBadge, statusBadge, whatsappLink } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { lineViews, orderTotals } from '../../projection/queries';
import {
  addPayment,
  deliverOrderLine,
  removeOrderLine,
  removePayment,
  updateOrder,
  updateOrderLine,
} from '../../domain/commands';
import { formatDate, formatDateTime, toDateInput } from '../../core/dates';
import { parseMoneyToCents } from '../../core/money';
import { PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL } from './common';
import { showError, toastSuccess } from '../components/toast';
import { confirmDialog, openModal } from '../components/modal';
import type { OrderStatus, PaymentMethod } from '../../core/types';

const STATUS_FLOW: OrderStatus[] = ['pendiente', 'en_produccion', 'listo', 'entregado'];

export function orderDetailView(app: App, shell: Shell, params: Record<string, string>): HTMLElement {
  const order = app.state.orders.get(params.id);
  if (!order || order.deletedAt) {
    return emptyState({
      icon: 'orders',
      title: 'Pedido no encontrado',
      message: 'Puede que se haya eliminado.',
      action: el(
        'button',
        { class: 'btn btn-primary', type: 'button', on: { click: () => shell.router.navigate('/pedidos') } },
        'Ver pedidos',
      ),
    });
  }

  const customer = app.state.customers.get(order.customerId);
  const totals = orderTotals(app.state, order);
  const lines = lineViews(app.state, order.id);
  const view = el('div');

  /* ---------------- Encabezado ---------------- */
  const backBtn = el(
    'button',
    {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      on: { click: () => shell.router.navigate('/pedidos') },
    },
    icon('arrowLeft', 18),
    'Pedidos',
  );

  const waLink = whatsappLink(
    customer?.phone,
    `¡Hola ${customer?.name ?? ''}! Te escribo por tu pedido de ${order.id.slice(0, 8)}.`,
  );

  view.appendChild(
    el(
      'div',
      { class: 'row-between wrap mb-4' },
      backBtn,
      el(
        'div',
        { class: 'row' },
        waLink
          ? el(
              'a',
              {
                class: 'btn btn-sm',
                href: waLink,
                target: '_blank',
                rel: 'noopener',
              },
              icon('whatsapp', 18),
              'WhatsApp',
            )
          : null,
        el(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            on: { click: () => window.print() },
          },
          'Imprimir',
        ),
      ),
    ),
  );

  view.appendChild(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { text: customer?.name ?? 'Cliente eliminado' }),
        el('div', {
          class: 'sub',
          text: `Pedido ${order.id.slice(0, 8)} · ${formatDate(order.createdAt)}${
            order.dueDate ? ` · entrega ${formatDate(order.dueDate)}` : ''
          }`,
        }),
      ),
      el(
        'div',
        { class: 'row' },
        statusBadge(order.status),
        paymentBadge(totals.paymentStatus),
      ),
    ),
  );

  /* ---------------- Resumen ---------------- */
  view.appendChild(
    el(
      'div',
      { class: 'grid grid-4 mb-4' },
      el(
        'div',
        { class: 'kpi' },
        el('div', { class: 'kpi-label', text: 'Total' }),
        el('div', { class: 'kpi-value', text: money(totals.totalCents) }),
        el('div', { class: 'kpi-hint', text: `${totals.units} unidad(es)` }),
      ),
      el(
        'div',
        { class: 'kpi accent-success' },
        el('div', { class: 'kpi-label', text: 'Pagado' }),
        el('div', { class: 'kpi-value', text: money(totals.paidCents) }),
      ),
      el(
        'div',
        { class: 'kpi accent-warning' },
        el('div', { class: 'kpi-label', text: 'Saldo' }),
        el('div', { class: 'kpi-value', text: money(totals.balanceCents) }),
      ),
      el(
        'div',
        { class: 'kpi accent-primary' },
        el('div', { class: 'kpi-label', text: 'Margen' }),
        el('div', { class: 'kpi-value', text: money(totals.marginCents) }),
        el('div', { class: 'kpi-hint', text: `${totals.marginPercent.toFixed(0)}% sobre venta` }),
      ),
    ),
  );

  /* ---------------- Timeline de estados ---------------- */
  const currentIdx = STATUS_FLOW.indexOf(order.status);
  view.appendChild(
    card({
      content: el(
        'div',
        {},
        el(
          'div',
          { class: 'timeline' },
          ...STATUS_FLOW.map((s, i) =>
            el('div', {
              class: `timeline-step${i < currentIdx ? ' done' : i === currentIdx ? ' current' : ''}`,
              text: ORDER_STATUS_LABEL[s],
            }),
          ),
        ),
        el(
          'div',
          { class: 'btn-group mt-4' },
          ...STATUS_FLOW.map((s) =>
            el('button', {
              class: `btn btn-sm${order.status === s ? ' btn-primary' : ''}`,
              type: 'button',
              text: ORDER_STATUS_LABEL[s],
              on: {
                click: async () => {
                  try {
                    await updateOrder(app, order.id, { status: s });
                    toastSuccess(`Estado: ${ORDER_STATUS_LABEL[s]}`);
                  } catch (err) {
                    showError(err);
                  }
                },
              },
            }),
          ),
          order.status !== 'cancelado'
            ? el('button', {
                class: 'btn btn-sm btn-ghost',
                type: 'button',
                text: 'Cancelar pedido',
                on: {
                  click: async () => {
                    const ok = await confirmDialog({
                      title: 'Cancelar pedido',
                      message:
                        'Se libera el stock reservado. Los pagos registrados se conservan para historial.',
                      confirmLabel: 'Cancelar pedido',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await updateOrder(app, order.id, { status: 'cancelado' });
                      toastSuccess('Pedido cancelado.');
                    } catch (err) {
                      showError(err);
                    }
                  },
                },
              })
            : null,
        ),
      ),
    }),
  );

  /* ---------------- Líneas ---------------- */
  const linesCard = card({
    title: 'Productos',
    count: lines.length,
    content:
      lines.length === 0
        ? emptyState({ icon: 'box', title: 'Sin productos', message: 'Agregá productos al pedido.' })
        : el(
            'div',
            { class: 'list' },
            ...lines.map((lv) => {
              const pending = lv.line.quantity - lv.line.deliveredQty;
              const produced = lv.line.producedQty;
              return el(
                'div',
                { class: 'list-item', style: { cursor: 'default' } },
                lv.color
                  ? el('span', { class: 'color-dot', style: { background: lv.color.hex } })
                  : null,
                el(
                  'div',
                  { class: 'list-item-main' },
                  el('div', {
                    class: 'list-item-title',
                    text: `${lv.product?.name ?? 'Producto'} · ${lv.variant?.sizeCode ?? ''}`,
                  }),
                  el('div', {
                    class: 'list-item-sub',
                    text: [
                      `${lv.line.quantity} × ${money(lv.line.unitPriceCents)}`,
                      produced > 0 ? `producidas ${produced}` : null,
                      lv.line.deliveredQty > 0 ? `entregadas ${lv.line.deliveredQty}` : null,
                      pending > 0 ? `pendientes ${pending}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }),
                ),
                el(
                  'div',
                  { class: 'list-item-value' },
                  el('div', { text: money(lv.lineTotalCents) }),
                  el('div', { class: 'xsmall dim', text: `margen ${money(lv.lineMarginCents)}` }),
                ),
                el(
                  'div',
                  { class: 'row', style: { gap: '4px' } },
                  pending > 0
                    ? el(
                        'button',
                        {
                          class: 'btn btn-sm btn-ghost',
                          type: 'button',
                          title: 'Entregar',
                          on: {
                            click: () => openDeliver(app, lv.line.id, pending, lv.product?.name ?? ''),
                          },
                        },
                        icon('check', 16),
                      )
                    : null,
                  el(
                    'button',
                    {
                      class: 'btn btn-sm btn-ghost',
                      type: 'button',
                      title: 'Editar',
                      on: {
                        click: () =>
                          openEditLine(app, lv.line.id, lv.line.quantity, lv.line.unitPriceCents),
                      },
                    },
                    'Editar',
                  ),
                  el(
                    'button',
                    {
                      class: 'btn-icon',
                      type: 'button',
                      title: 'Quitar línea',
                      on: {
                        click: async () => {
                          const ok = await confirmDialog({
                            title: 'Quitar línea',
                            message: `¿Quitar ${lv.product?.name ?? 'el producto'} del pedido?`,
                            confirmLabel: 'Quitar',
                            danger: true,
                          });
                          if (!ok) return;
                          try {
                            await removeOrderLine(app, lv.line.id);
                            toastSuccess('Línea quitada.');
                          } catch (err) {
                            showError(err);
                          }
                        },
                      },
                    },
                    icon('trash', 16),
                  ),
                ),
              );
            }),
          ),
  });
  view.appendChild(linesCard);

  /* ---------------- Pagos ---------------- */
  const paymentIds = app.state.paymentsByOrder.get(order.id) ?? new Set<string>();
  const payments = [...paymentIds]
    .map((id) => app.state.payments.get(id))
    .filter((p) => p && !p.deletedAt);

  view.appendChild(
    card({
      title: 'Pagos',
      count: payments.length,
      action: el(
        'button',
        {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          on: { click: () => openAddPayment(app, order.id, totals.balanceCents) },
        },
        icon('plus', 16),
        'Registrar pago',
      ),
      content:
        payments.length === 0
          ? emptyState({
              icon: 'money',
              title: 'Sin pagos',
              message: 'Registrá una seña o un pago parcial.',
            })
          : el(
              'div',
              { class: 'list' },
              ...payments.map((p) =>
                el(
                  'div',
                  { class: 'list-item', style: { cursor: 'default' } },
                  el(
                    'div',
                    { class: 'list-item-main' },
                    el('div', { class: 'list-item-title', text: money(p!.amountCents) }),
                    el('div', {
                      class: 'list-item-sub',
                      text: [
                        PAYMENT_METHOD_LABEL[p!.method],
                        p!.reference,
                        formatDateTime(p!.createdAt),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }),
                  ),
                  el(
                    'button',
                    {
                      class: 'btn-icon',
                      type: 'button',
                      title: 'Anular pago',
                      on: {
                        click: async () => {
                          const ok = await confirmDialog({
                            title: 'Anular pago',
                            message: `Se elimina el pago de ${money(p!.amountCents)}.`,
                            confirmLabel: 'Anular',
                            danger: true,
                          });
                          if (!ok) return;
                          await removePayment(app, p!.id);
                          toastSuccess('Pago anulado.');
                        },
                      },
                    },
                    icon('trash', 16),
                  ),
                ),
              ),
            ),
    }),
  );

  /* ---------------- Datos del pedido ---------------- */
  const dueInput = el('input', { type: 'date', value: toDateInput(order.dueDate) });
  const notesInput = el('textarea', { rows: '2', placeholder: 'Notas' });
  notesInput.value = order.notes ?? '';

  view.appendChild(
    card({
      title: 'Datos del pedido',
      content: el(
        'div',
        {},
        el(
          'div',
          { class: 'form-row' },
          el('div', { class: 'field' }, el('label', { text: 'Fecha de entrega' }), dueInput),
          el(
            'div',
            { class: 'field' },
            el('label', { text: 'Estado de pago' }),
            el(
              'select',
              {
                on: {
                  change: async (e: Event) => {
                    const value = (e.target as HTMLSelectElement).value as
                      | 'sin_pagar'
                      | 'sena'
                      | 'parcial'
                      | 'pagado';
                    try {
                      await updateOrder(app, order.id, { paymentStatus: value });
                      toastSuccess('Estado de pago actualizado.');
                    } catch (err) {
                      showError(err);
                    }
                  },
                },
              },
              ...(['sin_pagar', 'sena', 'parcial', 'pagado'] as const).map((s) =>
                el('option', {
                  value: s,
                  text: PAYMENT_STATUS_LABEL[s],
                  selected: order.paymentStatus === s,
                }),
              ),
            ),
          ),
        ),
        el('div', { class: 'field' }, el('label', { text: 'Notas' }), notesInput),
        el(
          'button',
          {
            class: 'btn',
            type: 'button',
            text: 'Guardar cambios',
            on: {
              click: async () => {
                const t = dueInput.value ? new Date(`${dueInput.value}T12:00:00`).getTime() : undefined;
                try {
                  await updateOrder(app, order.id, {
                    dueDate: Number.isNaN(t as number) ? undefined : t,
                    notes: notesInput.value || undefined,
                  });
                  toastSuccess('Pedido actualizado.');
                } catch (err) {
                  showError(err);
                }
              },
            },
          },
        ),
      ),
    }),
  );

  /* ---------------- Cliente ---------------- */
  if (customer) {
    view.appendChild(
      card({
        title: 'Cliente',
        content: el(
          'div',
          { class: 'row-between wrap' },
          el(
            'div',
            {},
            el('div', { class: 'strong', text: customer.name }),
            el('div', { class: 'small muted', text: customer.phone ?? 'Sin teléfono' }),
            customer.notes ? el('div', { class: 'small dim mt-2', text: customer.notes }) : null,
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              on: { click: () => shell.router.navigate(`/clientes/${customer.id}`) },
            },
            'Ver ficha',
          ),
        ),
      }),
    );
  }

  return view;
}

/* ------------------------------------------------------------------ */

function openDeliver(app: App, lineId: string, max: number, productName: string): void {
  const input = el('input', {
    type: 'number',
    min: '1',
    max: String(max),
    value: String(max),
    inputmode: 'numeric',
  });

  const modal = openModal({
    title: `Entregar ${productName}`,
    subtitle: `Podés entregar hasta ${max} unidad(es).`,
    body: el('div', { class: 'field' }, el('label', { text: 'Cantidad a entregar' }), input),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Entregar',
        on: {
          click: async () => {
            const qty = Math.floor(Number(input.value) || 0);
            try {
              await deliverOrderLine(app, lineId, qty);
              modal.close();
              toastSuccess(`Se registraron ${qty} unidad(es) entregadas.`);
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}

function openEditLine(
  app: App,
  lineId: string,
  quantity: number,
  unitPriceCents: number,
): void {
  const qtyInput = el('input', { type: 'number', min: '0', value: String(quantity), inputmode: 'numeric' });
  const priceInput = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: (unitPriceCents / 100).toFixed(2).replace('.', ','),
  });

  const modal = openModal({
    title: 'Editar línea',
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', { text: 'Cantidad' }), qtyInput),
      el('div', { class: 'field' }, el('label', { text: 'Precio unitario' }), priceInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Guardar',
        on: {
          click: async () => {
            const price = parseMoneyToCents(priceInput.value);
            try {
              await updateOrderLine(app, lineId, {
                quantity: Math.max(0, Math.floor(Number(qtyInput.value) || 0)),
                unitPriceCents: price ?? undefined,
              });
              modal.close();
              toastSuccess('Línea actualizada.');
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}

function openAddPayment(app: App, orderId: string, balanceCents: number): void {
  const amountInput = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: (Math.max(0, balanceCents) / 100).toFixed(2).replace('.', ','),
  });
  const methodSelect = el(
    'select',
    {},
    ...(['efectivo', 'transferencia', 'tarjeta', 'mercadopago', 'otro'] as PaymentMethod[]).map((m) =>
      el('option', { value: m, text: PAYMENT_METHOD_LABEL[m] }),
    ),
  );
  const refInput = el('input', { type: 'text', placeholder: 'Nro de comprobante (opcional)' });

  const modal = openModal({
    title: 'Registrar pago',
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', { text: 'Monto' }), amountInput),
      el('div', { class: 'field' }, el('label', { text: 'Método' }), methodSelect),
      el('div', { class: 'field' }, el('label', { text: 'Referencia' }), refInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Registrar',
        on: {
          click: async () => {
            const cents = parseMoneyToCents(amountInput.value);
            if (cents === null) {
              showError(new Error('El monto no es válido.'));
              return;
            }
            try {
              await addPayment(app, orderId, {
                amountCents: cents,
                method: methodSelect.value as PaymentMethod,
                reference: refInput.value || undefined,
              });
              modal.close();
              toastSuccess('Pago registrado.');
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}
