import type {
  Collection,
  Color,
  Customer,
  DeviceInfo,
  DomainEvent,
  EventMetadata,
  Expense,
  Order,
  OrderLine,
  Payment,
  ProductionLine,
  ProductionOrder,
  Product,
  StockMovement,
  Variant,
} from '../core/types';
import {
  type AppState,
  ensureAggregate,
  lineReservedContribution,
  push,
} from './state';

/**
 * Proyector: aplica eventos sobre el estado.
 *
 * Reglas de resolución de conflictos:
 *  - `*.Created`: si la entidad ya existe, el evento se ignora (dedup por id).
 *  - `*.Updated`: LWW **por campo** usando HLC. Cada campo guarda el HLC del
 *    último cambio aceptado; un cambio con HLC menor no pisa.
 *  - `*.Deleted`: soft delete. Si luego llega un `*.Updated` con HLC mayor que
 *    el del borrado, la entidad resucita (undelete).
 *  - `Stock.Movement`: append-only. Siempre se suma al total, nunca se pisa.
 */
export class Projector {
  /** Metadata del evento en curso, para sellar createdAt/updatedAt. */
  private currentMeta: EventMetadata = {
    hlc: 0,
    deviceId: '',
    timestamp: 0,
    version: 1,
  };

  constructor(public readonly state: AppState) {}

  apply(event: DomainEvent): void {
    if (!event || typeof event.id !== 'string') return;
    // Idempotencia: un evento nunca se aplica dos veces.
    if (this.state.appliedEventIds.has(event.id)) return;

    const { type, payload, metadata } = event;
    // Un HLC inválido (NaN/Infinity/ausente) envenenaría `lastHlc` y todos los
    // LWW posteriores. Descartamos el evento antes de marcarlo como aplicado.
    const hlc = Number(metadata?.hlc);
    if (!Number.isFinite(hlc) || hlc < 0) return;
    if (!payload || typeof payload !== 'object') return;
    // Un evento cifrado que no pudimos descifrar llega con
    // `{ _encrypted: true, _error, ... }`. No es un payload de dominio: si lo
    // aplicáramos, `quantity`/`variantId` serían undefined y el stock pasaría
    // a NaN. Lo descartamos sin marcarlo como aplicado.
    if ((payload as { _encrypted?: unknown })._encrypted === true) return;

    this.state.appliedEventIds.add(event.id);
    this.currentMeta = metadata;

    switch (type) {
      /* ---------------- Catálogo ---------------- */
      case 'Collection.Created':
        this.collectionCreated(payload as any);
        break;
      case 'Collection.Updated':
        this.collectionUpdated(payload as any, hlc);
        break;
      case 'Collection.Deleted':
        this.softDelete(this.state.collections, payload.collectionId, hlc);
        break;

      case 'Product.Created':
        this.productCreated(payload as any);
        break;
      case 'Product.Updated':
        this.productUpdated(payload as any, hlc);
        break;
      case 'Product.Deleted':
        this.softDelete(this.state.products, payload.productId, hlc);
        break;

      case 'Color.Created':
        this.colorCreated(payload as any);
        break;
      case 'Color.Updated':
        this.colorUpdated(payload as any, hlc);
        break;
      case 'Color.Deleted':
        this.softDelete(this.state.colors, payload.colorId, hlc);
        break;

      case 'Variant.Created':
        this.variantCreated(payload as any);
        break;
      case 'Variant.Updated':
        this.variantUpdated(payload as any, hlc);
        break;
      case 'Variant.Deleted':
        this.variantUpdated({ variantId: payload.variantId, isActive: false }, hlc);
        this.softDelete(this.state.variants, payload.variantId, hlc);
        break;

      /* ---------------- Clientes ---------------- */
      case 'Customer.Created':
        this.customerCreated(payload as any);
        break;
      case 'Customer.Updated':
        this.customerUpdated(payload as any, hlc);
        break;
      case 'Customer.Deleted':
        this.softDelete(this.state.customers, payload.customerId, hlc);
        break;

      /* ---------------- Pedidos ---------------- */
      case 'Order.Created':
        this.orderCreated(payload as any);
        break;
      case 'Order.Updated':
        this.orderUpdated(payload as any, hlc);
        break;
      case 'Order.Deleted':
        this.orderDeleted(payload.orderId, hlc);
        break;

      case 'OrderLine.Added':
        this.orderLineAdded(payload as any);
        break;
      case 'OrderLine.Updated':
        this.orderLineUpdated(payload as any, hlc);
        break;
      case 'OrderLine.Removed':
        this.orderLineRemoved(payload.lineId, hlc);
        break;
      case 'OrderLine.Produced':
        this.orderLineProduced(payload.lineId, payload.producedQty, hlc);
        break;
      case 'OrderLine.Delivered':
        this.orderLineDelivered(payload.lineId, payload.deliveredQty, hlc);
        break;

      case 'Payment.Added':
        this.paymentAdded(payload as any);
        break;
      case 'Payment.Removed':
        this.softDelete(this.state.payments, payload.paymentId, hlc);
        break;

      /* ---------------- Producción ---------------- */
      case 'ProductionOrder.Created':
        this.productionOrderCreated(payload as any);
        break;
      case 'ProductionOrder.Updated':
        this.productionOrderUpdated(payload as any, hlc);
        break;
      case 'ProductionOrder.Deleted':
        this.softDelete(this.state.productionOrders, payload.productionOrderId, hlc);
        break;

      case 'ProductionLine.Added':
        this.productionLineAdded(payload as any);
        break;
      case 'ProductionLine.Updated':
        this.productionLineUpdated(payload as any, hlc);
        break;
      case 'ProductionLine.Removed':
        this.softDelete(this.state.productionLines, payload.lineId, hlc);
        break;
      case 'ProductionLine.Completed':
        this.productionLineCompleted(payload.lineId, payload.completedQty, hlc);
        break;

      /* ---------------- Stock ---------------- */
      case 'Stock.Movement':
        this.stockMovement(payload as any, event.id);
        break;

      /* ---------------- Gastos ---------------- */
      case 'Expense.Created':
        this.expenseCreated(payload as any);
        break;
      case 'Expense.Updated':
        this.expenseUpdated(payload as any, hlc);
        break;
      case 'Expense.Deleted':
        this.softDelete(this.state.expenses, payload.expenseId, hlc);
        break;

      /* ---------------- Settings / Device ---------------- */
      case 'Setting.Set': {
        const key = payload.key;
        const prev = this.state.fieldHlc.get(`setting:${key}`);
        if (prev === undefined || hlc > prev) {
          this.state.fieldHlc.set(`setting:${key}`, hlc);
          this.state.settings.set(key, payload.value);
        }
        break;
      }
      case 'Setting.Deleted': {
        const key = payload.key;
        const prev = this.state.fieldHlc.get(`setting:${key}`);
        if (prev === undefined || hlc > prev) {
          this.state.fieldHlc.set(`setting:${key}`, hlc);
          this.state.settings.delete(key);
        }
        break;
      }
      case 'Device.Registered':
        this.deviceRegistered(payload as any);
        break;

      default:
        // Evento desconocido (versión futura): se ignora sin romper la proyección.
        break;
    }

    this.state.lastHlc = Math.max(this.state.lastHlc, hlc);
    this.state.eventCount += 1;
  }

  applyAll(events: DomainEvent[]): void {
    for (const e of events) this.apply(e);
  }

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  /** Aplica campos con LWW por campo. Devuelve true si cambió algo. */
  private mergeFields<T extends object>(
    entity: T,
    id: string,
    fields: Record<string, unknown>,
    hlc: number,
  ): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      const hlcKey = `${id}:${key}`;
      const prev = this.state.fieldHlc.get(hlcKey);
      if (prev !== undefined && prev >= hlc) continue;
      this.state.fieldHlc.set(hlcKey, hlc);
      (entity as Record<string, unknown>)[key] = value;
      changed = true;
    }
    if (changed) {
      this.state.entityHlc.set(id, hlc);
      if ('updatedAt' in entity) {
        (entity as Record<string, unknown>).updatedAt = this.currentMeta.timestamp;
      }
    }
    return changed;
  }

  /** Soft delete con LWW. */
  private softDelete<T extends { id: string; deletedAt?: number }>(
    map: Map<string, T>,
    id: string,
    hlc: number,
  ): void {
    const entity = map.get(id);
    if (!entity) return;
    const hlcKey = `${id}:deletedAt`;
    const prev = this.state.fieldHlc.get(hlcKey);
    if (prev !== undefined && prev >= hlc) return;
    this.state.fieldHlc.set(hlcKey, hlc);
    entity.deletedAt = hlc;
    this.state.entityHlc.set(id, hlc);
    if ('isActive' in entity) {
      const activeKey = `${id}:isActive`;
      const activePrev = this.state.fieldHlc.get(activeKey);
      if (activePrev === undefined || activePrev < hlc) {
        this.state.fieldHlc.set(activeKey, hlc);
        (entity as Record<string, unknown>).isActive = false;
      }
    }
  }

  /** Revive una entidad si un `Updated` posterior tiene HLC mayor al borrado. */
  private undeleteIfNewer<T extends { id: string; deletedAt?: number }>(
    map: Map<string, T>,
    id: string,
    hlc: number,
  ): void {
    const entity = map.get(id);
    if (!entity || !entity.deletedAt) return;
    if (entity.deletedAt < hlc) {
      entity.deletedAt = undefined;
      const activeKey = `${id}:isActive`;
      const activePrev = this.state.fieldHlc.get(activeKey);
      if (activePrev === undefined || activePrev < hlc) {
        this.state.fieldHlc.set(activeKey, hlc);
        (entity as Record<string, unknown>).isActive = true;
      }
    }
  }

  /* ---------------- Catálogo ---------------- */

  private collectionCreated(p: any): void {
    if (this.state.collections.has(p.id)) return;
    const c: Collection = {
      id: p.id,
      name: p.name,
      slug: p.slug,
      season: p.season,
      year: p.year,
      startDate: p.startDate,
      endDate: p.endDate,
      isActive: p.isActive !== false,
      sortOrder: p.sortOrder ?? 0,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.collections.set(c.id, c);
  }

  private collectionUpdated(p: any, hlc: number): void {
    const c = this.state.collections.get(p.collectionId);
    if (!c) return;
    this.undeleteIfNewer(this.state.collections, p.collectionId, hlc);
    this.mergeFields(c, p.collectionId, p, hlc);
  }

  private productCreated(p: any): void {
    if (this.state.products.has(p.id)) return;
    const prod: Product = {
      id: p.id,
      collectionId: p.collectionId,
      sku: p.sku,
      name: p.name,
      type: p.type,
      description: p.description,
      basePriceCents: p.basePriceCents,
      costFabricCents: p.costFabricCents,
      costPrintCents: p.costPrintCents,
      costLaborCents: p.costLaborCents,
      costOtherCents: p.costOtherCents,
      isActive: p.isActive !== false,
      sortOrder: p.sortOrder ?? 0,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.products.set(prod.id, prod);
    push(this.state.productsByCollection, prod.collectionId, prod.id);
  }

  private productUpdated(p: any, hlc: number): void {
    const prod = this.state.products.get(p.productId);
    if (!prod) return;
    this.undeleteIfNewer(this.state.products, p.productId, hlc);
    const oldCollection = prod.collectionId;
    this.mergeFields(prod, p.productId, p, hlc);
    if (prod.collectionId !== oldCollection) {
      this.state.productsByCollection.get(oldCollection)?.delete(prod.id);
      push(this.state.productsByCollection, prod.collectionId, prod.id);
    }
  }

  private colorCreated(p: any): void {
    if (this.state.colors.has(p.id)) return;
    const c: Color = {
      id: p.id,
      name: p.name,
      hex: p.hex,
      isActive: p.isActive !== false,
      sortOrder: p.sortOrder ?? 0,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.colors.set(c.id, c);
  }

  private colorUpdated(p: any, hlc: number): void {
    const c = this.state.colors.get(p.colorId);
    if (!c) return;
    this.undeleteIfNewer(this.state.colors, p.colorId, hlc);
    this.mergeFields(c, p.colorId, p, hlc);
  }

  private variantCreated(p: any): void {
    if (this.state.variants.has(p.id)) return;
    const v: Variant = {
      id: p.id,
      productId: p.productId,
      sizeCode: p.sizeCode,
      colorId: p.colorId,
      sku: p.sku,
      barcode: p.barcode,
      minStock: p.minStock ?? 0,
      costCents: p.costCents ?? 0,
      priceCents: p.priceCents ?? 0,
      isActive: p.isActive !== false,
      sortOrder: p.sortOrder ?? 0,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.variants.set(v.id, v);
    push(this.state.variantsByProduct, v.productId, v.id);
    push(this.state.variantsByColor, v.colorId, v.id);
    ensureAggregate(this.state, v.id).minStock = v.minStock;
  }

  private variantUpdated(p: any, hlc: number): void {
    const v = this.state.variants.get(p.variantId);
    if (!v) return;
    this.undeleteIfNewer(this.state.variants, p.variantId, hlc);
    const oldProduct = v.productId;
    const oldColor = v.colorId;
    this.mergeFields(v, p.variantId, p, hlc);
    if (v.productId !== oldProduct) {
      this.state.variantsByProduct.get(oldProduct)?.delete(v.id);
      push(this.state.variantsByProduct, v.productId, v.id);
    }
    if (v.colorId !== oldColor) {
      this.state.variantsByColor.get(oldColor)?.delete(v.id);
      push(this.state.variantsByColor, v.colorId, v.id);
    }
    const agg = ensureAggregate(this.state, v.id);
    agg.minStock = v.minStock;
    agg.lowStockAlert = agg.availableQty <= v.minStock;
  }

  /* ---------------- Clientes ---------------- */

  private customerCreated(p: any): void {
    if (this.state.customers.has(p.id)) return;
    const c: Customer = {
      id: p.id,
      name: p.name,
      phone: p.phone,
      email: p.email,
      address: p.address,
      notes: p.notes,
      taxId: p.taxId,
      isActive: p.isActive !== false,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.customers.set(c.id, c);
  }

  private customerUpdated(p: any, hlc: number): void {
    const c = this.state.customers.get(p.customerId);
    if (!c) return;
    this.undeleteIfNewer(this.state.customers, p.customerId, hlc);
    this.mergeFields(c, p.customerId, p, hlc);
  }

  /* ---------------- Pedidos ---------------- */

  private orderCreated(p: any): void {
    if (this.state.orders.has(p.id)) return;
    const o: Order = {
      id: p.id,
      customerId: p.customerId,
      collectionId: p.collectionId,
      status: p.status ?? 'pendiente',
      paymentStatus: p.paymentStatus ?? 'sin_pagar',
      dueDate: p.dueDate,
      notes: p.notes,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.orders.set(o.id, o);
  }

  private orderUpdated(p: any, hlc: number): void {
    const o = this.state.orders.get(p.orderId);
    if (!o) return;
    this.undeleteIfNewer(this.state.orders, p.orderId, hlc);
    const statusChanged = p.status !== undefined && p.status !== o.status;
    this.mergeFields(o, p.orderId, p, hlc);
    if (statusChanged) {
      // El estado del pedido cambia la reserva de todas sus líneas.
      this.refreshOrderReservation(o.id);
    }
  }

  private orderDeleted(orderId: string, hlc: number): void {
    const o = this.state.orders.get(orderId);
    if (!o) return;
    this.softDelete(this.state.orders, orderId, hlc);
    this.refreshOrderReservation(orderId);
  }

  private orderLineAdded(p: any): void {
    if (this.state.orderLines.has(p.id)) return;
    const l: OrderLine = {
      id: p.id,
      orderId: p.orderId,
      variantId: p.variantId,
      quantity: p.quantity,
      unitPriceCents: p.unitPriceCents,
      costCents: p.costCents,
      producedQty: 0,
      deliveredQty: 0,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.orderLines.set(l.id, l);
    push(this.state.orderLinesByOrder, l.orderId, l.id);
    this.updateLineReservation(l.id);
  }

  private orderLineUpdated(p: any, hlc: number): void {
    const l = this.state.orderLines.get(p.lineId);
    if (!l) return;
    this.mergeFields(l, p.lineId, p, hlc);
    this.updateLineReservation(l.id);
  }

  private orderLineRemoved(lineId: string, hlc: number): void {
    const l = this.state.orderLines.get(lineId);
    if (!l) return;
    this.softDelete(this.state.orderLines, lineId, hlc);
    this.state.orderLinesByOrder.get(l.orderId)?.delete(lineId);
    this.updateLineReservation(lineId);
  }

  private orderLineProduced(lineId: string, producedQty: number, hlc: number): void {
    const l = this.state.orderLines.get(lineId);
    if (!l) return;
    this.mergeFields(l, lineId, { producedQty: l.producedQty + producedQty }, hlc);
  }

  private orderLineDelivered(lineId: string, deliveredQty: number, hlc: number): void {
    const l = this.state.orderLines.get(lineId);
    if (!l) return;
    this.mergeFields(l, lineId, { deliveredQty: l.deliveredQty + deliveredQty }, hlc);
    this.updateLineReservation(lineId);
  }

  /* ---------------- Pagos ---------------- */

  private paymentAdded(p: any): void {
    if (this.state.payments.has(p.id)) return;
    const pay: Payment = {
      id: p.id,
      orderId: p.orderId,
      amountCents: p.amountCents,
      method: p.method,
      reference: p.reference,
      notes: p.notes,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.payments.set(pay.id, pay);
    push(this.state.paymentsByOrder, pay.orderId, pay.id);
  }

  /* ---------------- Producción ---------------- */

  private productionOrderCreated(p: any): void {
    if (this.state.productionOrders.has(p.id)) return;
    const po: ProductionOrder = {
      id: p.id,
      collectionId: p.collectionId,
      scheduledDate: p.scheduledDate,
      status: p.status ?? 'planificada',
      notes: p.notes,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.productionOrders.set(po.id, po);
  }

  private productionOrderUpdated(p: any, hlc: number): void {
    const po = this.state.productionOrders.get(p.productionOrderId);
    if (!po) return;
    this.undeleteIfNewer(this.state.productionOrders, p.productionOrderId, hlc);
    this.mergeFields(po, p.productionOrderId, p, hlc);
  }

  private productionLineAdded(p: any): void {
    if (this.state.productionLines.has(p.id)) return;
    const l: ProductionLine = {
      id: p.id,
      productionOrderId: p.productionOrderId,
      variantId: p.variantId,
      plannedQty: p.plannedQty,
      completedQty: 0,
      notes: p.notes,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.productionLines.set(l.id, l);
    push(this.state.productionLinesByOrder, l.productionOrderId, l.id);
  }

  private productionLineUpdated(p: any, hlc: number): void {
    const l = this.state.productionLines.get(p.lineId);
    if (!l) return;
    this.mergeFields(l, p.lineId, p, hlc);
  }

  private productionLineCompleted(lineId: string, completedQty: number, hlc: number): void {
    const l = this.state.productionLines.get(lineId);
    if (!l) return;
    this.mergeFields(l, lineId, { completedQty: l.completedQty + completedQty }, hlc);
  }

  /* ---------------- Stock ---------------- */

  private stockMovement(p: any, eventId: string): void {
    if (this.state.stockMovements.has(eventId)) return;
    const m: StockMovement = {
      id: eventId,
      variantId: p.variantId,
      movementType: p.movementType,
      quantity: p.quantity,
      unitCostCents: p.unitCostCents ?? 0,
      referenceType: p.referenceType,
      referenceId: p.referenceId,
      reason: p.reason,
      performedAt: p.performedAt,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.stockMovements.set(m.id, m);

    const agg = ensureAggregate(this.state, m.variantId);
    agg.totalQty += m.quantity;
    agg.availableQty = agg.totalQty - agg.reservedQty;
    agg.lastMovementAt = Math.max(agg.lastMovementAt, m.performedAt);
    const variant = this.state.variants.get(m.variantId);
    agg.minStock = variant?.minStock ?? agg.minStock;
    agg.lowStockAlert = agg.availableQty <= agg.minStock;
  }

  /* ---------------- Gastos ---------------- */

  private expenseCreated(p: any): void {
    if (this.state.expenses.has(p.id)) return;
    const e: Expense = {
      id: p.id,
      date: p.date,
      category: p.category,
      description: p.description,
      amountCents: p.amountCents,
      paymentMethod: p.paymentMethod,
      reference: p.reference,
      collectionId: p.collectionId,
      createdAt: this.currentMeta.timestamp,
      updatedAt: this.currentMeta.timestamp,
    };
    this.state.expenses.set(e.id, e);
  }

  private expenseUpdated(p: any, hlc: number): void {
    const e = this.state.expenses.get(p.expenseId);
    if (!e) return;
    this.undeleteIfNewer(this.state.expenses, p.expenseId, hlc);
    this.mergeFields(e, p.expenseId, p, hlc);
  }

  /* ---------------- Device ---------------- */

  private deviceRegistered(p: any): void {
    if (this.state.devices.has(p.deviceId)) return;
    const d: DeviceInfo = { id: p.deviceId, name: p.name, createdAt: Date.now() };
    this.state.devices.set(d.id, d);
  }

  /* ---------------------------------------------------------------- */
  /* Reservas                                                          */
  /* ---------------------------------------------------------------- */

  /** Recalcula la contribución reservada de una línea y ajusta el agregado. */
  private updateLineReservation(lineId: string): void {
    const line = this.state.orderLines.get(lineId);
    if (!line) return;
    const order = this.state.orders.get(line.orderId);
    const prev = this.state.reservedContribution.get(lineId) ?? 0;
    const next = lineReservedContribution(line, order);
    if (prev === next) return;

    this.state.reservedContribution.set(lineId, next);
    const agg = ensureAggregate(this.state, line.variantId);
    agg.reservedQty += next - prev;
    agg.availableQty = agg.totalQty - agg.reservedQty;
    agg.lowStockAlert = agg.availableQty <= agg.minStock;
  }

  /** Recalcula todas las líneas de un pedido (usado al cambiar su estado). */
  private refreshOrderReservation(orderId: string): void {
    const ids = this.state.orderLinesByOrder.get(orderId);
    if (!ids) return;
    for (const id of ids) this.updateLineReservation(id);
  }
}
