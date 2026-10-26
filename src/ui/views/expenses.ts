import { el, icon } from '../dom';
import { card, emptyState, money, EXPENSE_CATEGORY_LABEL, PAYMENT_METHOD_LABEL } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { expenseSummary } from '../../projection/queries';
import { createExpense, deleteExpense, updateExpense } from '../../domain/commands';
import { showError, toastSuccess } from '../components/toast';
import { confirmDialog, openModal } from '../components/modal';
import { endOfMonth, formatDate, parseDateInput, startOfMonth, toDateInput } from '../../core/dates';
import { parseMoneyToCents } from '../../core/money';
import type { ExpenseCategory, PaymentMethod } from '../../core/types';

export function expensesView(app: App, shell: Shell): HTMLElement {
  let monthOffset = 0;
  const view = el('div');
  const container = el('div');

  const periodLabel = el('div', { class: 'strong' });

  function period() {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    return { from: startOfMonth(d.getTime()), to: endOfMonth(d.getTime()), date: d };
  }

  view.appendChild(
    el(
      'div',
      { class: 'row-between wrap mb-4' },
      el(
        'div',
        { class: 'row', style: { gap: '8px' } },
        el('button', {
          class: 'btn-icon',
          type: 'button',
          on: {
            click: () => {
              monthOffset -= 1;
              render();
            },
          },
        }, icon('arrowLeft', 18)),
        periodLabel,
        el('button', {
          class: 'btn-icon',
          type: 'button',
          on: {
            click: () => {
              monthOffset += 1;
              render();
            },
          },
        }, icon('chevron', 18)),
      ),
      el(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          on: { click: () => openExpenseForm(app, undefined, render) },
        },
        icon('plus', 18),
        'Nuevo gasto',
      ),
    ),
  );
  view.appendChild(container);

  function render(): void {
    container.replaceChildren();
    const { from, to, date } = period();
    periodLabel.textContent = date.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });

    const summary = expenseSummary(app.state, from, to);
    const expenses = [...app.state.expenses.values()]
      .filter((e) => !e.deletedAt && e.date >= from && e.date <= to)
      .sort((a, b) => b.date - a.date);

    container.appendChild(
      el(
        'div',
        { class: 'grid grid-3 mb-4' },
        el(
          'div',
          { class: 'kpi accent-danger' },
          el('div', { class: 'kpi-label', text: 'Gastos del mes' }),
          el('div', { class: 'kpi-value', text: money(summary.totalCents) }),
          el('div', { class: 'kpi-hint', text: `${expenses.length} gasto(s)` }),
        ),
        ...summary.byCategory.slice(0, 2).map((c) =>
          el(
            'div',
            { class: 'kpi' },
            el('div', { class: 'kpi-label', text: EXPENSE_CATEGORY_LABEL[c.category as ExpenseCategory] ?? c.category }),
            el('div', { class: 'kpi-value', style: { fontSize: '1.4rem' }, text: money(c.amountCents) }),
            el('div', { class: 'kpi-hint', text: `${c.count} gasto(s)` }),
          ),
        ),
      ),
    );

    if (expenses.length === 0) {
      container.appendChild(
        card({
          content: emptyState({
            icon: 'money',
            title: 'Sin gastos registrados',
            message: 'Anotá insumos, envíos y publicidad para saber la ganancia real.',
          }),
        }),
      );
      return;
    }

    const table = el('table', { class: 'data' });
    table.appendChild(
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { text: 'Fecha' }),
          el('th', { text: 'Descripción' }),
          el('th', { text: 'Categoría' }),
          el('th', { text: 'Pago' }),
          el('th', { class: 'num', text: 'Monto' }),
          el('th', { text: '' }),
        ),
      ),
    );
    const tbody = el('tbody');
    for (const e of expenses) {
      tbody.appendChild(
        el(
          'tr',
          {},
          el('td', { class: 'small', text: formatDate(e.date) }),
          el(
            'td',
            {},
            el('div', { class: 'strong', text: e.description }),
            e.reference ? el('div', { class: 'xsmall dim', text: e.reference }) : null,
          ),
          el('td', {}, el('span', { class: 'badge', text: EXPENSE_CATEGORY_LABEL[e.category] })),
          el('td', { class: 'small muted', text: PAYMENT_METHOD_LABEL[e.paymentMethod] }),
          el('td', { class: 'num strong', text: money(e.amountCents) }),
          el(
            'td',
            {},
            el(
              'div',
              { class: 'row', style: { gap: '4px' } },
              el('button', {
                class: 'btn btn-sm btn-ghost',
                type: 'button',
                text: 'Editar',
                on: { click: () => openExpenseForm(app, e, render) },
              }),
              el('button', {
                class: 'btn-icon',
                type: 'button',
                title: 'Eliminar',
                on: {
                  click: async () => {
                    const ok = await confirmDialog({
                      title: 'Eliminar gasto',
                      message: `Se elimina "${e.description}" por ${money(e.amountCents)}.`,
                      confirmLabel: 'Eliminar',
                      danger: true,
                    });
                    if (!ok) return;
                    await deleteExpense(app, e.id);
                    toastSuccess('Gasto eliminado.');
                  },
                },
              }, icon('trash', 16)),
            ),
          ),
        ),
      );
    }
    table.appendChild(tbody);
    container.appendChild(el('div', { class: 'table-wrap' }, table));
  }

  render();
  void shell;
  return view;
}

/* ------------------------------------------------------------------ */

function openExpenseForm(
  app: App,
  expense: { id: string; date: number; category: ExpenseCategory; description: string; amountCents: number; paymentMethod: PaymentMethod; reference?: string; collectionId?: string } | undefined,
  onSaved: () => void,
): void {
  const dateInput = el('input', { type: 'date', value: toDateInput(expense?.date ?? Date.now()) });
  const descInput = el('input', { type: 'text', value: expense?.description ?? '', placeholder: 'Ej: Tela cotton 200m' });
  const amountInput = el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: expense ? (expense.amountCents / 100).toFixed(2).replace('.', ',') : '',
    placeholder: '0,00',
  });
  const categorySelect = el(
    'select',
    {},
    ...(['insumos', 'envio', 'publicidad', 'alquiler', 'servicios', 'otros'] as ExpenseCategory[]).map((c) =>
      el('option', { value: c, text: EXPENSE_CATEGORY_LABEL[c], selected: expense?.category === c }),
    ),
  );
  const methodSelect = el(
    'select',
    {},
    ...(['efectivo', 'transferencia', 'tarjeta', 'otro'] as PaymentMethod[]).map((m) =>
      el('option', { value: m, text: PAYMENT_METHOD_LABEL[m], selected: expense?.paymentMethod === m }),
    ),
  );
  const refInput = el('input', { type: 'text', value: expense?.reference ?? '', placeholder: 'Nro factura (opcional)' });
  const collectionSelect = el(
    'select',
    {},
    el('option', { value: '', text: 'Sin colección' }),
    ...[...app.state.collections.values()]
      .filter((c) => !c.deletedAt)
      .map((c) =>
        el('option', { value: c.id, text: c.name, selected: expense?.collectionId === c.id }),
      ),
  );

  const modal = openModal({
    title: expense ? 'Editar gasto' : 'Nuevo gasto',
    body: el(
      'div',
      {},
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Fecha' }), dateInput),
        el('div', { class: 'field' }, el('label', { text: 'Monto' }), amountInput),
      ),
      el('div', { class: 'field' }, el('label', { text: 'Descripción' }), descInput),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Categoría' }), categorySelect),
        el('div', { class: 'field' }, el('label', { text: 'Método de pago' }), methodSelect),
      ),
      el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Referencia' }), refInput),
        el('div', { class: 'field' }, el('label', { text: 'Colección' }), collectionSelect),
      ),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Guardar',
        on: {
          click: async () => {
            const cents = parseMoneyToCents(amountInput.value);
            if (cents === null) {
              showError(new Error('El monto no es válido.'));
              return;
            }
            const date = parseDateInput(dateInput.value) ?? Date.now();
            const payload = {
              date,
              category: categorySelect.value as ExpenseCategory,
              description: descInput.value,
              amountCents: cents,
              paymentMethod: methodSelect.value as PaymentMethod,
              reference: refInput.value || undefined,
              collectionId: collectionSelect.value || undefined,
            };
            try {
              if (expense) await updateExpense(app, expense.id, payload);
              else await createExpense(app, payload);
              modal.close();
              toastSuccess(expense ? 'Gasto actualizado.' : 'Gasto registrado.');
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
