import type {
  Collection,
  Color,
  Customer,
  DomainEvent,
  Expense,
  ExpenseCategory,
  MovementType,
  Order,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  Product,
  ProductType,
  ProductionOrder,
  ProductionStatus,
  Season,
  SizeCode,
  Variant,
} from '../core/types';
import type { App } from '../app/App';
import { productTotalCost } from '../projection/queries';
import { uuid7 } from '../core/ids';
import { SIZES } from '../core/sizes';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface CommandResult {
  ok: boolean;
  /** Advertencias no bloqueantes (ej: "no hay stock, se marca como a producir"). */
  warnings: string[];
}

const ok = (warnings: string[] = []): CommandResult => ({ ok: true, warnings });

/* ================================================================== */
/* Catálogo                                                            */
/* ================================================================== */

export async function createCollection(
  app: App,
  data: {
    name: string;
    season: Season;
    year: number;
    startDate?: number;
    endDate?: number;
    slug?: string;
  },
): Promise<{ id: string }> {
  const name = data.name.trim();
  if (!name) throw new ValidationError('El nombre de la colección no puede estar vacío.');

  const slug =
    data.slug?.trim() ||
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

  const existing = [...app.state.collections.values()].find((c) => c.slug === slug && !c.deletedAt);
  if (existing) throw new ValidationError(`Ya existe una colección con el identificador "${slug}".`);

  const id = uuid7();
  const maxOrder = Math.max(0, ...[...app.state.collections.values()].map((c) => c.sortOrder));
  await app.emit('Collection.Created', {
    id,
    name,
    slug,
    season: data.season,
    year: data.year,
    startDate: data.startDate,
    endDate: data.endDate,
    sortOrder: maxOrder + 10,
  });
  return { id };
}

export async function updateCollection(
  app: App,
  id: string,
  patch: Partial<Pick<Collection, 'name' | 'season' | 'year' | 'startDate' | 'endDate' | 'isActive'>>,
): Promise<void> {
  if (!app.state.collections.has(id)) throw new ValidationError('La colección no existe.');
  await app.emit('Collection.Updated', { collectionId: id, ...patch });
}

export async function deleteCollection(app: App, id: string): Promise<void> {
  const products = app.state.productsByCollection.get(id);
  if (products && products.size > 0) {
    const hasStock = [...products].some((pid) =>
      [...(app.state.variantsByProduct.get(pid) ?? [])].some(
        (vid) => (app.state.stock.get(vid)?.totalQty ?? 0) > 0,
      ),
    );
    if (hasStock) {
      throw new ValidationError(
        'No podés eliminar una colección con stock existente. Archivala en su lugar.',
      );
    }
  }
  await app.emit('Collection.Deleted', { collectionId: id });
}

export interface ProductInput {
  collectionId: string;
  sku: string;
  name: string;
  type: ProductType;
  description?: string;
  basePriceCents: number;
  costFabricCents: number;
  costPrintCents: number;
  costLaborCents: number;
  costOtherCents: number;
}

export async function createProduct(app: App, input: ProductInput): Promise<{ id: string }> {
  const name = input.name.trim();
  const sku = input.sku.trim().toUpperCase();
  if (!name) throw new ValidationError('El nombre del producto no puede estar vacío.');
  if (!sku) throw new ValidationError('El SKU no puede estar vacío.');
  if (!app.state.collections.has(input.collectionId)) {
    throw new ValidationError('La colección no existe.');
  }
  const dup = [...app.state.products.values()].find(
    (p) => p.sku.toUpperCase() === sku && !p.deletedAt,
  );
  if (dup) throw new ValidationError(`Ya existe un producto con el SKU "${sku}".`);
  if (input.basePriceCents < 0) throw new ValidationError('El precio no puede ser negativo.');

  const id = uuid7();
  const maxOrder = Math.max(0, ...[...app.state.products.values()].map((p) => p.sortOrder));
  await app.emit('Product.Created', {
    id,
    ...input,
    name,
    sku,
    sortOrder: maxOrder + 10,
  });
  return { id };
}

export async function updateProduct(
  app: App,
  id: string,
  patch: Partial<ProductInput> & { isActive?: boolean },
): Promise<void> {
  const product = app.state.products.get(id);
  if (!product) throw new ValidationError('El producto no existe.');
  if (patch.sku) {
    const sku = patch.sku.trim().toUpperCase();
    const dup = [...app.state.products.values()].find(
      (p) => p.id !== id && p.sku.toUpperCase() === sku && !p.deletedAt,
    );
    if (dup) throw new ValidationError(`Ya existe un producto con el SKU "${sku}".`);
    patch = { ...patch, sku };
  }
  await app.emit('Product.Updated', { productId: id, ...patch });
}

export async function deleteProduct(app: App, id: string): Promise<void> {
  await app.emit('Product.Deleted', { productId: id });
}

export async function createColor(
  app: App,
  data: { name: string; hex: string },
): Promise<{ id: string }> {
  const name = data.name.trim();
  if (!name) throw new ValidationError('El nombre del color no puede estar vacío.');
  const dup = [...app.state.colors.values()].find(
    (c) => c.name.toLowerCase() === name.toLowerCase() && !c.deletedAt,
  );
  if (dup) throw new ValidationError(`Ya existe el color "${name}".`);
  const id = uuid7();
  const maxOrder = Math.max(0, ...[...app.state.colors.values()].map((c) => c.sortOrder));
  await app.emit('Color.Created', { id, name, hex: data.hex, sortOrder: maxOrder + 10 });
  return { id };
}

export async function updateColor(
  app: App,
  id: string,
  patch: Partial<Pick<Color, 'name' | 'hex' | 'isActive'>>,
): Promise<void> {
  await app.emit('Color.Updated', { colorId: id, ...patch });
}

export async function deleteColor(app: App, id: string): Promise<void> {
  await app.emit('Color.Deleted', { colorId: id });
}

export interface VariantInput {
  productId: string;
  sizeCode: SizeCode;
  colorId: string;
  minStock?: number;
  costCents?: number;
  priceCents?: number;
  barcode?: string;
}

/** Genera el producto cartesiano talles × colores para un producto. */
export async function generateVariants(
  app: App,
  productId: string,
  sizeCodes: SizeCode[],
  colorIds: string[],
  defaults: { minStock?: number; costCents?: number; priceCents?: number } = {},
): Promise<number> {
  const product = app.state.products.get(productId);
  if (!product) throw new ValidationError('El producto no existe.');
  if (sizeCodes.length === 0) throw new ValidationError('Elegí al menos un talle.');
  if (colorIds.length === 0) throw new ValidationError('Elegí al menos un color.');

  const existing = new Set(
    [...(app.state.variantsByProduct.get(productId) ?? [])].map(
      (vid) => `${app.state.variants.get(vid)?.sizeCode}|${app.state.variants.get(vid)?.colorId}`,
    ),
  );

  const payloads: any[] = [];
  for (const colorId of colorIds) {
    if (!app.state.colors.has(colorId)) continue;
    for (const sizeCode of SIZES.map((s) => s.code).filter((c) => sizeCodes.includes(c))) {
      if (existing.has(`${sizeCode}|${colorId}`)) continue;
      const color = app.state.colors.get(colorId)!;
      payloads.push({
        id: uuid7(),
        productId,
        sizeCode,
        colorId,
        sku: `${product.sku}-${sizeCode}-${color.name.slice(0, 3).toUpperCase()}`,
        minStock: defaults.minStock ?? 0,
        costCents: defaults.costCents ?? productTotalCost(product),
        priceCents: defaults.priceCents ?? product.basePriceCents,
        sortOrder: SIZES.find((s) => s.code === sizeCode)?.sortOrder ?? 0,
      });
    }
  }

  if (payloads.length === 0) return 0;
  await app.emitMany('Variant.Created', payloads);
  return payloads.length;
}

export async function updateVariant(
  app: App,
  id: string,
  patch: Partial<Pick<Variant, 'minStock' | 'costCents' | 'priceCents' | 'barcode' | 'isActive' | 'sku'>>,
): Promise<void> {
  await app.emit('Variant.Updated', { variantId: id, ...patch });
}

export async function deleteVariant(app: App, id: string): Promise<void> {
  await app.emit('Variant.Deleted', { variantId: id });
}

/* ================================================================== */
/* Clientes                                                            */
/* ================================================================== */

export async function createCustomer(
  app: App,
  data: { name: string; phone?: string; email?: string; address?: string; notes?: string; taxId?: string },
): Promise<{ id: string }> {
  const name = data.name.trim();
  if (!name) throw new ValidationError('El nombre del cliente no puede estar vacío.');
  const id = uuid7();
  await app.emit('Customer.Created', { id, ...data, name });
  return { id };
}

export async function updateCustomer(
  app: App,
  id: string,
  patch: Partial<Pick<Customer, 'name' | 'phone' | 'email' | 'address' | 'notes' | 'taxId' | 'isActive'>>,
): Promise<void> {
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new ValidationError('El nombre del cliente no puede estar vacío.');
  }
  await app.emit('Customer.Updated', { customerId: id, ...patch });
}

export async function deleteCustomer(app: App, id: string): Promise<void> {
  const hasOrders = [...app.state.orders.values()].some(
    (o) => o.customerId === id && !o.deletedAt && o.status !== 'cancelado',
  );
  if (hasOrders) {
    throw new ValidationError('No podés eliminar un cliente con pedidos. Archivalo en su lugar.');
  }
  await app.emit('Customer.Deleted', { customerId: id });
}

/* ================================================================== */
/* Pedidos                                                             */
/* ================================================================== */

export interface OrderLineInput {
  variantId: string;
  quantity: number;
  unitPriceCents?: number;
  costCents?: number;
}

export interface CreateOrderInput {
  customerId: string;
  collectionId?: string;
  dueDate?: number;
  notes?: string;
  lines: OrderLineInput[];
}

/**
 * Crea un pedido con sus líneas en una sola operación.
 * Devuelve advertencias si hay líneas sin stock disponible
 * (permitido: quedan marcadas como "a producir").
 */
export async function createOrder(
  app: App,
  input: CreateOrderInput,
): Promise<{ id: string; warnings: string[] }> {
  if (!input.customerId) throw new ValidationError('Elegí un cliente.');
  if (!app.state.customers.has(input.customerId)) throw new ValidationError('El cliente no existe.');
  if (input.lines.length === 0) throw new ValidationError('Agregá al menos un producto.');

  const warnings: string[] = [];
  const orderId = uuid7();

  const lines = input.lines
    .filter((l) => l.quantity > 0)
    .map((l) => {
      const variant = app.state.variants.get(l.variantId);
      if (!variant) throw new ValidationError('Una de las variantes no existe.');
      const product = app.state.products.get(variant.productId);
      if (!product) throw new ValidationError('Uno de los productos no existe.');

      const price = l.unitPriceCents ?? (variant.priceCents || product.basePriceCents);
      const cost = l.costCents ?? (variant.costCents || productTotalCost(product));

      const agg = app.state.stock.get(variant.id);
      const available = agg?.availableQty ?? 0;
      if (l.quantity > available) {
        const color = app.state.colors.get(variant.colorId)?.name ?? '';
        warnings.push(
          `${product.name} ${variant.sizeCode} ${color}: pedís ${l.quantity} y hay ${available} disponibles. Queda como "a producir".`,
        );
      }

      return {
        id: uuid7(),
        orderId,
        variantId: variant.id,
        quantity: l.quantity,
        unitPriceCents: price,
        costCents: cost,
      };
    });

  if (lines.length === 0) throw new ValidationError('Agregá al menos un producto con cantidad.');

  await app.emit('Order.Created', {
    id: orderId,
    customerId: input.customerId,
    collectionId: input.collectionId,
    status: 'pendiente' as OrderStatus,
    paymentStatus: 'sin_pagar' as PaymentStatus,
    dueDate: input.dueDate,
    notes: input.notes,
  });

  await app.emitMany('OrderLine.Added', lines);

  return { id: orderId, warnings };
}

export async function updateOrder(
  app: App,
  id: string,
  patch: Partial<Pick<Order, 'customerId' | 'collectionId' | 'status' | 'paymentStatus' | 'dueDate' | 'notes'>>,
): Promise<void> {
  const order = app.state.orders.get(id);
  if (!order) throw new ValidationError('El pedido no existe.');
  await app.emit('Order.Updated', { orderId: id, ...patch });
}

export async function deleteOrder(app: App, id: string): Promise<void> {
  await app.emit('Order.Deleted', { orderId: id });
}

export async function addOrderLine(
  app: App,
  orderId: string,
  input: OrderLineInput,
): Promise<void> {
  const order = app.state.orders.get(orderId);
  if (!order) throw new ValidationError('El pedido no existe.');
  const variant = app.state.variants.get(input.variantId);
  if (!variant) throw new ValidationError('La variante no existe.');
  const product = app.state.products.get(variant.productId);
  if (!product) throw new ValidationError('El producto no existe.');
  if (input.quantity <= 0) throw new ValidationError('La cantidad debe ser mayor a cero.');

  await app.emit('OrderLine.Added', {
    id: uuid7(),
    orderId,
    variantId: variant.id,
    quantity: input.quantity,
    unitPriceCents: input.unitPriceCents ?? (variant.priceCents || product.basePriceCents),
    costCents: input.costCents ?? (variant.costCents || productTotalCost(product)),
  });
}

export async function updateOrderLine(
  app: App,
  lineId: string,
  patch: { quantity?: number; unitPriceCents?: number; costCents?: number },
): Promise<void> {
  const line = app.state.orderLines.get(lineId);
  if (!line) throw new ValidationError('La línea no existe.');
  if (patch.quantity !== undefined && patch.quantity < line.deliveredQty) {
    throw new ValidationError(
      `No podés bajar la cantidad por debajo de lo ya entregado (${line.deliveredQty}).`,
    );
  }
  await app.emit('OrderLine.Updated', { lineId, ...patch });
}

export async function removeOrderLine(app: App, lineId: string): Promise<void> {
  await app.emit('OrderLine.Removed', { lineId });
}

/**
 * Entrega (total o parcial) de una línea: genera el movimiento de stock
 * tipo "venta" y actualiza la reserva.
 */
export async function deliverOrderLine(
  app: App,
  lineId: string,
  quantity: number,
): Promise<void> {
  const line = app.state.orderLines.get(lineId);
  if (!line) throw new ValidationError('La línea no existe.');
  const remaining = line.quantity - line.deliveredQty;
  if (quantity <= 0) throw new ValidationError('La cantidad a entregar debe ser mayor a cero.');
  if (quantity > remaining) {
    throw new ValidationError(`Solo quedan ${remaining} unidades por entregar en esta línea.`);
  }
  const variant = app.state.variants.get(line.variantId);
  const product = variant ? app.state.products.get(variant.productId) : undefined;

  await app.emit('OrderLine.Delivered', { lineId, deliveredQty: quantity });
  await app.emit('Stock.Movement', {
    id: uuid7(),
    variantId: line.variantId,
    movementType: 'venta' as MovementType,
    quantity: -quantity,
    unitCostCents: line.costCents,
    referenceType: 'order',
    referenceId: line.orderId,
    reason: `Entrega pedido`,
    performedAt: Date.now(),
  });

  // Si todo el pedido quedó entregado, se marca como tal.
  const order = app.state.orders.get(line.orderId);
  if (order && order.status !== 'entregado' && order.status !== 'cancelado') {
    const lines = [...(app.state.orderLinesByOrder.get(order.id) ?? [])]
      .map((id) => app.state.orderLines.get(id))
      .filter((l) => l && !l.deletedAt);
    const allDelivered = lines.length > 0 && lines.every((l) => l!.deliveredQty >= l!.quantity);
    if (allDelivered) {
      await app.emit('Order.Updated', { orderId: order.id, status: 'entregado' as OrderStatus });
    } else if (order.status === 'pendiente') {
      await app.emit('Order.Updated', { orderId: order.id, status: 'en_produccion' as OrderStatus });
    }
  }
  void product;
}

export async function addPayment(
  app: App,
  orderId: string,
  data: { amountCents: number; method: PaymentMethod; reference?: string; notes?: string },
): Promise<void> {
  const order = app.state.orders.get(orderId);
  if (!order) throw new ValidationError('El pedido no existe.');
  if (data.amountCents <= 0) throw new ValidationError('El monto del pago debe ser mayor a cero.');
  await app.emit('Payment.Added', { id: uuid7(), orderId, ...data });
}

export async function removePayment(app: App, paymentId: string): Promise<void> {
  await app.emit('Payment.Removed', { paymentId });
}

/* ================================================================== */
/* Producción                                                          */
/* ================================================================== */

export interface ProductionLineInput {
  variantId: string;
  plannedQty: number;
  notes?: string;
}

export async function createProductionOrder(
  app: App,
  data: {
    collectionId?: string;
    scheduledDate: number;
    notes?: string;
    lines: ProductionLineInput[];
  },
): Promise<{ id: string }> {
  if (data.lines.length === 0) throw new ValidationError('Agregá al menos una variante a producir.');

  const id = uuid7();
  await app.emit('ProductionOrder.Created', {
    id,
    collectionId: data.collectionId,
    scheduledDate: data.scheduledDate,
    status: 'planificada' as ProductionStatus,
    notes: data.notes,
  });
  await app.emitMany(
    'ProductionLine.Added',
    data.lines.map((l) => ({
      id: uuid7(),
      productionOrderId: id,
      variantId: l.variantId,
      plannedQty: l.plannedQty,
      notes: l.notes,
    })),
  );
  return { id };
}

export async function updateProductionOrder(
  app: App,
  id: string,
  patch: Partial<Pick<ProductionOrder, 'collectionId' | 'scheduledDate' | 'status' | 'notes'>>,
): Promise<void> {
  await app.emit('ProductionOrder.Updated', { productionOrderId: id, ...patch });
}

export async function deleteProductionOrder(app: App, id: string): Promise<void> {
  await app.emit('ProductionOrder.Deleted', { productionOrderId: id });
}

export async function addProductionLine(
  app: App,
  productionOrderId: string,
  input: ProductionLineInput,
): Promise<void> {
  if (!app.state.productionOrders.has(productionOrderId)) {
    throw new ValidationError('La orden de producción no existe.');
  }
  if (input.plannedQty <= 0) throw new ValidationError('La cantidad planificada debe ser mayor a cero.');
  await app.emit('ProductionLine.Added', {
    id: uuid7(),
    productionOrderId,
    variantId: input.variantId,
    plannedQty: input.plannedQty,
    notes: input.notes,
  });
}

export async function updateProductionLine(
  app: App,
  lineId: string,
  patch: { plannedQty?: number; completedQty?: number; notes?: string },
): Promise<void> {
  await app.emit('ProductionLine.Updated', { lineId, ...patch });
}

export async function removeProductionLine(app: App, lineId: string): Promise<void> {
  await app.emit('ProductionLine.Removed', { lineId });
}

/**
 * Completar producción de una línea: registra lo producido y genera
 * el movimiento de stock de tipo "produccion".
 */
export async function completeProductionLine(
  app: App,
  lineId: string,
  completedQty: number,
): Promise<void> {
  const line = app.state.productionLines.get(lineId);
  if (!line) throw new ValidationError('La línea de producción no existe.');
  const remaining = line.plannedQty - line.completedQty;
  if (completedQty <= 0) throw new ValidationError('La cantidad debe ser mayor a cero.');
  if (completedQty > remaining) {
    throw new ValidationError(`Solo faltan ${remaining} unidades por completar en esta línea.`);
  }
  const variant = app.state.variants.get(line.variantId);
  const product = variant ? app.state.products.get(variant.productId) : undefined;

  await app.emit('ProductionLine.Completed', { lineId, completedQty });
  await app.emit('Stock.Movement', {
    id: uuid7(),
    variantId: line.variantId,
    movementType: 'produccion' as MovementType,
    quantity: completedQty,
    unitCostCents: variant?.costCents || (product ? productTotalCost(product) : 0),
    referenceType: 'production_order',
    referenceId: line.productionOrderId,
    reason: 'Producción completada',
    performedAt: Date.now(),
  });

  // Vincula lo producido con las líneas de pedidos abiertas de esa variante.
  await linkProducedToOrders(app, line.variantId, completedQty);

  // Si la orden quedó sin pendiente, se completa.
  const po = app.state.productionOrders.get(line.productionOrderId);
  if (po && po.status !== 'completada') {
    const ids = app.state.productionLinesByOrder.get(po.id) ?? new Set<string>();
    const pending = [...ids].some((id) => {
      const l = app.state.productionLines.get(id);
      return l && !l.deletedAt && l.completedQty < l.plannedQty;
    });
    if (!pending) {
      await app.emit('ProductionOrder.Updated', {
        productionOrderId: po.id,
        status: 'completada' as ProductionStatus,
      });
    } else if (po.status === 'planificada') {
      await app.emit('ProductionOrder.Updated', {
        productionOrderId: po.id,
        status: 'en_proceso' as ProductionStatus,
      });
    }
  }
}

/** Marca `producedQty` en las líneas de pedidos que pedían esa variante. */
async function linkProducedToOrders(
  app: App,
  variantId: string,
  qty: number,
): Promise<void> {
  let remaining = qty;
  const candidates: { lineId: string; pending: number; dueDate: number }[] = [];

  for (const order of app.state.orders.values()) {
    if (order.deletedAt) continue;
    if (order.status === 'cancelado' || order.status === 'entregado') continue;
    for (const id of app.state.orderLinesByOrder.get(order.id) ?? []) {
      const line = app.state.orderLines.get(id);
      if (!line || line.deletedAt) continue;
      if (line.variantId !== variantId) continue;
      const pending = line.quantity - line.producedQty;
      if (pending > 0) {
        candidates.push({ lineId: id, pending, dueDate: order.dueDate ?? Number.MAX_SAFE_INTEGER });
      }
    }
  }

  candidates.sort((a, b) => a.dueDate - b.dueDate);
  for (const c of candidates) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, c.pending);
    remaining -= take;
    await app.emit('OrderLine.Produced', { lineId: c.lineId, producedQty: take });
  }
}

/* ================================================================== */
/* Stock                                                               */
/* ================================================================== */

export async function addStockMovement(
  app: App,
  data: {
    variantId: string;
    movementType: MovementType;
    quantity: number;
    reason?: string;
    performedAt?: number;
  },
): Promise<void> {
  const variant = app.state.variants.get(data.variantId);
  if (!variant) throw new ValidationError('La variante no existe.');
  if (data.quantity === 0) throw new ValidationError('La cantidad no puede ser cero.');
  const product = app.state.products.get(variant.productId);

  await app.emit('Stock.Movement', {
    id: uuid7(),
    variantId: data.variantId,
    movementType: data.movementType,
    quantity: data.quantity,
    unitCostCents: variant.costCents || (product ? productTotalCost(product) : 0),
    referenceType: 'manual',
    referenceId: undefined,
    reason: data.reason,
    performedAt: data.performedAt ?? Date.now(),
  });
}

/** Carga de stock inicial (importación / arranque). */
export async function setInitialStock(
  app: App,
  variantId: string,
  qty: number,
  reason = 'Carga inicial',
): Promise<void> {
  await addStockMovement(app, {
    variantId,
    movementType: 'inicial',
    quantity: qty,
    reason,
  });
}

/* ================================================================== */
/* Gastos                                                              */
/* ================================================================== */

export async function createExpense(
  app: App,
  data: {
    date: number;
    category: ExpenseCategory;
    description: string;
    amountCents: number;
    paymentMethod: PaymentMethod;
    reference?: string;
    collectionId?: string;
  },
): Promise<{ id: string }> {
  const description = data.description.trim();
  if (!description) throw new ValidationError('La descripción del gasto no puede estar vacía.');
  if (data.amountCents <= 0) throw new ValidationError('El monto del gasto debe ser mayor a cero.');
  const id = uuid7();
  await app.emit('Expense.Created', { id, ...data, description });
  return { id };
}

export async function updateExpense(
  app: App,
  id: string,
  patch: Partial<{
    date: number;
    category: ExpenseCategory;
    description: string;
    amountCents: number;
    paymentMethod: PaymentMethod;
    reference?: string;
    collectionId?: string;
  }>,
): Promise<void> {
  await app.emit('Expense.Updated', { expenseId: id, ...patch });
}

export async function deleteExpense(app: App, id: string): Promise<void> {
  await app.emit('Expense.Deleted', { expenseId: id });
}

/* ================================================================== */
/* Utilidades                                                          */
/* ================================================================== */

/** Genera el SKU de una variante a partir del producto, talle y color. */
export function buildVariantSku(product: Product, sizeCode: SizeCode, colorName: string): string {
  return `${product.sku}-${sizeCode}-${colorName.slice(0, 3).toUpperCase()}`;
}

export type { DomainEvent };
