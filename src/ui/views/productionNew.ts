import { el, icon, matches } from '../dom';
import { autocomplete } from '../components/autocomplete';
import { card, emptyState, money } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { createProductionOrder } from '../../domain/commands';
import { SIZES } from '../../core/sizes';
import { toDateInput, startOfDay, formatDate } from '../../core/dates';
import type { Product, Variant } from '../../core/types';
import { showError, toastSuccess } from '../components/toast';

export function newProductionView(app: App, shell: Shell): HTMLElement {
  const selectedProducts = new Set<string>();
  const quantities = new Map<string, number>();
  let scheduledDate = startOfDay(Date.now());
  let notes = '';

  const view = el('div');
  const gridBox = el('div');
  const summaryBox = el('div');

  /* ---------------- Productos ---------------- */
  const productInput = autocomplete<Product>({
    placeholder: 'Buscar producto a producir…',
    getItems: (q) => {
      return [...app.state.products.values()]
        .filter((p) => !p.deletedAt && p.isActive)
        .filter((p) =>
          matches(
            `${p.name} ${p.sku} ${app.state.collections.get(p.collectionId)?.name ?? ''}`,
            q,
          ),
        )
        .slice(0, 8);
    },
    toItem: (p) => ({
      key: p.id,
      title: p.name,
      subtitle: `${p.sku} · ${app.state.collections.get(p.collectionId)?.name ?? ''}`,
    }),
    onSelect: (p) => {
      if (!selectedProducts.has(p.id)) {
        selectedProducts.add(p.id);
        renderGrid();
      }
      productInput.clear();
    },
  });

  /* ---------------- Grilla ---------------- */
  function renderGrid(): void {
    gridBox.replaceChildren();
    if (selectedProducts.size === 0) {
      gridBox.appendChild(
        emptyState({
          icon: 'production',
          title: 'Elegí qué vas a producir',
          message: 'Buscá un producto y cargá las cantidades por talle y color.',
        }),
      );
      updateSummary();
      return;
    }

    for (const pid of selectedProducts) {
      const product = app.state.products.get(pid);
      if (!product) continue;
      const variants = [...(app.state.variantsByProduct.get(pid) ?? [])]
        .map((vid) => app.state.variants.get(vid))
        .filter((v): v is Variant => !!v && !v.deletedAt);

      const colorIds = [...new Set(variants.map((v) => v.colorId))].sort((a, b) => {
        const ca = app.state.colors.get(a);
        const cb = app.state.colors.get(b);
        return (ca?.sortOrder ?? 0) - (cb?.sortOrder ?? 0);
      });

      const bySizeColor = new Map<string, Variant>();
      for (const v of variants) bySizeColor.set(`${v.sizeCode}|${v.colorId}`, v);

      const table = el('table');
      table.appendChild(
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', { class: 'rowhead', text: 'Talle' }),
            ...colorIds.map((cid) => {
              const color = app.state.colors.get(cid)!;
              return el(
                'th',
                {},
                el(
                  'span',
                  { class: 'row', style: { gap: '6px', justifyContent: 'center' } },
                  el('span', { class: 'color-dot', style: { background: color.hex } }),
                  el('span', { text: color.name }),
                ),
              );
            }),
            el('th', { text: 'Total' }),
          ),
        ),
      );

      const tbody = el('tbody');
      for (const size of SIZES) {
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'rowhead', text: size.label }));
        for (const cid of colorIds) {
          const variant = bySizeColor.get(`${size.code}|${cid}`);
          const cell = el('td');
          if (!variant) {
            cell.appendChild(el('span', { class: 'stock-hint', text: '—' }));
          } else {
            const agg = app.state.stock.get(variant.id);
            const input = el('input', {
              type: 'number',
              class: 'qty-input',
              min: '0',
              value: String(quantities.get(variant.id) ?? 0),
              inputmode: 'numeric',
              'aria-label': `Producir ${size.label} ${app.state.colors.get(cid)?.name}`,
            });
            const hint = el('span', {
              class: 'stock-hint',
              text: `hay ${agg?.totalQty ?? 0}`,
            });
            const sync = () => {
              const v = Math.max(0, Math.floor(Number(input.value) || 0));
              input.value = String(v);
              if (v > 0) quantities.set(variant.id, v);
              else quantities.delete(variant.id);
              input.classList.toggle('has-value', v > 0);
              updateRowTotal(tr);
              updateSummary();
            };
            input.addEventListener('input', sync);
            input.addEventListener('blur', sync);
            cell.appendChild(input);
            cell.appendChild(hint);
          }
          tr.appendChild(cell);
        }
        const totalCell = el('td', { class: 'num strong' });
        tr.appendChild(totalCell);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);

      gridBox.appendChild(
        el(
          'div',
          { class: 'mb-4' },
          el(
            'div',
            { class: 'row-between mb-3' },
            el(
              'div',
              {},
              el('div', { class: 'strong', text: product.name }),
              el('div', {
                class: 'xsmall dim',
                text: `${product.sku} · costo ${money(
                  product.costFabricCents +
                    product.costPrintCents +
                    product.costLaborCents +
                    product.costOtherCents,
                )}`,
              }),
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-ghost',
                type: 'button',
                on: {
                  click: () => {
                    selectedProducts.delete(pid);
                    renderGrid();
                  },
                },
              },
              icon('close', 16),
            ),
          ),
          el('div', { class: 'variant-grid' }, table),
        ),
      );
    }
    updateSummary();
  }

  function updateRowTotal(tr: HTMLElement): void {
    const cells = tr.querySelectorAll<HTMLInputElement>('.qty-input');
    let total = 0;
    for (const input of cells) total += Number(input.value) || 0;
    const last = tr.querySelector<HTMLTableCellElement>('td:last-child');
    if (last) last.textContent = String(total);
  }

  function updateSummary(): void {
    const lines = [...quantities.entries()].filter(([, q]) => q > 0);
    const units = lines.reduce((s, [, q]) => s + q, 0);

    // Costo estimado de la producción
    let cost = 0;
    for (const [variantId, qty] of lines) {
      const variant = app.state.variants.get(variantId);
      const product = variant ? app.state.products.get(variant.productId) : undefined;
      const unitCost =
        variant?.costCents ||
        (product
          ? product.costFabricCents +
            product.costPrintCents +
            product.costLaborCents +
            product.costOtherCents
          : 0);
      cost += unitCost * qty;
    }

    summaryBox.replaceChildren(
      el(
        'div',
        { class: 'row-between' },
        el('span', { class: 'muted', text: `${units} unidad(es) a producir` }),
        el('span', { class: 'strong', style: { fontSize: '1.25rem' }, text: money(cost) }),
      ),
      el('div', { class: 'xsmall dim mt-2', text: 'Costo estimado de materiales y mano de obra' }),
    );
  }

  /* ---------------- Formulario ---------------- */
  const dateInput = el('input', {
    type: 'date',
    value: toDateInput(scheduledDate),
    on: {
      change: () => {
        const t = new Date(`${dateInput.value}T12:00:00`).getTime();
        if (!Number.isNaN(t)) scheduledDate = t;
      },
    },
  });

  const notesInput = el('textarea', {
    rows: '2',
    placeholder: 'Notas (opcional)',
    on: {
      input: () => {
        notes = notesInput.value;
      },
    },
  });

  const collectionSelect = el(
    'select',
    {},
    el('option', { value: '', text: 'Sin colección' }),
    ...[...app.state.collections.values()]
      .filter((c) => !c.deletedAt)
      .map((c) => el('option', { value: c.id, text: c.name })),
  );

  const saveBtn = el('button', {
    class: 'btn btn-primary btn-lg btn-block',
    type: 'button',
    on: { click: () => void save() },
  });

  async function save(): Promise<void> {
    const lines = [...quantities.entries()]
      .filter(([, q]) => q > 0)
      .map(([variantId, plannedQty]) => ({ variantId, plannedQty }));

    if (lines.length === 0) {
      showError(new Error('Cargá al menos una cantidad a producir.'));
      return;
    }

    saveBtn.disabled = true;
    try {
      await createProductionOrder(app, {
        collectionId: collectionSelect.value || undefined,
        scheduledDate,
        notes: notes.trim() || undefined,
        lines,
      });
      toastSuccess('Orden de producción creada.');
      shell.router.navigate('/produccion');
    } catch (err) {
      showError(err);
      saveBtn.disabled = false;
    }
  }

  view.appendChild(
    el(
      'div',
      { class: 'row-between mb-4' },
      el(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => shell.router.navigate('/produccion') },
        },
        icon('arrowLeft', 18),
        'Producción',
      ),
    ),
  );

  view.appendChild(
    card({
      title: '1 · Qué vas a producir',
      content: el('div', {}, productInput.element, el('div', { class: 'mt-4' }, gridBox)),
    }),
  );

  view.appendChild(
    card({
      title: '2 · Cuándo',
      content: el(
        'div',
        { class: 'form-row' },
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Fecha programada' }),
          dateInput,
        ),
        el('div', { class: 'field' }, el('label', { text: 'Colección' }), collectionSelect),
        el('div', { class: 'field' }, el('label', { text: 'Notas' }), notesInput),
      ),
    }),
  );

  view.appendChild(
    card({
      title: '3 · Resumen',
      content: el(
        'div',
        {},
        summaryBox,
        el('div', { class: 'mt-4' }, saveBtn),
        el('div', {
          class: 'xsmall dim center mt-3',
          text: `Se programa para ${formatDate(scheduledDate)}`,
        }),
      ),
    }),
  );

  renderGrid();
  return view;
}
