import { el, icon } from '../dom';
import { autocomplete } from '../components/autocomplete';
import { card, emptyState, money, statusBadge } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import {
  addOrderLine,
  createCustomer,
  createOrder,
  ValidationError,
} from '../../domain/commands';
import { orderTotals } from '../../projection/queries';
import { SIZES } from '../../core/sizes';
import { formatDate, toDateInput } from '../../core/dates';
import type { Customer, Product, Variant } from '../../core/types';
import { toastError, toastSuccess, showError } from '../components/toast';
import { openModal } from '../components/modal';

export function newOrderView(app: App, shell: Shell): HTMLElement {
  let customer: Customer | null = null;
  const selectedProducts = new Set<string>();
  /** Cantidades por variantId. */
  const quantities = new Map<string, number>();
  let dueDate: number | undefined;
  let notes = '';

  const view = el('div');

  /* ================= Cliente ================= */
  const customerBox = el('div');

  const customerInput = autocomplete<Customer>({
    placeholder: 'Buscar cliente por nombre o teléfono…',
    getItems: (q) => {
      const needle = q.toLowerCase();
      return [...app.state.customers.values()]
        .filter((c) => !c.deletedAt)
        .filter(
          (c) =>
            c.name.toLowerCase().includes(needle) ||
            (c.phone ?? '').includes(needle) ||
            (c.email ?? '').toLowerCase().includes(needle),
        )
        .slice(0, 8);
    },
    toItem: (c) => ({
      key: c.id,
      title: c.name,
      subtitle: c.phone ?? c.email ?? 'Sin contacto',
    }),
    onSelect: (c) => {
      customer = c;
      renderCustomer();
    },
    allowCustom: () => true,
    customLabel: (q) => `Crear cliente "${q}"`,
    onCustom: (q) => {
      void openCreateCustomer(app, q, (created) => {
        customer = created;
        customerInput.setValue(created.name);
        renderCustomer();
      });
    },
    autofocus: true,
  });

  function renderCustomer(): void {
    customerBox.replaceChildren();
    if (!customer) {
      customerBox.appendChild(
        el('div', { class: 'hint', text: 'Buscá o creá un cliente para empezar.' }),
      );
      return;
    }
    customerBox.appendChild(
      el(
        'div',
        { class: 'row-between' },
        el(
          'div',
          { class: 'row' },
          el(
            'div',
            {},
            el('div', { class: 'strong', text: customer.name }),
            el('div', {
              class: 'xsmall dim',
              text: customer.phone ?? customer.email ?? 'Sin teléfono',
            }),
          ),
        ),
        el(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            on: {
              click: () => {
                customer = null;
                customerInput.clear();
                renderCustomer();
              },
            },
          },
          'Cambiar',
        ),
      ),
    );
  }
  renderCustomer();

  view.appendChild(
    card({
      title: '1 · Cliente',
      content: el('div', {}, customerInput.element, el('div', { class: 'mt-3' }, customerBox)),
    }),
  );

  /* ================= Productos ================= */
  const productsBox = el('div');
  const gridBox = el('div');

  const productInput = autocomplete<Product>({
    placeholder: 'Buscar producto por nombre o SKU…',
    getItems: (q) => {
      const needle = q.toLowerCase();
      return [...app.state.products.values()]
        .filter((p) => !p.deletedAt && p.isActive)
        .filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.sku.toLowerCase().includes(needle) ||
            (app.state.collections.get(p.collectionId)?.name ?? '').toLowerCase().includes(needle),
        )
        .slice(0, 8);
    },
    toItem: (p) => ({
      key: p.id,
      title: p.name,
      subtitle: `${p.sku} · ${app.state.collections.get(p.collectionId)?.name ?? ''}`,
    }),
    onSelect: (p) => {
      addProduct(p);
      productInput.clear();
    },
  });

  function addProduct(product: Product): void {
    if (selectedProducts.has(product.id)) return;
    selectedProducts.add(product.id);
    renderProducts();
    renderGrid();
  }

  function renderProducts(): void {
    productsBox.replaceChildren();
    if (selectedProducts.size === 0) {
      productsBox.appendChild(
        el('div', { class: 'hint', text: 'Agregá los productos que lleva el pedido.' }),
      );
      return;
    }
    const chips = el('div', { class: 'chip-row' });
    for (const pid of selectedProducts) {
      const p = app.state.products.get(pid);
      if (!p) continue;
      chips.appendChild(
        el(
          'button',
          {
            class: 'chip active',
            type: 'button',
            title: 'Quitar',
            on: {
              click: () => {
                selectedProducts.delete(pid);
                renderProducts();
                renderGrid();
              },
            },
          },
          p.name,
          el('span', { text: '×' }),
        ),
      );
    }
    productsBox.appendChild(chips);
  }
  renderProducts();

  view.appendChild(
    card({
      title: '2 · Productos',
      content: el('div', {}, productInput.element, el('div', { class: 'mt-3' }, productsBox)),
    }),
  );

  /* ================= Grilla talles × colores ================= */
  function activeColors(productIds: Set<string>): string[] {
    const colors = new Map<string, { name: string; hex: string; sort: number }>();
    for (const pid of productIds) {
      for (const vid of app.state.variantsByProduct.get(pid) ?? []) {
        const v = app.state.variants.get(vid);
        if (!v || v.deletedAt) continue;
        const c = app.state.colors.get(v.colorId);
        if (!c || c.deletedAt) continue;
        colors.set(c.id, { name: c.name, hex: c.hex, sort: c.sortOrder });
      }
    }
    return [...colors.entries()].sort((a, b) => a[1].sort - b[1].sort).map((e) => e[0]);
  }

  function renderGrid(): void {
    gridBox.replaceChildren();
    if (selectedProducts.size === 0) {
      gridBox.appendChild(
        emptyState({
          icon: 'stock',
          title: 'La grilla aparece acá',
          message: 'Elegí un producto y cargá las cantidades por talle y color de una sola vez.',
        }),
      );
      return;
    }

    const colorIds = activeColors(selectedProducts);

    for (const pid of selectedProducts) {
      const product = app.state.products.get(pid);
      if (!product) continue;
      const variants = [...(app.state.variantsByProduct.get(pid) ?? [])]
        .map((vid) => app.state.variants.get(vid))
        .filter((v): v is Variant => !!v && !v.deletedAt);

      const bySizeColor = new Map<string, Variant>();
      for (const v of variants) bySizeColor.set(`${v.sizeCode}|${v.colorId}`, v);

      const productColors = [
        ...new Set(variants.map((v) => v.colorId)),
      ].filter((cid) => colorIds.includes(cid));

      const table = el('table');
      const thead = el('thead');
      thead.appendChild(
        el(
          'tr',
          {},
          el('th', { class: 'rowhead', text: 'Talle' }),
          ...productColors.map((cid) => {
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
      );
      table.appendChild(thead);

      const tbody = el('tbody');
      for (const size of SIZES) {
        const tr = el('tr');
        tr.appendChild(el('td', { class: 'rowhead', text: size.label }));

        let rowTotal = 0;
        for (const cid of productColors) {
          const variant = bySizeColor.get(`${size.code}|${cid}`);
          const cell = el('td');
          if (!variant) {
            cell.appendChild(el('span', { class: 'stock-hint', text: '—' }));
          } else {
            const agg = app.state.stock.get(variant.id);
            const available = agg?.availableQty ?? 0;
            const input = el('input', {
              type: 'number',
              class: 'qty-input',
              min: '0',
              max: '999',
              inputmode: 'numeric',
              'aria-label': `Cantidad ${size.label} ${app.state.colors.get(cid)?.name}`,
              value: String(quantities.get(variant.id) ?? 0),
            });

            const hint = el('span', {
              class: `stock-hint${available <= (variant.minStock || 0) ? ' low' : ''}`,
              text: `hay ${available}`,
            });

            const sync = () => {
              const v = Math.max(0, Math.floor(Number(input.value) || 0));
              input.value = String(v);
              if (v > 0) quantities.set(variant.id, v);
              else quantities.delete(variant.id);
              input.classList.toggle('has-value', v > 0);
              updateRowTotal(tr, pid);
              updateSummary();
            };

            input.addEventListener('input', sync);
            input.addEventListener('blur', sync);

            cell.appendChild(input);
            cell.appendChild(hint);
          }
          tr.appendChild(cell);
        }

        const totalCell = el('td', { class: 'num strong', dataset: { rowtotal: pid } });
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
                text: `${product.sku} · ${money(product.basePriceCents)} · costo ${money(
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
                    renderProducts();
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

  function updateRowTotal(tr: HTMLElement, productId: string): void {
    const cell = tr.querySelector<HTMLElement>(`[data-rowtotal="${productId}"]`);
    if (!cell) return;
    let total = 0;
    for (const input of tr.querySelectorAll<HTMLInputElement>('.qty-input')) {
      total += Number(input.value) || 0;
    }
    cell.textContent = String(total);
  }

  /* ================= Entrega ================= */
  const dueInput = el('input', {
    type: 'date',
    value: toDateInput(dueDate),
    on: {
      change: () => {
        const t = new Date(`${dueInput.value}T12:00:00`).getTime();
        dueDate = Number.isNaN(t) ? undefined : t;
      },
    },
  });

  const notesInput = el('textarea', {
    placeholder: 'Notas del pedido (opcional)',
    rows: '2',
    on: {
      input: () => {
        notes = notesInput.value;
      },
    },
  });

  view.appendChild(
    card({
      title: '3 · Entrega',
      content: el(
        'div',
        { class: 'form-row' },
        el(
          'div',
          { class: 'field' },
          el('label', { for: 'due', text: 'Fecha de entrega' }),
          dueInput,
        ),
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Notas' }),
          notesInput,
        ),
      ),
    }),
  );

  /* ================= Resumen ================= */
  const summaryBox = el('div');
  const saveBtn = el('button', {
    class: 'btn btn-primary btn-lg btn-block',
    type: 'button',
    on: { click: () => void save() },
  });

  function updateSummary(): void {
    const lines = [...quantities.entries()]
      .map(([variantId, qty]) => {
        const variant = app.state.variants.get(variantId);
        const product = variant ? app.state.products.get(variant.productId) : undefined;
        const price = variant?.priceCents || product?.basePriceCents || 0;
        return { variantId, qty, price, total: price * qty };
      })
      .filter((l) => l.qty > 0);

    const units = lines.reduce((s, l) => s + l.qty, 0);
    const total = lines.reduce((s, l) => s + l.total, 0);

    summaryBox.replaceChildren(
      el(
        'div',
        { class: 'row-between' },
        el('span', { class: 'muted', text: `${units} unidad(es)` }),
        el('span', { class: 'strong', style: { fontSize: '1.25rem' }, text: money(total) }),
      ),
    );

    saveBtn.disabled = !customer || lines.length === 0;
    saveBtn.textContent = customer ? 'Guardar pedido' : 'Elegí un cliente';
  }

  function currentLines() {
    return [...quantities.entries()]
      .filter(([, qty]) => qty > 0)
      .map(([variantId, qty]) => ({ variantId, quantity: qty }));
  }

  async function save(): Promise<void> {
    if (!customer) {
      toastError('Elegí un cliente.');
      return;
    }
    const lines = currentLines();
    if (lines.length === 0) {
      toastError('Cargá al menos una cantidad.');
      return;
    }

    saveBtn.disabled = true;
    try {
      const result = await createOrder(app, {
        customerId: customer.id,
        dueDate,
        notes: notes.trim() || undefined,
        lines,
      });

      if (result.warnings.length > 0) {
        toastSuccess(
          `Pedido creado. ${result.warnings.length} línea(s) sin stock quedan como "a producir".`,
        );
      } else {
        toastSuccess('Pedido creado.');
      }

      shell.router.navigate(`/pedidos/${result.id}`);
    } catch (err) {
      showError(err);
      saveBtn.disabled = false;
    }
  }

  // Atajo: Ctrl+Enter guarda.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      void save();
    }
  };
  document.addEventListener('keydown', onKey);
  // Limpieza al salir de la vista.
  const observer = new MutationObserver(() => {
    if (!document.body.contains(view)) {
      document.removeEventListener('keydown', onKey);
      observer.disconnect();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  view.appendChild(
    card({
      title: '4 · Resumen',
      content: el(
        'div',
        {},
        summaryBox,
        el('div', { class: 'mt-4' }, saveBtn),
        el('div', {
          class: 'xsmall dim center mt-3',
          text: 'Atajo: Ctrl + Enter para guardar',
        }),
      ),
    }),
  );

  renderGrid();
  updateSummary();

  void statusBadge;
  void orderTotals;
  void formatDate;
  void ValidationError;
  void addOrderLine;
  return view;
}

/** Modal rápido para crear un cliente mientras se carga un pedido. */
export function openCreateCustomer(
  app: App,
  initialName: string,
  onCreated: (c: Customer) => void,
): void {
  const nameInput = el('input', { type: 'text', value: initialName, placeholder: 'Nombre y apellido' });
  const phoneInput = el('input', { type: 'tel', placeholder: 'WhatsApp (ej: 11 1234-5678)' });

  const modal = openModal({
    title: 'Nuevo cliente',
    body: el(
      'div',
      {},
      el('div', { class: 'field' }, el('label', { text: 'Nombre' }), nameInput),
      el('div', { class: 'field' }, el('label', { text: 'Teléfono' }), phoneInput),
    ),
    actions: [
      el('button', { class: 'btn', type: 'button', text: 'Cancelar', on: { click: () => modal.close() } }),
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Crear',
        on: {
          click: async () => {
            try {
              const { id } = await createCustomer(app, {
                name: nameInput.value,
                phone: phoneInput.value || undefined,
              });
              const created = app.state.customers.get(id)!;
              modal.close();
              onCreated(created);
            } catch (err) {
              showError(err);
            }
          },
        },
      }),
    ],
  });
}
