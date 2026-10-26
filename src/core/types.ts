/**
 * Tipos núcleo del dominio.
 *
 * Convenciones:
 *  - Todo ID es UUID v7 (string).
 *  - Todo dinero es un entero en CENTAVOS ARS (número entero, nunca float para storing).
 *  - Todo timestamp es ms epoch UTC (número entero).
 *  - Un "DomainEvent" es inmutable: nunca se edita, solo se agrega.
 */

export const SCHEMA_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Eventos                                                              */
/* ------------------------------------------------------------------ */

export interface EventMetadata {
  /** Hybrid Logical Clock: monotónico, comparable entre dispositivos. */
  hlc: number;
  /** UUIDv7 del dispositivo que originó el evento. */
  deviceId: string;
  /** ms epoch UTC de cuando se registró. */
  timestamp: number;
  /** Versión del esquema del payload. */
  version: number;
}

export interface DomainEvent<P = any> {
  /** UUIDv7 del evento. Clave de idempotencia y de dedup en el merge. */
  id: string;
  /** `Dominio.Acción` — ej: 'Order.Created' */
  type: string;
  payload: P;
  metadata: EventMetadata;
}

/** Dominios = 1 archivo .jsonl cada uno. */
export const DOMAINS = [
  'collections',
  'products',
  'colors',
  'variants',
  'customers',
  'orders',
  'order_lines',
  'payments',
  'production_orders',
  'production_lines',
  'stock_movements',
  'expenses',
  'settings',
  'device_info',
] as const;

export type Domain = (typeof DOMAINS)[number];

/* ------------------------------------------------------------------ */
/* Entidades (estado derivado, NO fuente de verdad)                    */
/* ------------------------------------------------------------------ */

export type Season = 'invierno' | 'verano' | 'otono' | 'primavera';
export type ProductType = 'remera' | 'buzo';
export type OrderStatus = 'pendiente' | 'en_produccion' | 'listo' | 'entregado' | 'cancelado';
export type PaymentStatus = 'sin_pagar' | 'sena' | 'parcial' | 'pagado';
export type ProductionStatus = 'planificada' | 'en_proceso' | 'completada' | 'cancelada';
export type MovementType =
  | 'produccion'
  | 'venta'
  | 'ajuste_pos'
  | 'ajuste_neg'
  | 'devolucion'
  | 'inicial';
export type PaymentMethod = 'efectivo' | 'transferencia' | 'tarjeta' | 'mercadopago' | 'otro';
export type ExpenseCategory =
  | 'insumos'
  | 'envio'
  | 'publicidad'
  | 'alquiler'
  | 'servicios'
  | 'otros';

export interface Collection {
  id: string;
  name: string;
  slug: string;
  season: Season;
  year: number;
  startDate?: number;
  endDate?: number;
  isActive: boolean;
  sortOrder: number;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Product {
  id: string;
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
  isActive: boolean;
  sortOrder: number;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Color {
  id: string;
  name: string;
  hex: string;
  isActive: boolean;
  sortOrder: number;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type SizeCode = 'XS' | 'S' | 'M' | 'L' | 'XL' | 'XXL' | '3XL';

export interface Variant {
  id: string;
  productId: string;
  sizeCode: SizeCode;
  colorId: string;
  sku: string;
  barcode?: string;
  minStock: number;
  costCents: number;
  priceCents: number;
  isActive: boolean;
  sortOrder: number;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  taxId?: string;
  isActive: boolean;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Order {
  id: string;
  customerId: string;
  collectionId?: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  dueDate?: number;
  notes?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface OrderLine {
  id: string;
  orderId: string;
  variantId: string;
  quantity: number;
  unitPriceCents: number;
  costCents: number;
  producedQty: number;
  deliveredQty: number;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Payment {
  id: string;
  orderId: string;
  amountCents: number;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProductionOrder {
  id: string;
  collectionId?: string;
  scheduledDate: number;
  status: ProductionStatus;
  notes?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProductionLine {
  id: string;
  productionOrderId: string;
  variantId: string;
  plannedQty: number;
  completedQty: number;
  notes?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface StockMovement {
  id: string;
  variantId: string;
  movementType: MovementType;
  /** Positivo = entrada, negativo = salida. */
  quantity: number;
  unitCostCents: number;
  referenceType?: 'order' | 'production_order' | 'manual';
  referenceId?: string;
  reason?: string;
  performedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface Expense {
  id: string;
  date: number;
  category: ExpenseCategory;
  description: string;
  amountCents: number;
  paymentMethod: PaymentMethod;
  reference?: string;
  collectionId?: string;
  deletedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* Agregados de stock (derivados)                                      */
/* ------------------------------------------------------------------ */

export interface StockAggregate {
  variantId: string;
  /** Suma de todos los movimientos. */
  totalQty: number;
  /** Unidades comprometidas por pedidos no cancelados. */
  reservedQty: number;
  /** totalQty - reservedQty */
  availableQty: number;
  lastMovementAt: number;
  minStock: number;
  lowStockAlert: boolean;
}

/* ------------------------------------------------------------------ */
/* Payloads de eventos                                                 */
/* ------------------------------------------------------------------ */

export interface CollectionCreatedPayload {
  name: string;
  slug: string;
  season: Season;
  year: number;
  startDate?: number;
  endDate?: number;
  sortOrder: number;
}
export interface CollectionUpdatedPayload {
  collectionId: string;
  name?: string;
  slug?: string;
  season?: Season;
  year?: number;
  startDate?: number;
  endDate?: number;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ProductCreatedPayload {
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
  sortOrder: number;
}
export interface ProductUpdatedPayload {
  productId: string;
  collectionId?: string;
  sku?: string;
  name?: string;
  type?: ProductType;
  description?: string;
  basePriceCents?: number;
  costFabricCents?: number;
  costPrintCents?: number;
  costLaborCents?: number;
  costOtherCents?: number;
  isActive?: boolean;
  sortOrder?: number;
}

export interface ColorCreatedPayload {
  name: string;
  hex: string;
  sortOrder: number;
}
export interface ColorUpdatedPayload {
  colorId: string;
  name?: string;
  hex?: string;
  isActive?: boolean;
  sortOrder?: number;
}

export interface VariantCreatedPayload {
  productId: string;
  sizeCode: SizeCode;
  colorId: string;
  sku: string;
  barcode?: string;
  minStock: number;
  costCents: number;
  priceCents: number;
  sortOrder: number;
}
export interface VariantUpdatedPayload {
  variantId: string;
  productId?: string;
  sizeCode?: SizeCode;
  colorId?: string;
  sku?: string;
  barcode?: string;
  minStock?: number;
  costCents?: number;
  priceCents?: number;
  isActive?: boolean;
  sortOrder?: number;
}

export interface CustomerCreatedPayload {
  name: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  taxId?: string;
}
export interface CustomerUpdatedPayload {
  customerId: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
  taxId?: string;
  isActive?: boolean;
}

export interface OrderCreatedPayload {
  customerId: string;
  collectionId?: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  dueDate?: number;
  notes?: string;
}
export interface OrderUpdatedPayload {
  orderId: string;
  customerId?: string;
  collectionId?: string;
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  dueDate?: number;
  notes?: string;
}

export interface OrderLineAddedPayload {
  orderId: string;
  variantId: string;
  quantity: number;
  unitPriceCents: number;
  costCents: number;
}
export interface OrderLineUpdatedPayload {
  lineId: string;
  quantity?: number;
  unitPriceCents?: number;
  costCents?: number;
}
export interface OrderLineProducedPayload {
  lineId: string;
  producedQty: number;
}
export interface OrderLineDeliveredPayload {
  lineId: string;
  deliveredQty: number;
}

export interface PaymentAddedPayload {
  orderId: string;
  amountCents: number;
  method: PaymentMethod;
  reference?: string;
  notes?: string;
}

export interface ProductionOrderCreatedPayload {
  collectionId?: string;
  scheduledDate: number;
  status: ProductionStatus;
  notes?: string;
}
export interface ProductionOrderUpdatedPayload {
  productionOrderId: string;
  collectionId?: string;
  scheduledDate?: number;
  status?: ProductionStatus;
  notes?: string;
}

export interface ProductionLineAddedPayload {
  productionOrderId: string;
  variantId: string;
  plannedQty: number;
  notes?: string;
}
export interface ProductionLineUpdatedPayload {
  lineId: string;
  plannedQty?: number;
  completedQty?: number;
  notes?: string;
}

export interface StockMovementPayload {
  variantId: string;
  movementType: MovementType;
  quantity: number;
  unitCostCents: number;
  referenceType?: 'order' | 'production_order' | 'manual';
  referenceId?: string;
  reason?: string;
  performedAt: number;
}

export interface ExpenseCreatedPayload {
  date: number;
  category: ExpenseCategory;
  description: string;
  amountCents: number;
  paymentMethod: PaymentMethod;
  reference?: string;
  collectionId?: string;
}
export interface ExpenseUpdatedPayload {
  expenseId: string;
  date?: number;
  category?: ExpenseCategory;
  description?: string;
  amountCents?: number;
  paymentMethod?: PaymentMethod;
  reference?: string;
  collectionId?: string;
}

export interface SettingSetPayload {
  key: string;
  value: string;
}

export interface DeviceRegisteredPayload {
  deviceId: string;
  name: string;
}
