import { el, icon } from '../dom';
import { card, emptyState, money, meterRow } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import {
  bottomProductsByUnits,
  collectionSummaries,
  expenseSummary,
  periodReport,
  productSummaries,
  topProductsByUnits,
} from '../../projection/queries';
import { endOfMonth, formatDate, parseDateInput, startOfMonth, toDateInput } from '../../core/dates';
import { EXPENSE_CATEGORY_LABEL } from './common';
import type { ExpenseCategory } from '../../core/types';

type Preset = 'mes' | 'trimestre' | 'anio' | 'personalizado';

export function reportsView(app: App, shell: Shell): HTMLElement {
  let preset: Preset = 'mes';
  let from = startOfMonth(Date.now());
  let to = endOfMonth(Date.now());

  const view = el('div');
  const container = el('div');

  /* ---------------- Controles de período ---------------- */
  const fromInput = el('input', {
    type: 'date',
    value: toDateInput(from),
    on: {
      change: () => {
        const v = parseDateInput(fromInput.value);
        if (v !== null) {
          from = v;
          preset = 'personalizado';
          renderChips();
          render();
        }
      },
    },
  });

  const toInput = el('input', {
    type: 'date',
    value: toDateInput(to),
    on: {
      change: () => {
        const v = parseDateInput(toInput.value);
        if (v !== null) {
          to = v + 86399999;
          preset = 'personalizado';
          renderChips();
          render();
        }
      },
    },
  });

  const chips = el('div', { class: 'chip-row' });

  function applyPreset(p: Preset): void {
    preset = p;
    const now = new Date();
    if (p === 'mes') {
      from = startOfMonth(now.getTime());
      to = endOfMonth(now.getTime());
    } else if (p === 'trimestre') {
      const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      from = start.getTime();
      to = endOfMonth(new Date(now.getFullYear(), start.getMonth() + 3, 0).getTime());
    } else if (p === 'anio') {
      from = new Date(now.getFullYear(), 0, 1).getTime();
      to = endOfMonth(new Date(now.getFullYear(), 11, 1).getTime());
    }
    fromInput.value = toDateInput(from);
    toInput.value = toDateInput(to);
    renderChips();
    render();
  }

  function renderChips(): void {
    chips.replaceChildren();
    const items: [Preset, string][] = [
      ['mes', 'Este mes'],
      ['trimestre', 'Este trimestre'],
      ['anio', 'Este año'],
      ['personalizado', 'Personalizado'],
    ];
    for (const [key, label] of items) {
      chips.appendChild(
        el('button', {
          class: `chip${preset === key ? ' active' : ''}`,
          type: 'button',
          text: label,
          on: {
            click: () => {
              if (key === 'personalizado') {
                preset = 'personalizado';
                renderChips();
              } else {
                applyPreset(key);
              }
            },
          },
        }),
      );
    }
  }
  renderChips();

  view.appendChild(
    el(
      'div',
      { class: 'card mb-4' },
      chips,
      el(
        'div',
        { class: 'form-row mt-3' },
        el('div', { class: 'field' }, el('label', { text: 'Desde' }), fromInput),
        el('div', { class: 'field' }, el('label', { text: 'Hasta' }), toInput),
      ),
    ),
  );

  view.appendChild(container);

  function render(): void {
    container.replaceChildren();

    const report = periodReport(app.state, from, to);
    const collections = collectionSummaries(app.state);
    const products = productSummaries(app.state);
    const top = topProductsByUnits(app.state, from, to, 10);
    const bottom = bottomProductsByUnits(app.state, from, to, 10);
    const expenses = expenseSummary(app.state, from, to);

    /* ---------------- Resumen ---------------- */
    container.appendChild(
      el(
        'div',
        { class: 'grid grid-4 mb-4' },
        el(
          'div',
          { class: 'kpi accent-primary' },
          el('div', { class: 'kpi-label', text: 'Ingresos' }),
          el('div', { class: 'kpi-value', text: money(report.revenueCents) }),
          el('div', { class: 'kpi-hint', text: `${report.ordersCount} pedido(s)` }),
        ),
        el(
          'div',
          { class: 'kpi accent-success' },
          el('div', { class: 'kpi-label', text: 'Ganancia bruta' }),
          el('div', { class: 'kpi-value', text: money(report.profitCents) }),
          el('div', { class: 'kpi-hint', text: `${report.marginPercent.toFixed(0)}% sobre venta` }),
        ),
        el(
          'div',
          { class: 'kpi accent-danger' },
          el('div', { class: 'kpi-label', text: 'Gastos' }),
          el('div', { class: 'kpi-value', text: money(report.expensesCents) }),
        ),
        el(
          'div',
          { class: 'kpi' },
          el('div', { class: 'kpi-label', text: 'Ganancia neta' }),
          el('div', { class: 'kpi-value', text: money(report.netProfitCents) }),
          el('div', { class: 'kpi-hint', text: `${report.unitsSold} unidades vendidas` }),
        ),
      ),
    );

    /* ---------------- Colecciones ---------------- */
    const collWithData = collections.filter((c) => c.revenueCents > 0 || c.unitsProduced > 0);
    container.appendChild(
      card({
        title: 'Por colección',
        count: collWithData.length,
        content:
          collWithData.length === 0
            ? emptyState({
                icon: 'reports',
                title: 'Sin datos en este período',
                message: 'Elegí otro período o cargá pedidos.',
              })
            : el(
                'div',
                {},
                ...collWithData.map((c) =>
                  meterRow({
                    label: c.collection.name,
                    value: `${money(c.revenueCents)} · ${c.marginPercent.toFixed(0)}%`,
                    percent: report.revenueCents > 0 ? (c.revenueCents / report.revenueCents) * 100 : 0,
                    variant: c.marginPercent >= 35 ? 'success' : c.marginPercent >= 20 ? 'warning' : 'danger',
                  }),
                ),
              ),
      }),
    );

    /* ---------------- Top productos ---------------- */
    container.appendChild(
      card({
        title: 'Productos más vendidos',
        count: top.length,
        content:
          top.length === 0
            ? emptyState({ icon: 'products', title: 'Sin ventas en el período' })
            : el(
                'div',
                { class: 'table-wrap' },
                (() => {
                  const table = el('table', { class: 'data' });
                  table.appendChild(
                    el(
                      'thead',
                      {},
                      el(
                        'tr',
                        {},
                        el('th', { text: 'Producto' }),
                        el('th', { class: 'num', text: 'Unidades' }),
                        el('th', { class: 'num', text: 'Ingresos' }),
                        el('th', { class: 'num', text: 'Margen' }),
                      ),
                    ),
                  );
                  const tbody = el('tbody');
                  for (const t of top) {
                    const ps = products.find((p) => p.product.id === t.product?.id);
                    tbody.appendChild(
                      el(
                        'tr',
                        {},
                        el(
                          'td',
                          {},
                          el('div', { class: 'strong', text: t.product?.name ?? '—' }),
                          el('div', {
                            class: 'xsmall dim',
                            text: ps?.collection?.name ?? '',
                          }),
                        ),
                        el('td', { class: 'num strong', text: String(t.units) }),
                        el('td', { class: 'num', text: money(t.revenueCents) }),
                        el('td', {
                          class: 'num small',
                          style: { color: 'var(--success)' },
                          text: ps ? `${ps.marginPercent.toFixed(0)}%` : '—',
                        }),
                      ),
                    );
                  }
                  table.appendChild(tbody);
                  return table;
                })(),
              ),
      }),
    );

    /* ---------------- Menos vendidos ---------------- */
    container.appendChild(
      card({
        title: 'Productos menos vendidos',
        count: bottom.length,
        content:
          bottom.length === 0
            ? emptyState({ icon: 'products', title: 'Sin ventas en el período' })
            : el(
                'div',
                {},
                ...bottom.map((t) => {
                  const max = Math.max(1, ...top.map((x) => x.units), ...bottom.map((x) => x.units));
                  return meterRow({
                    label: t.product?.name ?? '—',
                    value: `${t.units} u. · ${money(t.revenueCents)}`,
                    percent: (t.units / max) * 100,
                    variant: t.units === 0 ? 'danger' : 'warning',
                  });
                }),
              ),
      }),
    );

    /* ---------------- Gráfico detallado ---------------- */
    container.appendChild(
      card({
        title: 'Ranking visual de ventas',
        subtitle: 'Unidades vendidas por producto en el período',
        content:
          top.length === 0
            ? emptyState({ icon: 'reports', title: 'Sin ventas para graficar' })
            : el(
                'div',
                {},
                ...top.map((t, index) =>
                  el(
                    'div',
                    { class: 'rank-row' },
                    el('div', { class: 'rank-index', text: String(index + 1) }),
                    el(
                      'div',
                      { class: 'rank-main' },
                      el(
                        'div',
                        { class: 'row-between' },
                        el('span', { class: 'small strong', text: t.product?.name ?? '—' }),
                        el('span', { class: 'xsmall dim', text: `${t.units} u.` }),
                      ),
                      el(
                        'div',
                        { class: 'rank-bar' },
                        el('span', {
                          style: {
                            width: `${(t.units / Math.max(1, top[0].units)) * 100}%`,
                          },
                        }),
                      ),
                    ),
                  ),
                ),
              ),
      }),
    );

    /* ---------------- Gastos por categoría ---------------- */
    container.appendChild(
      card({
        title: 'Gastos por categoría',
        count: expenses.byCategory.length,
        content:
          expenses.byCategory.length === 0
            ? emptyState({ icon: 'money', title: 'Sin gastos en el período' })
            : el(
                'div',
                {},
                ...expenses.byCategory.map((c) =>
                  meterRow({
                    label: EXPENSE_CATEGORY_LABEL[c.category as ExpenseCategory] ?? c.category,
                    value: money(c.amountCents),
                    percent:
                      expenses.totalCents > 0 ? (c.amountCents / expenses.totalCents) * 100 : 0,
                    variant: 'danger',
                  }),
                ),
              ),
      }),
    );

    /* ---------------- Producción ---------------- */
    container.appendChild(
      card({
        title: 'Producción del período',
        content: el(
          'div',
          { class: 'row-between wrap' },
          el(
            'div',
            {},
            el('div', { class: 'strong', text: `${report.unitsProduced} unidades` }),
            el('div', {
              class: 'small muted',
              text: `Entre ${formatDate(from)} y ${formatDate(to)}`,
            }),
          ),
          el(
            'button',
            {
              class: 'btn btn-sm',
              type: 'button',
              on: { click: () => shell.router.navigate('/produccion') },
            },
            icon('production', 16),
            'Ver producción',
          ),
        ),
      }),
    );
  }

  render();
  return view;
}
