import { el, icon } from '../dom';
import { card, emptyState, money } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { showError, toastSuccess, toastWarning } from '../components/toast';
import { openModal } from '../components/modal';
import { parseMoneyToCents } from '../../core/money';
import { SIZES } from '../../core/sizes';
import { toDateInput } from '../../core/dates';
import type { ProductType, Season, SizeCode } from '../../core/types';
import {
  createCollection,
  createCustomer,
  createProduct,
  generateVariants,
  setInitialStock,
} from '../../domain/commands';

type ImportKind = 'productos' | 'clientes' | 'pedidos';

interface ColumnMap {
  key: string;
  label: string;
  required?: boolean;
  aliases: string[];
}

const COLUMNS: Record<ImportKind, ColumnMap[]> = {
  productos: [
    { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'codigo', 'código', 'code', 'referencia'] },
    { key: 'nombre', label: 'Nombre', required: true, aliases: ['nombre', 'name', 'producto', 'descripcion'] },
    { key: 'tipo', label: 'Tipo', aliases: ['tipo', 'type', 'prenda'] },
    { key: 'coleccion', label: 'Colección', aliases: ['coleccion', 'colección', 'collection', 'temporada'] },
    { key: 'precio', label: 'Precio de venta', aliases: ['precio', 'price', 'precio_venta', 'valor'] },
    { key: 'tela', label: 'Costo tela', aliases: ['tela', 'costo_tela', 'fabric'] },
    { key: 'estampado', label: 'Costo estampado', aliases: ['estampado', 'costo_estampado', 'print'] },
    { key: 'manoObra', label: 'Costo mano de obra', aliases: ['mano_obra', 'manodeobra', 'labor', 'mano de obra'] },
    { key: 'otros', label: 'Otros costos', aliases: ['otros', 'other', 'otros_costos'] },
    { key: 'talles', label: 'Talles', aliases: ['talles', 'sizes', 'size'] },
    { key: 'colores', label: 'Colores', aliases: ['colores', 'colors', 'color'] },
    { key: 'stock', label: 'Stock inicial', aliases: ['stock', 'stock_inicial', 'existencias', 'cantidad'] },
  ],
  clientes: [
    { key: 'nombre', label: 'Nombre', required: true, aliases: ['nombre', 'name', 'cliente'] },
    { key: 'telefono', label: 'Teléfono', aliases: ['telefono', 'teléfono', 'phone', 'whatsapp', 'celular'] },
    { key: 'email', label: 'Email', aliases: ['email', 'mail', 'correo'] },
    { key: 'direccion', label: 'Dirección', aliases: ['direccion', 'dirección', 'address'] },
    { key: 'notas', label: 'Notas', aliases: ['notas', 'notes', 'observaciones'] },
  ],
  pedidos: [
    { key: 'cliente', label: 'Cliente', required: true, aliases: ['cliente', 'customer', 'nombre'] },
    { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'codigo', 'código', 'producto'] },
    { key: 'talle', label: 'Talle', aliases: ['talle', 'size'] },
    { key: 'color', label: 'Color', aliases: ['color'] },
    { key: 'cantidad', label: 'Cantidad', required: true, aliases: ['cantidad', 'quantity', 'cant', 'unidades'] },
    { key: 'precio', label: 'Precio unitario', aliases: ['precio', 'price', 'precio_unitario'] },
    { key: 'entrega', label: 'Fecha de entrega', aliases: ['entrega', 'fecha', 'date', 'vencimiento'] },
  ],
};

/** Divide una línea CSV respetando comillas. */
export function parseCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

/** Detecta el delimitador más probable (coma o punto y coma). */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  return semis > commas ? ';' : ',';
}

export function parseCsv(text: string, delimiter?: string): string[][] {
  const d = delimiter ?? detectDelimiter(text);
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  return lines.map((l) => parseCsvLine(l, d));
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s-]+/g, '_');
}

export function importCsvView(app: App, shell: Shell): HTMLElement {
  let kind: ImportKind = 'productos';
  let text = '';
  let headers: string[] = [];
  let rows: string[][] = [];
  let mapping: Record<string, string> = {};

  const view = el('div');
  const container = el('div');

  /* ---------------- Selector de tipo ---------------- */
  const kindRow = el('div', { class: 'chip-row' });
  function renderKinds() {
    kindRow.replaceChildren();
    const items: [ImportKind, string][] = [
      ['productos', 'Productos y stock'],
      ['clientes', 'Clientes'],
      ['pedidos', 'Pedidos'],
    ];
    for (const [key, label] of items) {
      kindRow.appendChild(
        el('button', {
          class: `chip${kind === key ? ' active' : ''}`,
          type: 'button',
          text: label,
          on: {
            click: () => {
              kind = key;
              text = '';
              headers = [];
              rows = [];
              mapping = {};
              renderKinds();
              render();
            },
          },
        }),
      );
    }
  }
  renderKinds();

  view.appendChild(
    el(
      'div',
      { class: 'row-between mb-4' },
      el(
        'button',
        {
          class: 'btn btn-ghost btn-sm',
          type: 'button',
          on: { click: () => shell.router.navigate('/') },
        },
        icon('arrowLeft', 18),
        'Inicio',
      ),
      el('div', { class: 'small dim', text: 'Importación inicial de datos' }),
    ),
  );

  view.appendChild(
    card({
      title: '1 · ¿Qué querés importar?',
      content: el(
        'div',
        {},
        kindRow,
        el('p', {
          class: 'small muted mt-3',
          text: KIND_HELP[kind],
        }),
      ),
    }),
  );

  view.appendChild(container);

  function render(): void {
    container.replaceChildren();

    /* ---------------- Paso 2: carga del archivo ---------------- */
    if (!text) {
      container.appendChild(
        card({
          title: '2 · Cargar el archivo',
          content: el(
            'div',
            {},
            el(
              'button',
              {
                class: 'btn btn-primary',
                type: 'button',
                on: { click: () => pickFile() },
              },
              icon('upload', 18),
              'Elegir archivo CSV',
            ),
            el('div', { class: 'divider' }),
            el('div', { class: 'field' },
              el('label', { text: 'O pegá el contenido directamente' }),
              textarea,
            ),
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Continuar',
              on: { click: () => analyze() },
            }),
          ),
        }),
      );
      return;
    }

    /* ---------------- Paso 3: mapeo de columnas ---------------- */
    const mapRows = el('div');
    for (const col of COLUMNS[kind]) {
      const select = el(
        'select',
        {
          on: {
            change: () => {
              mapping[col.key] = select.value;
            },
          },
        },
        el('option', { value: '', text: '— no usar —' }),
        ...headers.map((h) => el('option', { value: h, text: h })),
      );
      select.value = mapping[col.key] ?? '';
      mapRows.appendChild(
        el(
          'div',
          { class: 'field' },
          el('label', { text: col.required ? `${col.label} *` : col.label }),
          select,
        ),
      );
    }

    container.appendChild(
      card({
        title: '3 · Mapear columnas',
        subtitle: `Se detectaron ${headers.length} columnas y ${rows.length} fila(s).`,
        content: el(
          'div',
          {},
          el(
            'div',
            { class: 'form-row' },
            ...Array.from(mapRows.children).map((child) => child),
          ),
          el(
            'div',
            { class: 'btn-group mt-4' },
            el('button', {
              class: 'btn',
              type: 'button',
              text: 'Cambiar archivo',
              on: {
                click: () => {
                  text = '';
                  headers = [];
                  rows = [];
                  render();
                },
              },
            }),
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Importar',
              on: { click: () => void runImport() },
            }),
          ),
        ),
      }),
    );

    /* ---------------- Vista previa ---------------- */
    container.appendChild(
      card({
        title: 'Vista previa',
        count: rows.length,
        content: (() => {
          const preview = rows.slice(0, 8);
          const table = el('table', { class: 'data' });
          table.appendChild(
            el(
              'thead',
              {},
              el('tr', {}, ...headers.map((h) => el('th', { text: h }))),
            ),
          );
          const tbody = el('tbody');
          for (const row of preview) {
            tbody.appendChild(el('tr', {}, ...headers.map((_, i) => el('td', { class: 'small', text: row[i] ?? '' }))));
          }
          table.appendChild(tbody);
          return el(
            'div',
            {},
            el('div', { class: 'table-wrap' }, table),
            rows.length > 8
              ? el('div', { class: 'xsmall dim mt-3', text: `Mostrando las primeras 8 de ${rows.length} filas.` })
              : null,
          );
        })(),
      }),
    );
  }

  /* ---------------- Textarea ---------------- */
  const textarea = el('textarea', {
    rows: '6',
    placeholder: 'sku;nombre;tipo;coleccion;precio;...\nREM-001;Remera básica;remera;Invierno 2026;12000;...',
    on: {
      input: () => {
        text = textarea.value;
      },
    },
  });

  function pickFile(): void {
    const input = el('input', { type: 'file', accept: '.csv,text/csv' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      const content = await file.text();
      textarea.value = content;
      text = content;
      analyze();
    });
    input.click();
  }

  function analyze(): void {
    if (!text.trim()) {
      showError(new Error('Cargá un archivo o pegá el contenido CSV.'));
      return;
    }
    const parsed = parseCsv(text);
    if (parsed.length < 2) {
      showError(new Error('El CSV necesita una fila de encabezados y al menos una fila de datos.'));
      return;
    }
    headers = parsed[0].map(normalizeHeader);
    rows = parsed.slice(1);

    // Auto-mapeo por alias.
    mapping = {};
    for (const col of COLUMNS[kind]) {
      const found = headers.find((h) => col.aliases.includes(h) || h.includes(col.key.toLowerCase()));
      if (found) mapping[col.key] = found;
    }
    render();
  }

  async function runImport(): Promise<void> {
    const cols = COLUMNS[kind];
    for (const col of cols) {
      if (col.required && !mapping[col.key]) {
        showError(new Error(`Falta mapear la columna "${col.label}".`));
        return;
      }
    }

    const get = (row: string[], key: string): string => {
      const header = mapping[key];
      if (!header) return '';
      const idx = headers.indexOf(header);
      return idx >= 0 ? (row[idx] ?? '').trim() : '';
    };

    let created = 0;
    let skipped = 0;
    const warnings: string[] = [];

    try {
      if (kind === 'productos') {
        for (const row of rows) {
          const sku = get(row, 'sku');
          const name = get(row, 'nombre');
          if (!sku || !name) {
            skipped++;
            continue;
          }
          if ([...app.state.products.values()].some((p) => p.sku.toUpperCase() === sku.toUpperCase())) {
            skipped++;
            warnings.push(`El producto ${sku} ya existe.`);
            continue;
          }

          // Colección (crea si no existe).
          const collName = get(row, 'coleccion') || 'Sin colección';
          let collection = [...app.state.collections.values()].find(
            (c) => !c.deletedAt && c.name.toLowerCase() === collName.toLowerCase(),
          );
          if (!collection) {
            const { id } = await createCollection(app, {
              name: collName,
              season: guessSeason(collName),
              year: guessYear(collName),
            });
            collection = app.state.collections.get(id)!;
          }

          const price = parseMoneyToCents(get(row, 'precio')) ?? 0;
          const tela = parseMoneyToCents(get(row, 'tela')) ?? 0;
          const estampado = parseMoneyToCents(get(row, 'estampado')) ?? 0;
          const manoObra = parseMoneyToCents(get(row, 'manoObra')) ?? 0;
          const otros = parseMoneyToCents(get(row, 'otros')) ?? 0;

          const { id } = await createProduct(app, {
            collectionId: collection.id,
            sku,
            name,
            type: (get(row, 'tipo').toLowerCase().includes('buzo') ? 'buzo' : 'remera') as ProductType,
            basePriceCents: price,
            costFabricCents: tela,
            costPrintCents: estampado,
            costLaborCents: manoObra,
            costOtherCents: otros,
          });
          created++;

          // Colores y talles.
          const colorNames = splitList(get(row, 'colores'));
          const sizeNames = splitList(get(row, 'talles'));
          const colorIds: string[] = [];
          for (const cname of colorNames) {
            let color = [...app.state.colors.values()].find(
              (c) => !c.deletedAt && c.name.toLowerCase() === cname.toLowerCase(),
            );
            if (!color) {
              const { createColor } = await import('../../domain/commands');
              const { id: cid } = await createColor(app, { name: cname, hex: '#4a5568' });
              color = app.state.colors.get(cid)!;
            }
            colorIds.push(color.id);
          }

          const sizeCodes = sizeNames
            .map((s) => s.toUpperCase().replace(/^(TALLE|TALLA|)\s*/, ''))
            .map((s) => SIZES.find((x) => x.code === s)?.code)
            .filter((s): s is SizeCode => !!s);

          if (colorIds.length > 0 && sizeCodes.length > 0) {
            await generateVariants(app, id, sizeCodes, colorIds, {
              costCents: tela + estampado + manoObra + otros,
              priceCents: price,
            });

            // Stock inicial (repartido en la primera variante de cada color).
            const initialStock = Math.floor(Number(get(row, 'stock')) || 0);
            if (initialStock > 0) {
              const variants = [...(app.state.variantsByProduct.get(id) ?? [])]
                .map((vid) => app.state.variants.get(vid))
                .filter((v) => v && !v.deletedAt);
              const perColor = new Map<string, number>();
              for (const v of variants) {
                const count = perColor.get(v!.colorId) ?? 0;
                perColor.set(v!.colorId, count + 1);
              }
              for (const v of variants) {
                const idx = perColor.get(v!.colorId)!;
                if (idx !== 1) continue;
                await setInitialStock(app, v!.id, initialStock, 'Carga inicial (importación)');
              }
            }
          }
        }
      } else if (kind === 'clientes') {
        for (const row of rows) {
          const name = get(row, 'nombre');
          if (!name) {
            skipped++;
            continue;
          }
          await createCustomer(app, {
            name,
            phone: get(row, 'telefono') || undefined,
            email: get(row, 'email') || undefined,
            address: get(row, 'direccion') || undefined,
            notes: get(row, 'notas') || undefined,
          });
          created++;
        }
      } else {
        // pedidos
        const { createOrder } = await import('../../domain/commands');
        const grouped = new Map<string, { rows: string[][] }>();
        for (const row of rows) {
          const key = `${get(row, 'cliente')}|${get(row, 'entrega')}`;
          const entry = grouped.get(key) ?? { rows: [] };
          entry.rows.push(row);
          grouped.set(key, entry);
        }

        for (const [, group] of grouped) {
          const first = group.rows[0];
          const clientName = get(first, 'cliente');
          if (!clientName) {
            skipped++;
            continue;
          }

          let customer = [...app.state.customers.values()].find(
            (c) => !c.deletedAt && c.name.toLowerCase() === clientName.toLowerCase(),
          );
          if (!customer) {
            const { id } = await createCustomer(app, { name: clientName });
            customer = app.state.customers.get(id)!;
          }

          const lines: { variantId: string; quantity: number; unitPriceCents?: number }[] = [];
          for (const row of group.rows) {
            const sku = get(row, 'sku');
            const variant = [...app.state.variants.values()].find(
              (v) => !v.deletedAt && v.sku.toUpperCase() === sku.toUpperCase(),
            );
            if (!variant) {
              warnings.push(`No encontré la variante con SKU "${sku}". Se omite esa línea.`);
              skipped++;
              continue;
            }
            lines.push({
              variantId: variant.id,
              quantity: Math.max(1, Math.floor(Number(get(row, 'cantidad')) || 1)),
              unitPriceCents: parseMoneyToCents(get(row, 'precio')) ?? undefined,
            });
          }
          if (lines.length === 0) {
            skipped++;
            continue;
          }

          const dueRaw = get(first, 'entrega');
          const dueDate = dueRaw ? new Date(`${dueRaw}T12:00:00`).getTime() : undefined;

          await createOrder(app, {
            customerId: customer.id,
            dueDate: Number.isNaN(dueDate as number) ? undefined : dueDate,
            lines,
          });
          created++;
        }
      }

      toastSuccess(`Importación completa: ${created} creados, ${skipped} omitidos.`);
      if (warnings.length > 0) {
        toastWarning(warnings.slice(0, 3).join(' '));
      }
      shell.router.navigate('/');
    } catch (err) {
      showError(err);
    }
  }

  render();
  return view;
}

/* ------------------------------------------------------------------ */

const KIND_HELP: Record<ImportKind, string> = {
  productos:
    'Columnas sugeridas: sku, nombre, tipo, coleccion, precio, tela, estampado, mano_obra, otros, talles, colores, stock. Talles separados por | o ;. Colores separados por | o ;.',
  clientes: 'Columnas sugeridas: nombre, telefono, email, direccion, notas.',
  pedidos:
    'Columnas sugeridas: cliente, sku, talle, color, cantidad, precio, entrega. Las líneas con el mismo cliente y fecha se agrupan en un pedido.',
};

function splitList(value: string): string[] {
  return value
    .split(/[|;]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function guessSeason(name: string): Season {
  const n = name.toLowerCase();
  if (n.includes('invierno') || n.includes('winter')) return 'invierno';
  if (n.includes('verano') || n.includes('summer')) return 'verano';
  if (n.includes('otono') || n.includes('autumn')) return 'otono';
  return 'primavera';
}

function guessYear(name: string): number {
  const match = name.match(/(20\d{2})/);
  return match ? Number(match[1]) : new Date().getFullYear();
}

export { money, emptyState, toDateInput };
