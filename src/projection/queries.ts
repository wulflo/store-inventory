import type {
  AppState,
} from './state';
import { lineReservedContribution } from './state';
import type {
  Collection,
  Customer,
  Expense,
  MovementType,
  Order,
  OrderLine,
  PaymentStatus,
  Product,
  ProductionOrder,
  StockAggregate,
  Variant,
} from '../core/types';
import { MS_DAY, startOfDay, startOfWeek } from '../core/dates';

/**
 * Read models: todo lo que la UI necesita, derivado del estado.
 * Funciones puras y sin efectos: fáciles de testear.
 */

/* ------------------------------------------------------------------ */
/* Pedidos                                                             */
/* ------------------------------------------------------------------ */

export interface OrderTotals {
  totalCents: number;
  costCents: number;
  marginCents: number;
  marginPercent: number;
  paidCents: number;
  balanceCents: number;
  units: number;
  lines: number;
  paymentStatus: PaymentStatus;
}

export function orderTotals(state: AppState, order: Order): OrderTotals {
  const lineIds = state.orderLinesByOrder.get(order.id) ?? new Set<string>();
  let totalCents = 0;
  let costCents = 0;
  let units = 0;
  let lines = 0;

  for (const id of lineIds) {
    const line = state.orderLines.get(id);
    if (!line || line.deletedAt) continue;
    totalCents += line.quantity * line.unitPriceCents;
    costCents += line.quantity * line.costCents;
    units += line.quantity;
    lines += 1;
  }

  let paidCents = 0;
  const payIds = state.paymentsByOrder.get(order.id) ?? new Set<string>();
  for (const id of payIds) {
    const pay = state.payments.get(id);
    if (!pay || pay.deletedAt) continue;
    paidCents += pay.amountCents;
  }

  const marginCents = totalCents - costCents;
  const balanceCents = totalCents - paidCents;

  return {
    totalCents,
    costCents,
    marginCents,
    marginPercent: totalCents > 0 ? (marginCents / totalCents) * 100 : 0,
    paidCents,
    balanceCents,
    units,
    lines,
    paymentStatus: derivePaymentStatus(order, paidCents, totalCents),
  };
}

/**
 * El estado de pago se deriva de los pagos, salvo que el dueño haya marcado
 * explícitamente "seña" (que se respeta mientras siga incompleto).
 */
export function derivePaymentStatus(
  order: Order,
  paidCents: number,
  totalCents: number,
): PaymentStatus {
  if (totalCents > 0 && paidCents >= totalCents) return 'pagado';
  if (paidCents <= 0) return 'sin_pagar';
  if (order.paymentStatus === 'sena') return 'sena';
  return 'parcial';
}

export function activeOrders(state: AppState): Order[] {
  return [...state.orders.values()].filter((o) => !o.deletedAt);
}

export function orderCustomer(state: AppState, order: Order): Customer | undefined {
  return state.customers.get(order.customerId);
}

export function orderLines(state: AppState, orderId: string): OrderLine[] {
  const ids = state.orderLinesByOrder.get(orderId) ?? new Set<string>();
  const out: OrderLine[] = [];
  for (const id of ids) {
    const line = state.orderLines.get(id);
    if (line && !line.deletedAt) out.push(line);
  }
  return out;
}

/** Variante + producto + color legibles de una línea. */
export interface LineView {
  line: OrderLine;
  variant?: Variant;
  product?: Product;
  color?: { id: string; name: string; hex: string };
  collection?: Collection;
  lineTotalCents: number;
  lineCostCents: number;
  lineMarginCents: number;
}

export function lineViews(state: AppState, orderId: string): LineView[] {
  return orderLines(state, orderId).map((line) => {
    const variant = state.variants.get(line.variantId);
    const product = variant ? state.products.get(variant.productId) : undefined;
    const color = variant ? state.colors.get(variant.colorId) : undefined;
    const collection = product ? state.collections.get(product.collectionId) : undefined;
    return {
      line,
      variant,
      product,
      color: color ? { id: color.id, name: color.name, hex: color.hex } : undefined,
      collection,
      lineTotalCents: line.quantity * line.unitPriceCents,
      lineCostCents: line.quantity * line.costCents,
      lineMarginCents: line.quantity * (line.unitPriceCents - line.costCents),
    };
  });
}

/* ------------------------------------------------------------------ */
/* Stock                                                               */
/* ------------------------------------------------------------------ */

export interface StockRow {
  aggregate: StockAggregate;
  variant?: Variant;
  product?: Product;
  color?: { id: string; name: string; hex: string };
  collection?: Collection;
}

export function stockRows(state: AppState): StockRow[] {
  const rows: StockRow[] = [];
  for (const variant of state.variants.values()) {
    if (variant.deletedAt) continue;
    const agg = state.stock.get(variant.id);
    if (!agg) continue;
    const product = state.products.get(variant.productId);
    const color = state.colors.get(variant.colorId);
    const collection = product ? state.collections.get(product.collectionId) : undefined;
    rows.push({
      aggregate: agg,
      variant,
      product,
      color: color ? { id: color.id, name: color.name, hex: color.hex } : undefined,
      collection,
    });
  }
  return rows;
}

export function lowStockRows(state: AppState): StockRow[] {
  return stockRows(state)
    .filter((r) => r.aggregate.lowStockAlert && r.aggregate.totalQty > 0)
    .sort((a, b) => a.aggregate.availableQty - b.aggregate.availableQty);
}

/** Variantes cuyo stock total es 0 (necesitan producción). */
export function outOfStockRows(state: AppState): StockRow[] {
  return stockRows(state)
    .filter((r) => r.aggregate.totalQty <= 0)
    .sort((a, b) => (a.product?.name ?? '').localeCompare(b.product?.name ?? ''));
}

/* ------------------------------------------------------------------ */
/* Producción                                                          */
/* ------------------------------------------------------------------ */

export interface ProductionSuggestion {
  variant: Variant;
  product?: Product;
  color?: { id: string; name: string; hex: string };
  neededQty: number;
  availableQty: number;
  suggestQty: number;
  dueDate?: number;
  orderIds: string[];
}

/**
 * "Qué tengo que producir": cruza pedidos pendientes contra stock disponible.
 *
 * neededQty = Σ (cantidad - producida) de líneas de pedidos activos
 * suggestQty = max(0, neededQty - disponible)
 */
export function productionSuggestions(
  state: AppState,
  horizonDays = 30,
  now = Date.now(),
): ProductionSuggestion[] {
  const horizon = now + horizonDays * MS_DAY;
  const byVariant = new Map<
    string,
    { needed: number; dueDate?: number; orderIds: Set<string> }
  >();

  for (const order of state.orders.values()) {
    if (order.deletedAt) continue;
    if (order.status === 'cancelado' || order.status === 'entregado') continue;
    if (order.dueDate && order.dueDate > horizon) continue;

    for (const line of orderLines(state, order.id)) {
      const pending = Math.max(0, line.quantity - line.producedQty);
      if (pending <= 0) continue;
      let entry = byVariant.get(line.variantId);
      if (!entry) {
        entry = { needed: 0, orderIds: new Set() };
        byVariant.set(line.variantId, entry);
      }
      entry.needed += pending;
      entry.orderIds.add(order.id);
      if (order.dueDate && (entry.dueDate === undefined || order.dueDate < entry.dueDate)) {
        entry.dueDate = order.dueDate;
      }
    }
  }

  const out: ProductionSuggestion[] = [];
  for (const [variantId, entry] of byVariant) {
    const variant = state.variants.get(variantId);
    if (!variant || variant.deletedAt) continue;
    const agg = state.stock.get(variantId);
    const available = agg?.availableQty ?? 0;
    out.push({
      variant,
      product: state.products.get(variant.productId),
      color: state.colors.get(variant.colorId)
        ? {
            id: variant.colorId,
            name: state.colors.get(variant.colorId)!.name,
            hex: state.colors.get(variant.colorId)!.hex,
          }
        : undefined,
      neededQty: entry.needed,
      availableQty: available,
      suggestQty: Math.max(0, entry.needed - available),
      dueDate: entry.dueDate,
      orderIds: [...entry.orderIds],
    });
  }
  return out.sort((a, b) => b.suggestQty - a.suggestQty);
}

export interface ProductionOrderView {
  order: ProductionOrder;
  lines: {
    lineId: string;
    variant?: Variant;
    product?: Product;
    color?: { id: string; name: string; hex: string };
    plannedQty: number;
    completedQty: number;
    remainingQty: number;
  }[];
  totalPlanned: number;
  totalRemaining: number;
  isOverdue: boolean;
}

export function productionOrderViews(state: AppState, now = Date.now()): ProductionOrderView[] {
  const out: ProductionOrderView[] = [];
  for (const po of state.productionOrders.values()) {
    if (po.deletedAt) continue;
    const ids = state.productionLinesByOrder.get(po.id) ?? new Set<string>();
    const lines = [];
    let totalPlanned = 0;
    let totalRemaining = 0;
    for (const id of ids) {
      const line = state.productionLines.get(id);
      if (!line || line.deletedAt) continue;
      const variant = state.variants.get(line.variantId);
      const product = variant ? state.products.get(variant.productId) : undefined;
      const color = variant ? state.colors.get(variant.colorId) : undefined;
      const remaining = Math.max(0, line.plannedQty - line.completedQty);
      totalPlanned += line.plannedQty;
      totalRemaining += remaining;
      lines.push({
        lineId: line.id,
        variant,
        product,
        color: color ? { id: color.id, name: color.name, hex: color.hex } : undefined,
        plannedQty: line.plannedQty,
        completedQty: line.completedQty,
        remainingQty: remaining,
      });
    }
    out.push({
      order: po,
      lines,
      totalPlanned,
      totalRemaining,
      isOverdue:
        po.status !== 'completada' &&
        po.status !== 'cancelada' &&
        startOfDay(po.scheduledDate) < startOfDay(now),
    });
  }
  return out.sort((a, b) => a.order.scheduledDate - b.order.scheduledDate);
}

/* ------------------------------------------------------------------ */
/* Colecciones y productos                                             */
/* ------------------------------------------------------------------ */

export interface CollectionSummary {
  collection: Collection;
  productsCount: number;
  unitsProduced: number;
  unitsSold: number;
  stockRemaining: number;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  marginPercent: number;
  expensesCents: number;
  netProfitCents: number;
}

export function collectionSummaries(state: AppState): CollectionSummary[] {
  const out: CollectionSummary[] = [];
  for (const collection of state.collections.values()) {
    if (collection.deletedAt) continue;
    const productIds = state.productsByCollection.get(collection.id) ?? new Set<string>();
    const variantIds = new Set<string>();
    for (const pid of productIds) {
      for (const vid of state.variantsByProduct.get(pid) ?? []) variantIds.add(vid);
    }

    let unitsProduced = 0;
    let unitsSold = 0;
    let stockRemaining = 0;
    for (const vid of variantIds) {
      const agg = state.stock.get(vid);
      if (agg) stockRemaining += agg.totalQty;
      for (const mv of state.stockMovements.values()) {
        if (mv.variantId !== vid) continue;
        if (mv.movementType === 'produccion') unitsProduced += mv.quantity;
        if (mv.movementType === 'venta') unitsSold += Math.abs(mv.quantity);
      }
    }

    let revenueCents = 0;
    let costCents = 0;
    for (const order of state.orders.values()) {
      if (order.deletedAt || order.status === 'cancelado') continue;
      for (const line of orderLines(state, order.id)) {
        if (!variantIds.has(line.variantId)) continue;
        revenueCents += line.quantity * line.unitPriceCents;
        costCents += line.quantity * line.costCents;
      }
    }

    let expensesCents = 0;
    for (const e of state.expenses.values()) {
      if (e.deletedAt) continue;
      if (e.collectionId === collection.id) expensesCents += e.amountCents;
    }

    const profitCents = revenueCents - costCents;
    out.push({
      collection,
      productsCount: productIds.size,
      unitsProduced,
      unitsSold,
      stockRemaining,
      revenueCents,
      costCents,
      profitCents,
      marginPercent: revenueCents > 0 ? (profitCents / revenueCents) * 100 : 0,
      expensesCents,
      netProfitCents: profitCents - expensesCents,
    });
  }
  return out.sort((a, b) => b.collection.year - a.collection.year || a.collection.name.localeCompare(b.collection.name));
}

export interface ProductSummary {
  product: Product;
  collection?: Collection;
  variantCount: number;
  unitsSold: number;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  marginPercent: number;
  stockRemaining: number;
  unitCostCents: number;
}

export function productSummaries(state: AppState): ProductSummary[] {
  const out: ProductSummary[] = [];
  for (const product of state.products.values()) {
    if (product.deletedAt) continue;
    const variantIds = [...(state.variantsByProduct.get(product.id) ?? [])];
    let unitsSold = 0;
    let revenueCents = 0;
    let costCents = 0;
    let stockRemaining = 0;

    for (const vid of variantIds) {
      const agg = state.stock.get(vid);
      if (agg) stockRemaining += agg.totalQty;
      const variant = state.variants.get(vid);
      for (const mv of state.stockMovements.values()) {
        if (mv.variantId !== vid || mv.movementType !== 'venta') continue;
        unitsSold += Math.abs(mv.quantity);
        revenueCents += Math.abs(mv.quantity) * (variant?.priceCents || product.basePriceCents);
        costCents += Math.abs(mv.quantity) * (variant?.costCents || productTotalCost(product));
      }
    }

    const profitCents = revenueCents - costCents;
    out.push({
      product,
      collection: state.collections.get(product.collectionId),
      variantCount: variantIds.length,
      unitsSold,
      revenueCents,
      costCents,
      profitCents,
      marginPercent: revenueCents > 0 ? (profitCents / revenueCents) * 100 : 0,
      stockRemaining,
      unitCostCents: productTotalCost(product),
    });
  }
  return out.sort((a, b) => b.revenueCents - a.revenueCents);
}

export function productTotalCost(product: Product): number {
  return (
    product.costFabricCents +
    product.costPrintCents +
    product.costLaborCents +
    product.costOtherCents
  );
}

/* ------------------------------------------------------------------ */
/* Clientes                                                            */
/* ------------------------------------------------------------------ */

export interface CustomerSummary {
  customer: Customer;
  ordersCount: number;
  totalSpentCents: number;
  totalPaidCents: number;
  balanceCents: number;
  lastOrderAt?: number;
  lastOrderId?: string;
}

export function customerSummaries(state: AppState): CustomerSummary[] {
  const out: CustomerSummary[] = [];
  for (const customer of state.customers.values()) {
    if (customer.deletedAt) continue;
    let ordersCount = 0;
    let totalSpentCents = 0;
    let totalPaidCents = 0;
    let lastOrderAt: number | undefined;
    let lastOrderId: string | undefined;

    for (const order of state.orders.values()) {
      if (order.deletedAt || order.customerId !== customer.id) continue;
      if (order.status === 'cancelado') continue;
      const totals = orderTotals(state, order);
      ordersCount += 1;
      totalSpentCents += totals.totalCents;
      totalPaidCents += totals.paidCents;
      if (lastOrderAt === undefined || order.createdAt > lastOrderAt) {
        lastOrderAt = order.createdAt;
        lastOrderId = order.id;
      }
    }

    out.push({
      customer,
      ordersCount,
      totalSpentCents,
      totalPaidCents,
      balanceCents: totalSpentCents - totalPaidCents,
      lastOrderAt,
      lastOrderId,
    });
  }
  return out.sort((a, b) => b.totalSpentCents - a.totalSpentCents);
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface DashboardData {
  toDeliverToday: { order: Order; customer?: Customer; balanceCents: number; overdue: boolean }[];
  toCollect: { order: Order; customer?: Customer; balanceCents: number; daysOverdue: number }[];
  toProduce: ProductionSuggestion[];
  productionThisWeek: ProductionOrderView[];
  lowStock: StockRow[];
  outOfStock: StockRow[];
  topProducts: ProductSummary[];
  monthRevenueCents: number;
  monthProfitCents: number;
  monthExpensesCents: number;
  pendingOrdersCount: number;
  openOrdersCount: number;
}

export function dashboard(state: AppState, now = Date.now()): DashboardData {
  const today = startOfDay(now);
  const weekEnd = startOfWeek(now) + 7 * MS_DAY;

  const toDeliverToday: DashboardData['toDeliverToday'] = [];
  const toCollect: DashboardData['toCollect'] = [];

  for (const order of state.orders.values()) {
    if (order.deletedAt) continue;
    if (order.status === 'cancelado' || order.status === 'entregado') continue;
    const totals = orderTotals(state, order);
    const customer = state.customers.get(order.customerId);

    if (order.dueDate !== undefined && startOfDay(order.dueDate) <= today) {
      toDeliverToday.push({
        order,
        customer,
        balanceCents: totals.balanceCents,
        overdue: startOfDay(order.dueDate) < today,
      });
    }
    if (totals.balanceCents > 0) {
      toCollect.push({
        order,
        customer,
        balanceCents: totals.balanceCents,
        daysOverdue: order.dueDate ? Math.floor((today - startOfDay(order.dueDate)) / MS_DAY) : 0,
      });
    }
  }

  toDeliverToday.sort((a, b) => (a.order.dueDate ?? 0) - (b.order.dueDate ?? 0));
  toCollect.sort((a, b) => b.daysOverdue - a.daysOverdue || b.balanceCents - a.balanceCents);

  const productionThisWeek = productionOrderViews(state, now).filter(
    (v) =>
      v.order.status !== 'completada' &&
      v.order.status !== 'cancelada' &&
      startOfDay(v.order.scheduledDate) < weekEnd,
  );

  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthStartTs = monthStart.getTime();

  let monthRevenueCents = 0;
  let monthCostCents = 0;
  let pendingOrdersCount = 0;
  let openOrdersCount = 0;

  for (const order of state.orders.values()) {
    if (order.deletedAt || order.status === 'cancelado') continue;
    if (order.status !== 'entregado') openOrdersCount += 1;
    if (order.status === 'pendiente') pendingOrdersCount += 1;
    if (order.createdAt < monthStartTs) continue;
    const totals = orderTotals(state, order);
    monthRevenueCents += totals.totalCents;
    monthCostCents += totals.costCents;
  }

  let monthExpensesCents = 0;
  for (const e of state.expenses.values()) {
    if (e.deletedAt) continue;
    if (e.date >= monthStartTs) monthExpensesCents += e.amountCents;
  }

  return {
    toDeliverToday: toDeliverToday.slice(0, 12),
    toCollect: toCollect.slice(0, 12),
    toProduce: productionSuggestions(state, 30, now).filter((s) => s.suggestQty > 0).slice(0, 12),
    productionThisWeek,
    lowStock: lowStockRows(state).slice(0, 12),
    outOfStock: outOfStockRows(state).slice(0, 12),
    topProducts: productSummaries(state).slice(0, 6),
    monthRevenueCents,
    monthProfitCents: monthRevenueCents - monthCostCents,
    monthExpensesCents,
    pendingOrdersCount,
    openOrdersCount,
  };
}

/* ------------------------------------------------------------------ */
/* Gastos                                                              */
/* ------------------------------------------------------------------ */

export interface ExpenseSummary {
  totalCents: number;
  byCategory: { category: string; amountCents: number; count: number }[];
  byMonth: { month: string; amountCents: number }[];
}

export function expenseSummary(state: AppState, from?: number, to?: number): ExpenseSummary {
  const byCategory = new Map<string, { amountCents: number; count: number }>();
  const byMonth = new Map<string, number>();
  let totalCents = 0;

  for (const e of state.expenses.values()) {
    if (e.deletedAt) continue;
    if (from !== undefined && e.date < from) continue;
    if (to !== undefined && e.date > to) continue;
    totalCents += e.amountCents;
    const cat = byCategory.get(e.category) ?? { amountCents: 0, count: 0 };
    cat.amountCents += e.amountCents;
    cat.count += 1;
    byCategory.set(e.category, cat);

    const d = new Date(e.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + e.amountCents);
  }

  return {
    totalCents,
    byCategory: [...byCategory.entries()]
      .map(([category, v]) => ({ category, ...v }))
      .sort((a, b) => b.amountCents - a.amountCents),
    byMonth: [...byMonth.entries()]
      .map(([month, amountCents]) => ({ month, amountCents }))
      .sort((a, b) => a.month.localeCompare(b.month)),
  };
}

/* ------------------------------------------------------------------ */
/* Reportes                                                            */
/* ------------------------------------------------------------------ */

export interface PeriodReport {
  from: number;
  to: number;
  ordersCount: number;
  unitsSold: number;
  revenueCents: number;
  costCents: number;
  profitCents: number;
  marginPercent: number;
  expensesCents: number;
  netProfitCents: number;
  unitsProduced: number;
}

export function periodReport(state: AppState, from: number, to: number): PeriodReport {
  let ordersCount = 0;
  let unitsSold = 0;
  let revenueCents = 0;
  let costCents = 0;
  let unitsProduced = 0;

  for (const order of state.orders.values()) {
    if (order.deletedAt || order.status === 'cancelado') continue;
    if (order.createdAt < from || order.createdAt > to) continue;
    const totals = orderTotals(state, order);
    ordersCount += 1;
    unitsSold += totals.units;
    revenueCents += totals.totalCents;
    costCents += totals.costCents;
  }

  for (const mv of state.stockMovements.values()) {
    if (mv.movementType === 'produccion' && mv.performedAt >= from && mv.performedAt <= to) {
      unitsProduced += mv.quantity;
    }
  }

  let expensesCents = 0;
  for (const e of state.expenses.values()) {
    if (e.deletedAt) continue;
    if (e.date >= from && e.date <= to) expensesCents += e.amountCents;
  }

  const profitCents = revenueCents - costCents;
  return {
    from,
    to,
    ordersCount,
    unitsSold,
    revenueCents,
    costCents,
    profitCents,
    marginPercent: revenueCents > 0 ? (profitCents / revenueCents) * 100 : 0,
    expensesCents,
    netProfitCents: profitCents - expensesCents,
    unitsProduced,
  };
}

/** Top productos vendidos por unidades, en un período. */
export function topProductsByUnits(
  state: AppState,
  from: number,
  to: number,
  limit = 10,
): { product?: Product; units: number; revenueCents: number }[] {
  const byProduct = new Map<string, { units: number; revenueCents: number }>();
  for (const order of state.orders.values()) {
    if (order.deletedAt || order.status === 'cancelado') continue;
    if (order.createdAt < from || order.createdAt > to) continue;
    for (const line of orderLines(state, order.id)) {
      const variant = state.variants.get(line.variantId);
      if (!variant) continue;
      const entry = byProduct.get(variant.productId) ?? { units: 0, revenueCents: 0 };
      entry.units += line.quantity;
      entry.revenueCents += line.quantity * line.unitPriceCents;
      byProduct.set(variant.productId, entry);
    }
  }
  return [...byProduct.entries()]
    .map(([productId, v]) => ({ product: state.products.get(productId), ...v }))
    .sort((a, b) => b.units - a.units)
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/* Movimientos                                                         */
/* ------------------------------------------------------------------ */

export interface MovementView {
  movementId: string;
  variantId: string;
  sku: string;
  productName: string;
  sizeCode: string;
  colorName: string;
  colorHex: string;
  collectionName: string;
  movementType: MovementType;
  quantity: number;
  unitCostCents: number;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  performedAt: number;
  createdAt: number;
}

export function movementViews(state: AppState): MovementView[] {
  const out: MovementView[] = [];
  for (const mv of state.stockMovements.values()) {
    const variant = state.variants.get(mv.variantId);
    const product = variant ? state.products.get(variant.productId) : undefined;
    const color = variant ? state.colors.get(variant.colorId) : undefined;
    const collection = product ? state.collections.get(product.collectionId) : undefined;
    out.push({
      movementId: mv.id,
      variantId: mv.variantId,
      sku: variant?.sku ?? '—',
      productName: product?.name ?? '—',
      sizeCode: variant?.sizeCode ?? '—',
      colorName: color?.name ?? '—',
      colorHex: color?.hex ?? '#888',
      collectionName: collection?.name ?? '—',
      movementType: mv.movementType,
      quantity: mv.quantity,
      unitCostCents: mv.unitCostCents,
      reason: mv.reason,
      referenceType: mv.referenceType,
      referenceId: mv.referenceId,
      performedAt: mv.performedAt,
      createdAt: mv.createdAt,
    });
  }
  return out.sort((a, b) => b.performedAt - a.performedAt);
}
