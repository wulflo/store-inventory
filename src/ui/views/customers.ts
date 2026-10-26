import { el, icon, matches } from '../dom';
import { card, emptyState, money, whatsappLink } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { customerSummaries } from '../../projection/queries';
import { formatDate, formatRelative } from '../../core/dates';
import { createCustomer, deleteCustomer, updateCustomer } from '../../domain/commands';
import { showError, toastSuccess } from '../components/toast';
import { confirmDialog, openModal } from '../components/modal';

export function customersView(app: App, shell: Shell): HTMLElement {
  let query = '';
  const view = el('div');
  const listBox = el('div');

  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Buscar cliente…',
    on: {
      input: () => {
        query = searchInput.value;
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
        { class: 'row', style: { gap: '12px' } },
        el('div', { class: 'search-box' }, el('span', { class: 'search-icon' }, icon('search', 18)), searchInput),
        el(
          'button',
          {
            class: 'btn btn-primary',
            type: 'button',
            on: { click: () => openCustomerForm(app, undefined, () => render()) },
          },
          icon('plus', 18),
          'Nuevo',
        ),
      ),
    ),
  );
  view.appendChild(listBox);

  function render(): void {
    const rows = customerSummaries(app.state).filter((s) =>
      query
        ? matches(
            [s.customer.name, s.customer.phone ?? '', s.customer.email ?? '', s.customer.notes ?? ''].join(' '),
            query,
          )
        : true,
    );

    listBox.replaceChildren();

    if (rows.length === 0) {
      listBox.appendChild(
        card({
          content: emptyState({
            icon: 'customers',
            title: query ? 'Sin resultados' : 'Todavía no hay clientes',
            message: query ? 'Probá con otro nombre.' : 'Cargá tu primer cliente para empezar a vender.',
          }),
        }),
      );
      return;
    }

    const totalBalance = rows.reduce((s, r) => s + r.balanceCents, 0);

    listBox.appendChild(
      el(
        'div',
        { class: 'row-between wrap mb-3' },
        el('span', { class: 'small muted', text: `${rows.length} cliente(s)` }),
        totalBalance > 0
          ? el('span', { class: 'small', style: { color: 'var(--warning)' }, text: `Deben ${money(totalBalance)}` })
          : null,
      ),
    );

    const list = el('div', { class: 'card' }, el('div', { class: 'list' }));
    const listEl = list.querySelector('.list')!;

    for (const s of rows) {
      const wa = whatsappLink(s.customer.phone, `¡Hola ${s.customer.name}!`);
      listEl.appendChild(
        el(
          'div',
          {
            class: 'list-item',
            on: { click: () => shell.router.navigate(`/clientes/${s.customer.id}`) },
          },
          el(
            'div',
            { class: 'list-item-main' },
            el('div', { class: 'list-item-title', text: s.customer.name }),
            el('div', {
              class: 'list-item-sub',
              text: [
                s.customer.phone ?? s.customer.email ?? 'Sin contacto',
                `${s.ordersCount} pedido(s)`,
                s.lastOrderAt ? formatRelative(s.lastOrderAt) : null,
              ]
                .filter(Boolean)
                .join(' · '),
            }),
          ),
          s.balanceCents > 0
            ? el('span', { class: 'badge badge-warning', text: `debe ${money(s.balanceCents)}` })
            : s.ordersCount > 0
              ? el('span', { class: 'badge badge-entregado', text: 'al día' })
              : null,
          wa
            ? el(
                'a',
                {
                  class: 'btn-icon',
                  href: wa,
                  target: '_blank',
                  rel: 'noopener',
                  title: 'Abrir WhatsApp',
                  on: { click: (e: Event) => e.stopPropagation() },
                },
                icon('whatsapp', 18),
              )
            : null,
        ),
      );
    }

    listBox.appendChild(list);
  }

  render();
  return view;
}

/* ------------------------------------------------------------------ */

export function customerDetailView(app: App, shell: Shell, params: Record<string, string>): HTMLElement {
  const customer = app.state.customers.get(params.id);
  if (!customer || customer.deletedAt) {
    return emptyState({
      icon: 'customers',
      title: 'Cliente no encontrado',
      action: el(
        'button',
        { class: 'btn btn-primary', type: 'button', on: { click: () => shell.router.navigate('/clientes') } },
        'Ver clientes',
      ),
    });
  }

  const summary = customerSummaries(app.state).find((s) => s.customer.id === customer.id);
  const orders = [...app.state.orders.values()]
    .filter((o) => o.customerId === customer.id && !o.deletedAt)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  const view = el('div');

  view.appendChild(
    el(
      'div',
      { class: 'row-between mb-4' },
      el(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => shell.router.navigate('/clientes') },
        },
        icon('arrowLeft', 18),
        'Clientes',
      ),
      el(
        'div',
        { class: 'row', style: { gap: '8px' } },
        whatsappLink(customer.phone, `¡Hola ${customer.name}!`)
          ? el(
              'a',
              {
                class: 'btn btn-sm',
                href: whatsappLink(customer.phone, `¡Hola ${customer.name}!`)!,
                target: '_blank',
                rel: 'noopener',
              },
              icon('whatsapp', 18),
              'WhatsApp',
            )
          : null,
        el('button', {
          class: 'btn btn-sm',
          type: 'button',
          text: 'Editar',
          on: { click: () => openCustomerForm(app, customer, () => shell.refresh()) },
        }),
        el('button', {
          class: 'btn-icon',
          type: 'button',
          title: 'Archivar cliente',
          on: {
            click: async () => {
              const ok = await confirmDialog({
                title: 'Archivar cliente',
                message: `Se archiva "${customer.name}".`,
                confirmLabel: 'Archivar',
                danger: true,
              });
              if (!ok) return;
              try {
                await deleteCustomer(app, customer.id);
                toastSuccess('Cliente archivado.');
                shell.router.navigate('/clientes');
              } catch (err) {
                showError(err);
              }
            },
          },
        }, icon('trash', 18)),
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
        el('h1', { text: customer.name }),
        el('div', {
          class: 'sub',
          text: [customer.phone, customer.email, customer.address].filter(Boolean).join(' · ') || 'Sin datos de contacto',
        }),
      ),
    ),
  );

  view.appendChild(
    el(
      'div',
      { class: 'grid grid-3 mb-4' },
      el(
        'div',
        { class: 'kpi' },
        el('div', { class: 'kpi-label', text: 'Compras totales' }),
        el('div', { class: 'kpi-value', text: money(summary?.totalSpentCents ?? 0) }),
        el('div', { class: 'kpi-hint', text: `${summary?.ordersCount ?? 0} pedido(s)` }),
      ),
      el(
        'div',
        { class: 'kpi accent-success' },
        el('div', { class: 'kpi-label', text: 'Pagado' }),
        el('div', { class: 'kpi-value', text: money(summary?.totalPaidCents ?? 0) }),
      ),
      el(
        'div',
        { class: 'kpi accent-warning' },
        el('div', { class: 'kpi-label', text: 'Saldo pendiente' }),
        el('div', { class: 'kpi-value', text: money(summary?.balanceCents ?? 0) }),
      ),
    ),
  );

  if (customer.notes) {
    view.appendChild(
      card({
        title: 'Notas',
        content: el('p', { class: 'muted', text: customer.notes }),
      }),
    );
  }

  view.appendChild(
    card({
      title: 'Historial de pedidos',
      count: orders.length,
      action: el(
        'button',
        {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          on: { click: () => shell.router.navigate('/pedidos/nuevo') },
        },
        icon('plus', 16),
        'Nuevo pedido',
      ),
      content:
        orders.length === 0
          ? emptyState({ icon: 'orders', title: 'Sin pedidos', message: 'Este cliente todavía no compró.' })
          : el(
              'div',
              { class: 'list' },
              ...orders.map((o) => {
                const totals = { totalCents: 0, paidCents: 0 };
                let units = 0;
                for (const lid of app.state.orderLinesByOrder.get(o.id) ?? []) {
                  const l = app.state.orderLines.get(lid);
                  if (!l || l.deletedAt) continue;
                  totals.totalCents += l.quantity * l.unitPriceCents;
                  units += l.quantity;
                }
                for (const pid of app.state.paymentsByOrder.get(o.id) ?? []) {
                  const p = app.state.payments.get(pid);
                  if (p && !p.deletedAt) totals.paidCents += p.amountCents;
                }
                return el(
                  'div',
                  {
                    class: 'list-item',
                    on: { click: () => shell.router.navigate(`/pedidos/${o.id}`) },
                  },
                  el(
                    'div',
                    { class: 'list-item-main' },
                    el('div', { class: 'list-item-title', text: `${units} unidad(es)` }),
                    el('div', {
                      class: 'list-item-sub',
                      text: `${formatDate(o.createdAt)} · ${o.status.replace('_', ' ')}`,
                    }),
                  ),
                  el(
                    'div',
                    { class: 'list-item-value' },
                    el('div', { text: money(totals.totalCents) }),
                    totals.totalCents - totals.paidCents > 0
                      ? el('div', {
                          class: 'xsmall',
                          style: { color: 'var(--warning)' },
                          text: `debe ${money(totals.totalCents - totals.paidCents)}`,
                        })
                      : null,
                  ),
                );
              }),
            ),
    }),
  );

  return view;
}

/* ------------------------------------------------------------------ */

export function openCustomerForm(
  app: App,
  customer: { id: string; name: string; phone?: string; email?: string; address?: string; notes?: string; taxId?: string } | undefined,
  onSaved: () => void,
): void {
  const nameInput = el('input', { type: 'text', value: customer?.name ?? '', placeholder: 'Nombre y apellido' });
  const phoneInput = el('input', { type: 'tel', value: customer?.phone ?? '', placeholder: '11 1234-5678' });
  const emailInput = el('input', { type: 'email', value: customer?.email ?? '', placeholder: 'mail@ejemplo.com' });
  const addressInput = el('input', { type: 'text', value: customer?.address ?? '', placeholder: 'Dirección' });
  const taxInput = el('input', { type: 'text', value: customer?.taxId ?? '', placeholder: 'DNI / CUIT' });
  const notesInput = el('textarea', { rows: '2', value: customer?.notes ?? '', placeholder: 'Notas internas' });

  const modal = openModal({
    title: customer ? 'Editar cliente' : 'Nuevo cliente',
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', { text: 'Nombre' }), nameInput),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Teléfono' }), phoneInput),
        el('div', { class: 'field' }, el('label', { text: 'Email' }), emailInput),
      ),
      el('div', { class: 'field' }, el('label', { text: 'Dirección' }), addressInput),
      el('div', { class: 'field' }, el('label', { text: 'DNI / CUIT' }), taxInput),
      el('div', { class: 'field' }, el('label', { text: 'Notas' }), notesInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Guardar',
        on: {
          click: async () => {
            try {
              if (customer) {
                await updateCustomer(app, customer.id, {
                  name: nameInput.value,
                  phone: phoneInput.value || undefined,
                  email: emailInput.value || undefined,
                  address: addressInput.value || undefined,
                  taxId: taxInput.value || undefined,
                  notes: notesInput.value || undefined,
                });
              } else {
                await createCustomer(app, {
                  name: nameInput.value,
                  phone: phoneInput.value || undefined,
                  email: emailInput.value || undefined,
                  address: addressInput.value || undefined,
                  taxId: taxInput.value || undefined,
                  notes: notesInput.value || undefined,
                });
              }
              modal.close();
              toastSuccess(customer ? 'Cliente actualizado.' : 'Cliente creado.');
              onSaved();
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}
