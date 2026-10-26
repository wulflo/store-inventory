import { describe, expect, it } from 'vitest';
import { App } from '../src/app/App';
import { MemoryEventStore } from '../src/store/WebEventStore';
import {
  addStockMovement,
  createColor,
  createCollection,
  createCustomer,
  createOrder,
  createProduct,
  deliverOrderLine,
  generateVariants,
  setInitialStock,
  updateOrder,
} from '../src/domain/commands';
import { orderTotals } from '../src/projection/queries';
import type { SizeCode } from '../src/core/types';

/** Crea una app en memoria con 1 colección, 1 producto y 2 variantes. */
export async function makeApp() {
  const store = new MemoryEventStore();
  const app = new App(store, 'test-device');
  await app.init();

  const { id: collectionId } = await createCollection(app, {
    name: 'Invierno 2026',
    season: 'invierno',
    year: 2026,
  });
  const { id: colorId } = await createColor(app, { name: 'Negro', hex: '#111827' });
  const { id: productId } = await createProduct(app, {
    collectionId,
    sku: 'REM-001',
    name: 'Remera Básica',
    type: 'remera',
    basePriceCents: 1_000_000,
    costFabricCents: 300_000,
    costPrintCents: 0,
    costLaborCents: 200_000,
    costOtherCents: 0,
  });

  const sizes: SizeCode[] = ['S', 'M', 'L'];
  await generateVariants(app, productId, sizes, [colorId], {
    minStock: 2,
    costCents: 500_000,
    priceCents: 1_000_000,
  });

  const variantIds = [...(app.state.variantsByProduct.get(productId) ?? [])];
  const bySize = new Map<string, string>();
  for (const id of variantIds) {
    const v = app.state.variants.get(id)!;
    bySize.set(v.sizeCode, id);
  }

  return { app, store, collectionId, colorId, productId, bySize };
}

describe('stock', () => {
  it('deriva el stock a partir de los movimientos', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('M')!;

    expect(app.state.stock.get(variantId)?.totalQty).toBe(0);

    await addStockMovement(app, {
      variantId,
      movementType: 'produccion',
      quantity: 10,
    });
    expect(app.state.stock.get(variantId)?.totalQty).toBe(10);

    await addStockMovement(app, {
      variantId,
      movementType: 'venta',
      quantity: -3,
    });
    expect(app.state.stock.get(variantId)?.totalQty).toBe(7);
    expect(app.state.stock.get(variantId)?.availableQty).toBe(7);
  });

  it('los movimientos son append-only: nunca se pisan', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('L')!;

    await setInitialStock(app, variantId, 5);
    await addStockMovement(app, {
      variantId,
      movementType: 'ajuste_neg',
      quantity: -1,
    });
    await addStockMovement(app, {
      variantId,
      movementType: 'ajuste_pos',
      quantity: 2,
    });

    expect(app.state.stockMovements.size).toBe(3);
    expect(app.state.stock.get(variantId)?.totalQty).toBe(6);
  });

  it('la carga inicial suma al total', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('S')!;
    await setInitialStock(app, variantId, 4, 'Carga inicial');
    expect(app.state.stock.get(variantId)?.totalQty).toBe(4);
  });
});

describe('reservas', () => {
  it('el stock disponible descuenta lo comprometido por pedidos', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('M')!;
    await setInitialStock(app, variantId, 10);

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    await createOrder(app, {
      customerId,
      lines: [{ variantId, quantity: 4 }],
    });

    const agg = app.state.stock.get(variantId)!;
    expect(agg.totalQty).toBe(10);
    expect(agg.reservedQty).toBe(4);
    expect(agg.availableQty).toBe(6);
  });

  it('entregar libera la reserva', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('M')!;
    await setInitialStock(app, variantId, 10);

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    const { id: orderId } = await createOrder(app, {
      customerId,
      lines: [{ variantId, quantity: 4 }],
    });

    const lineId = [...(app.state.orderLinesByOrder.get(orderId) ?? [])][0];
    await deliverOrderLine(app, lineId, 4);

    const agg = app.state.stock.get(variantId)!;
    expect(agg.totalQty).toBe(6);
    expect(agg.reservedQty).toBe(0);
    expect(agg.availableQty).toBe(6);
  });

  it('cancelar un pedido libera la reserva', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('L')!;
    await setInitialStock(app, variantId, 8);

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    const { id: orderId } = await createOrder(app, {
      customerId,
      lines: [{ variantId, quantity: 3 }],
    });

    expect(app.state.stock.get(variantId)?.reservedQty).toBe(3);

    await updateOrder(app, orderId, { status: 'cancelado' });

    expect(app.state.stock.get(variantId)?.reservedQty).toBe(0);
    expect(app.state.stock.get(variantId)?.availableQty).toBe(8);
  });

  it('una entrega parcial deja el resto reservado', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('M')!;
    await setInitialStock(app, variantId, 10);

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    const { id: orderId } = await createOrder(app, {
      customerId,
      lines: [{ variantId, quantity: 5 }],
    });

    const lineId = [...(app.state.orderLinesByOrder.get(orderId) ?? [])][0];
    await deliverOrderLine(app, lineId, 2);

    const agg = app.state.stock.get(variantId)!;
    expect(agg.totalQty).toBe(8);
    expect(agg.reservedQty).toBe(3);
    expect(agg.availableQty).toBe(5);
  });
});

describe('márgenes', () => {
  it('el total del pedido usa el precio de la línea y calcula el margen', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('M')!;

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    const { id: orderId } = await createOrder(app, {
      customerId,
      lines: [{ variantId, quantity: 3 }],
    });

    const order = app.state.orders.get(orderId)!;
    const totals = orderTotals(app.state, order);

    expect(totals.totalCents).toBe(3_000_000);
    expect(totals.costCents).toBe(1_500_000);
    expect(totals.marginCents).toBe(1_500_000);
    expect(totals.marginPercent).toBeCloseTo(50, 5);
  });

  it('un precio cobrado mayor al de lista sube el margen', async () => {
    const { app, bySize } = await makeApp();
    const variantId = bySize.get('L')!;

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    const { id: orderId } = await createOrder(app, {
      customerId,
      lines: [{ variantId, quantity: 1, unitPriceCents: 1_500_000 }],
    });

    const order = app.state.orders.get(orderId)!;
    const totals = orderTotals(app.state, order);

    expect(totals.subtotalCents).toBe(1_500_000);
    expect(totals.profitCents).toBe(1_000_000);
    expect(totals.marginPercent).toBeCloseTo(66.666, 2);
  });
});

describe('change log / proyección', () => {
  it('cada evento se aplica una sola vez (idempotencia)', async () => {
    const { app, store, bySize } = await makeApp();
    const variantId = bySize.get('M')!;
    await setInitialStock(app, variantId, 7);

    const before = app.state.stock.get(variantId)!.totalQty;
    const events = await store.readAll();

    // Reproyecta los mismos eventos: no debe cambiar nada.
    for (const e of events) app.projector.apply(e);

    expect(app.state.stock.get(variantId)!.totalQty).toBe(before);
    expect(app.state.appliedEventIds.size).toBe(events.length);
  });

  it('el log de eventos queda append-only y ordenado por HLC', async () => {
    const { app, store, bySize } = await makeApp();
    await setInitialStock(app, bySize.get('M')!, 1);
    await setInitialStock(app, bySize.get('L')!, 2);

    const events = await store.readAll();
    const hlcs = events.map((e) => e.metadata.hlc);

    for (let i = 1; i < hlcs.length; i++) {
      expect(hlcs[i]).toBeGreaterThanOrEqual(hlcs[i - 1]);
    }
  });

  it('un evento con HLC viejo no pisa un campo ya actualizado (LWW por campo)', async () => {
    const { app, store, productId } = await makeApp();

    await app.emit('Product.Updated', { productId, name: 'Nombre nuevo' });

    // Evento "viejo" (HLC menor) que intenta cambiar el mismo campo.
    const stale = {
      id: 'evento-viejo',
      type: 'Product.Updated',
      payload: { productId, name: 'Nombre viejo' },
      metadata: { hlc: 1, deviceId: 'otro', timestamp: 1, version: 1 },
    };

    const fresh = await store.readAll();
    const maxHlc = Math.max(...fresh.map((e) => e.metadata.hlc));

    for (const e of fresh) app.projector.apply(e);
    app.projector.apply(stale);

    expect(app.state.products.get(productId)?.name).toBe('Nombre nuevo');
    expect(maxHlc).toBeGreaterThan(1);
  });

  it('reconstruir el estado desde el log da el mismo resultado', async () => {
    const { app, store, bySize } = await makeApp();
    const variantId = bySize.get('M')!;
    await setInitialStock(app, variantId, 9);

    const { id: customerId } = await createCustomer(app, { name: 'Ana' });
    await createOrder(app, { customerId, lines: [{ variantId, quantity: 2 }] });

    const before = {
      total: app.state.stock.get(variantId)!.totalQty,
      reserved: app.state.stock.get(variantId)!.reservedQty,
      available: app.state.stock.get(variantId)!.availableQty,
    };

    await app.rebuild();

    const after = app.state.stock.get(variantId)!;
    expect(after.totalQty).toBe(before.total);
    expect(after.reservedQty).toBe(before.reserved);
    expect(after.availableQty).toBe(before.available);
    expect((await store.readAll()).length).toBeGreaterThan(0);
  });
});

describe('validaciones del dominio', () => {
  it('no permite crear un pedido sin cliente ni sin líneas', async () => {
    const { app, bySize } = await makeApp();
    await expect(createOrder(app, { customerId: '', lines: [] })).rejects.toThrow();
  });

  it('avisa (sin bloquear) cuando no hay stock suficiente', async () => {
    const { app, bySize } = await makeApp();
    const { id: customerId } = await createCustomer(app, { name: 'Ana' });

    const { warnings } = await createOrder(app, {
      customerId,
      lines: [{ variantId: bySize.get('M')!, quantity: 5 }],
    });

    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('disponibles');
  });

  it('no permite crear dos productos con el mismo SKU', async () => {
    const { app, collectionId } = await makeApp();
    await expect(
      createProduct(app, {
        collectionId,
        sku: 'REM-001',
        name: 'Duplicado',
        type: 'remera',
        basePriceCents: 100,
        costFabricCents: 0,
        costPrintCents: 0,
        costLaborCents: 0,
        costOtherCents: 0,
      }),
    ).rejects.toThrow(/SKU/);
  });
});
