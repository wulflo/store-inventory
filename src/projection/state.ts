import type {
  Collection,
  Color,
  Customer,
  DeviceInfo,
  Expense,
  Order,
  OrderLine,
  Payment,
  ProductionLine,
  ProductionOrder,
  Product,
  StockAggregate,
  StockMovement,
  Variant,
} from '../core/types';

/**
 * Estado derivado. Es una proyección de los eventos: se puede tirar y
 * reconstruir en cualquier momento sin pérdida de información.
 */
export interface AppState {
  /* --- Entidades --- */
  collections: Map<string, Collection>;
  products: Map<string, Product>;
  colors: Map<string, Color>;
  variants: Map<string, Variant>;
  customers: Map<string, Customer>;
  orders: Map<string, Order>;
  orderLines: Map<string, OrderLine>;
  payments: Map<string, Payment>;
  productionOrders: Map<string, ProductionOrder>;
  productionLines: Map<string, ProductionLine>;
  stockMovements: Map<string, StockMovement>;
  expenses: Map<string, Expense>;
  devices: Map<string, DeviceInfo>;
  settings: Map<string, string>;

  /* --- Índices --- */
  variantsByProduct: Map<string, Set<string>>;
  variantsByColor: Map<string, Set<string>>;
  orderLinesByOrder: Map<string, Set<string>>;
  paymentsByOrder: Map<string, Set<string>>;
  productionLinesByOrder: Map<string, Set<string>>;
  productsByCollection: Map<string, Set<string>>;

  /* --- Agregados de stock --- */
  stock: Map<string, StockAggregate>;
  /** Contribución reservada por línea, para ajustar de forma incremental. */
  reservedContribution: Map<string, number>;

  /* --- Resolución de conflictos (LWW por campo) --- */
  /** `entityId:field` -> HLC del último cambio aceptado. */
  fieldHlc: Map<string, number>;
  /** `entityId` -> HLC del último cambio de esa entidad. */
  entityHlc: Map<string, number>;

  /* --- Idempotencia --- */
  /** IDs de eventos ya aplicados: evita reprocesar (append-only, pero re-leído). */
  appliedEventIds: Set<string>;

  /* --- Metadatos --- */
  deviceId: string;
  lastHlc: number;
  eventCount: number;
}

export function createEmptyState(deviceId = 'local'): AppState {
  return {
    collections: new Map(),
    products: new Map(),
    colors: new Map(),
    variants: new Map(),
    customers: new Map(),
    orders: new Map(),
    orderLines: new Map(),
    payments: new Map(),
    productionOrders: new Map(),
    productionLines: new Map(),
    stockMovements: new Map(),
    expenses: new Map(),
    devices: new Map(),
    settings: new Map(),

    variantsByProduct: new Map(),
    variantsByColor: new Map(),
    orderLinesByOrder: new Map(),
    paymentsByOrder: new Map(),
    productionLinesByOrder: new Map(),
    productsByCollection: new Map(),

    stock: new Map(),
    reservedContribution: new Map(),

    fieldHlc: new Map(),
    entityHlc: new Map(),

    appliedEventIds: new Set(),

    deviceId,
    lastHlc: 0,
    eventCount: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Serialización de snapshots                                          */
/* ------------------------------------------------------------------ */

export interface StateSnapshot {
  format: 'inventario-tienda/state';
  version: number;
  createdAt: number;
  deviceId: string;
  lastHlc: number;
  eventCount: number;
  data: {
    collections: Collection[];
    products: Product[];
    colors: Color[];
    variants: Variant[];
    customers: Customer[];
    orders: Order[];
    orderLines: OrderLine[];
    payments: Payment[];
    productionOrders: ProductionOrder[];
    productionLines: ProductionLine[];
    stockMovements: StockMovement[];
    expenses: Expense[];
    devices: DeviceInfo[];
    settings: [string, string][];
    fieldHlc: [string, number][];
    entityHlc: [string, number][];
    stock: [string, StockAggregate][];
  };
}

export function snapshotState(state: AppState): StateSnapshot {
  return {
    format: 'inventario-tienda/state',
    version: 1,
    createdAt: Date.now(),
    deviceId: state.deviceId,
    lastHlc: state.lastHlc,
    eventCount: state.eventCount,
    data: {
      collections: [...state.collections.values()],
      products: [...state.products.values()],
      colors: [...state.colors.values()],
      variants: [...state.variants.values()],
      customers: [...state.customers.values()],
      orders: [...state.orders.values()],
      orderLines: [...state.orderLines.values()],
      payments: [...state.payments.values()],
      productionOrders: [...state.productionOrders.values()],
      productionLines: [...state.productionLines.values()],
      stockMovements: [...state.stockMovements.values()],
      expenses: [...state.expenses.values()],
      devices: [...state.devices.values()],
      settings: [...state.settings.entries()],
      fieldHlc: [...state.fieldHlc.entries()],
      entityHlc: [...state.entityHlc.entries()],
      stock: [...state.stock.entries()],
    },
  };
}

export function restoreState(snapshot: StateSnapshot): AppState {
  const s = createEmptyState(snapshot.deviceId);
  s.lastHlc = snapshot.lastHlc;
  s.eventCount = snapshot.eventCount;

  const put = <T extends { id: string }>(m: Map<string, T>, items: T[]) => {
    for (const it of items) m.set(it.id, it);
  };

  put(s.collections, snapshot.data.collections);
  put(s.products, snapshot.data.products);
  put(s.colors, snapshot.data.colors);
  put(s.variants, snapshot.data.variants);
  put(s.customers, snapshot.data.customers);
  put(s.orders, snapshot.data.orders);
  put(s.orderLines, snapshot.data.orderLines);
  put(s.payments, snapshot.data.payments);
  put(s.productionOrders, snapshot.data.productionOrders);
  put(s.productionLines, snapshot.data.productionLines);
  put(s.stockMovements, snapshot.data.stockMovements);
  put(s.expenses, snapshot.data.expenses);
  put(s.devices, snapshot.data.devices);
  for (const [key, value] of snapshot.data.settings) s.settings.set(key, value);
  for (const [key, value] of snapshot.data.stock) s.stock.set(key, value);
  s.fieldHlc = new Map(snapshot.data.fieldHlc);
  s.entityHlc = new Map(snapshot.data.entityHlc);

  reindexAll(s);
  recomputeReservations(s);
  return s;
}

/** Reconstruye todos los índices secundarios. */
export function reindexAll(s: AppState): void {
  s.variantsByProduct = new Map();
  s.variantsByColor = new Map();
  s.orderLinesByOrder = new Map();
  s.paymentsByOrder = new Map();
  s.productionLinesByOrder = new Map();
  s.productsByCollection = new Map();

  for (const v of s.variants.values()) {
    if (v.deletedAt) continue;
    push(s.variantsByProduct, v.productId, v.id);
    push(s.variantsByColor, v.colorId, v.id);
  }
  for (const p of s.products.values()) {
    if (p.deletedAt) continue;
    push(s.productsByCollection, p.collectionId, p.id);
  }
  for (const l of s.orderLines.values()) {
    if (l.deletedAt) continue;
    push(s.orderLinesByOrder, l.orderId, l.id);
  }
  for (const p of s.payments.values()) {
    if (p.deletedAt) continue;
    push(s.paymentsByOrder, p.orderId, p.id);
  }
  for (const l of s.productionLines.values()) {
    if (l.deletedAt) continue;
    push(s.productionLinesByOrder, l.productionOrderId, l.id);
  }
}

/** Recalcula todas las reservas desde cero (usado al restaurar snapshot). */
export function recomputeReservations(s: AppState): void {
  s.reservedContribution = new Map();
  const totals = new Map<string, number>();
  for (const line of s.orderLines.values()) {
    if (line.deletedAt) continue;
    const order = s.orders.get(line.orderId);
    const contribution = lineReservedContribution(line, order);
    s.reservedContribution.set(line.id, contribution);
    if (contribution > 0) {
      totals.set(line.variantId, (totals.get(line.variantId) ?? 0) + contribution);
    }
  }
  for (const [variantId, reserved] of totals) {
    const agg = ensureAggregate(s, variantId);
    agg.reservedQty = reserved;
    agg.availableQty = agg.totalQty - reserved;
  }
}

/** Unidades comprometidas de una línea, dado el estado de su pedido. */
export function lineReservedContribution(
  line: OrderLine,
  order: Order | undefined,
): number {
  if (!order || order.deletedAt) return 0;
  if (order.status === 'cancelado') return 0;
  return Math.max(0, line.quantity - line.deliveredQty);
}

export function ensureAggregate(s: AppState, variantId: string): StockAggregate {
  let agg = s.stock.get(variantId);
  if (!agg) {
    const variant = s.variants.get(variantId);
    agg = {
      variantId,
      totalQty: 0,
      reservedQty: 0,
      availableQty: 0,
      lastMovementAt: 0,
      minStock: variant?.minStock ?? 0,
      lowStockAlert: false,
    };
    s.stock.set(variantId, agg);
  }
  return agg;
}

export function push(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}
