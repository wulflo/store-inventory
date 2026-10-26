import type { App } from '../app/App';
import type { SizeCode } from '../core/types';
import {
  addPayment,
  createCollection,
  createColor,
  createCustomer,
  createExpense,
  createOrder,
  createProductionOrder,
  createProduct,
  completeProductionLine,
  deliverOrderLine,
  generateVariants,
  setInitialStock,
  updateOrder,
} from '../domain/commands';

const DAY = 86_400_000;

/**
 * Datos de demostración.
 *
 * Se carga SOLO si la base está vacía, para que la app arranque con algo
 * para mirar (2 colecciones, 5 productos, 10 clientes, 10 pedidos).
 */
export async function seedIfEmpty(app: App): Promise<boolean> {
  if (app.state.eventCount > 0) return false;

  const now = Date.now();

  /* ------------------------------------------------------------------ */
  /* Colecciones                                                         */
  /* ------------------------------------------------------------------ */
  const winter = await createCollection(app, {
    name: 'Invierno 2026',
    season: 'invierno',
    year: 2026,
    startDate: now - 120 * DAY,
    endDate: now + 60 * DAY,
  });
  const summer = await createCollection(app, {
    name: 'Verano 2026',
    season: 'verano',
    year: 2026,
    startDate: now + 30 * DAY,
    endDate: now + 200 * DAY,
  });

  /* ------------------------------------------------------------------ */
  /* Colores                                                             */
  /* ------------------------------------------------------------------ */
  const negro = await createColor(app, { name: 'Negro', hex: '#111827' });
  const blanco = await createColor(app, { name: 'Blanco', hex: '#f3f4f6' });
  const gris = await createColor(app, { name: 'Gris Melange', hex: '#9ca3af' });
  const rojo = await createColor(app, { name: 'Rojo', hex: '#dc2626' });

  const colorIds = [negro.id, blanco.id, gris.id, rojo.id];
  const colorByName: Record<string, string> = {
    Negro: negro.id,
    Blanco: blanco.id,
    'Gris Melange': gris.id,
    Rojo: rojo.id,
  };

  /* ------------------------------------------------------------------ */
  /* Productos + variantes (7 talles x 4 colores = 28 por producto)       */
  /* ------------------------------------------------------------------ */
  const productSpecs = [
    {
      sku: 'REM-001',
      name: 'Remera Básica',
      type: 'remera' as const,
      collectionId: winter.id,
      price: 1_890_000,
      fabric: 450_000,
      print: 0,
      labor: 900_000,
      other: 250_000,
      minStock: 3,
    },
    {
      sku: 'REM-002',
      name: 'Remera Estampada',
      type: 'remera' as const,
      collectionId: winter.id,
      price: 2_490_000,
      fabric: 500_000,
      print: 600_000,
      labor: 950_000,
      other: 250_000,
      minStock: 3,
    },
    {
      sku: 'REM-003',
      name: 'Remera Oversize',
      type: 'remera' as const,
      collectionId: summer.id,
      price: 2_190_000,
      fabric: 550_000,
      print: 0,
      labor: 900_000,
      other: 300_000,
      minStock: 3,
    },
    {
      sku: 'BUZ-001',
      name: 'Buzo Hoodie',
      type: 'buzo' as const,
      collectionId: winter.id,
      price: 3_990_000,
      fabric: 1_400_000,
      print: 0,
      labor: 1_600_000,
      other: 350_000,
      minStock: 2,
    },
    {
      sku: 'BUZ-002',
      name: 'Buzo Crewneck',
      type: 'buzo' as const,
      collectionId: winter.id,
      price: 3_590_000,
      fabric: 1_250_000,
      print: 500_000,
      labor: 1_500_000,
      other: 350_000,
      minStock: 2,
    },
  ];

  const productIds: string[] = [];
  for (const p of productSpecs) {
    const { id } = await createProduct(app, {
      collectionId: p.collectionId,
      sku: p.sku,
      name: p.name,
      type: p.type,
      basePriceCents: p.price,
      costFabricCents: p.fabric,
      costPrintCents: p.print,
      costLaborCents: p.labor,
      costOtherCents: p.other,
    });
    productIds.push(id);

    const totalCost = p.fabric + p.print + p.labor + p.other;
    await generateVariants(
      app,
      id,
      ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'],
      colorIds,
      { minStock: p.minStock, costCents: totalCost, priceCents: p.price },
    );
  }

  /* ------------------------------------------------------------------ */
  /* Stock inicial                                                       */
  /* ------------------------------------------------------------------ */
  const allSizes: SizeCode[] = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];
  for (const [pIndex, productId] of productIds.entries()) {
    const spec = productSpecs[pIndex];
    for (const [cIndex, colorId] of colorIds.entries()) {
      for (const [sIndex, size] of allSizes.entries()) {
        // Los talles extremos quedan en cero a propósito: se disparan las
        // alertas de stock mínimo y la sugerencia de producción.
        const inMiddle = sIndex >= 2 && sIndex <= 4;
        const qty = inMiddle ? 4 + ((pIndex + cIndex + sIndex) % 5) + 2 : cIndex === 0 ? 1 : 0;
        if (qty <= 0) continue;
        const vid = findVariant(app, productId, size, colorId);
        if (!vid) continue;
        await setInitialStock(app, vid, qty, 'Carga inicial');
      }
    }
    void spec;
  }

  /* ------------------------------------------------------------------ */
  /* Clientes                                                            */
  /* ------------------------------------------------------------------ */
  const customerSpecs = [
    { name: 'María Gómez', phone: '+5491122334455', address: 'Av. Corrientes 1234, CABA' },
    { name: 'Lucas Fernández', phone: '+5491167889900', address: 'Bv. San Juan 456, CABA' },
    { name: 'Sofía Ramírez', phone: '+5491144556677', address: 'Av. Santa Fe 890, CABA' },
    { name: 'Diego Moreno', phone: '+5491199887766', address: 'Rivadavia 234, La Plata' },
    { name: 'Carla Ruiz', phone: '+5491133221100', address: 'Córdoba 1500, CABA' },
    { name: 'Tomás Díaz', phone: '+5492977655544', address: '9 de Julio 320, Mar del Plata' },
    { name: 'Lucía Herrera', phone: '+5491155667788', address: 'Pueyrredón 45, CABA' },
    { name: 'Bruno Álvarez', phone: '+5491133998877', address: 'Cabildo 2100, CABA' },
    { name: 'Valentina Sosa', phone: '+5491144778899', address: 'Pueyrredón 1200, CABA' },
    { name: 'Gonzalo Medina', phone: '+5491144123344', address: 'Caseros 750, Rosario' },
  ];

  const customerIds: string[] = [];
  for (const c of customerSpecs) {
    const { id } = await createCustomer(app, {
      name: c.name,
      phone: c.phone,
      address: c.address,
    });
    customerIds.push(id);
  }

  /* ------------------------------------------------------------------ */
  /* Pedidos                                                             */
  /* ------------------------------------------------------------------ */
  const orderSpecs: {
    customer: number;
    lines: { product: number; color: string; size: SizeCode; qty: number }[];
    dueInDays: number;
    status?: 'pendiente' | 'en_produccion' | 'listo' | 'entregado' | 'cancelado';
    payRatio?: number;
  }[] = [
    {
      customer: 0,
      lines: [
        { product: 0, color: 'Negro', size: 'M', qty: 2 },
        { product: 0, color: 'Blanco', size: 'L', qty: 1 },
      ],
      dueInDays: 3,
      payRatio: 0.5,
    },
    {
      customer: 1,
      lines: [
        { product: 3, color: 'Negro', size: 'L', qty: 1 },
        { product: 3, color: 'Gris Melange', size: 'XL', qty: 1 },
      ],
      dueInDays: 10,
    },
    {
      customer: 2,
      lines: [{ product: 1, color: 'Rojo', size: 'S', qty: 3 }],
      dueInDays: 5,
      payRatio: 1,
    },
    {
      customer: 3,
      lines: [
        { product: 2, color: 'Blanco', size: 'M', qty: 4 },
        { product: 2, color: 'Negro', size: 'M', qty: 2 },
      ],
      dueInDays: 14,
    },
    {
      customer: 4,
      lines: [{ product: 0, color: 'Gris Melange', size: 'S', qty: 2 }],
      dueInDays: 0,
      payRatio: 1,
    },
    {
      customer: 5,
      lines: [{ product: 4, color: 'Negro', size: 'XXL', qty: 2 }],
      dueInDays: 20,
    },
    {
      customer: 6,
      lines: [
        { product: 1, color: 'Negro', size: 'M', qty: 1 },
        { product: 1, color: 'Rojo', size: 'M', qty: 1 },
      ],
      dueInDays: 7,
      payRatio: 0.3,
    },
    {
      customer: 7,
      lines: [{ product: 0, color: 'Blanco', size: 'XL', qty: 3 }],
      dueInDays: 25,
    },
    {
      customer: 8,
      lines: [
        { product: 2, color: 'Rojo', size: 'L', qty: 2 },
        { product: 4, color: 'Gris Melange', size: 'M', qty: 1 },
      ],
      dueInDays: -2,
      payRatio: 1,
    },
    {
      customer: 9,
      lines: [{ product: 3, color: 'Negro', size: 'XL', qty: 1 }],
      dueInDays: 12,
    },
  ];

  const orderIds: string[] = [];
  for (const spec of orderSpecs) {
    const lines = spec.lines
      .map((l) => {
        const vid = findVariant(app, productIds[l.product], l.size, colorByName[l.color]);
        return vid ? { variantId: vid, quantity: l.qty } : null;
      })
      .filter((l): l is { variantId: string; quantity: number } => l !== null);

    if (lines.length === 0) continue;

    const { id } = await createOrder(app, {
      customerId: customerIds[spec.customer],
      dueDate: now + spec.dueInDays * DAY,
      lines,
    });
    orderIds.push(id);

    if (spec.payRatio) {
      const total = lines.reduce((s, l) => {
        const v = app.state.variants.get(l.variantId);
        return s + l.quantity * (v?.priceCents ?? 0);
      }, 0);
      const amount = Math.round((total * spec.payRatio) / 100) * 100;
      await addPayment(app, id, {
        amountCents: amount,
        method: spec.payRatio === 1 ? 'transferencia' : 'efectivo',
      });
      if (spec.payRatio === 1) {
        await updateOrder(app, id, { paymentStatus: 'pagado' });
      } else if (spec.payRatio > 0) {
        await updateOrder(app, id, { paymentStatus: 'parcial' });
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Entregas (generan movimientos de tipo "venta")                      */
  /* ------------------------------------------------------------------ */
  const deliverSpecs: { order: number; line: number; qty: number }[] = [
    { order: 0, line: 0, qty: 1 },
    { order: 2, line: 0, qty: 2 },
    { order: 4, line: 0, qty: 2 },
    { order: 8, line: 0, qty: 2 },
  ];

  for (const d of deliverSpecs) {
    const orderId = orderIds[d.order];
    if (!orderId) continue;
    const lineIds = [...(app.state.orderLinesByOrder.get(orderId) ?? [])];
    const line = app.state.orderLines.get(lineIds[d.line]);
    if (!line) continue;
    const remaining = line.quantity - line.deliveredQty;
    const qty = Math.min(d.qty, remaining);
    if (qty <= 0) continue;
    await deliverOrderLine(app, line.id, qty);
  }

  // Un pedido queda cancelado: libera la reserva.
  if (orderIds[9]) {
    await updateOrder(app, orderIds[9], { status: 'cancelado' });
  }
  // Un pedido queda listo para entregar.
  if (orderIds[1]) {
    await updateOrder(app, orderIds[1], { status: 'listo' });
  }

  /* ------------------------------------------------------------------ */
  /* Producción                                                          */
  /* ------------------------------------------------------------------ */
  const prod1 = await createProductionOrder(app, {
    collectionId: winter.id,
    scheduledDate: now + 6 * DAY,
    notes: 'Lote de remeras básicas para el winter',
    lines: buildProdLines(app, productIds, colorByName, [
      { product: 0, color: 'Negro', size: 'M', qty: 10 },
      { product: 0, color: 'Negro', size: 'L', qty: 8 },
      { product: 0, color: 'Blanco', size: 'M', qty: 6 },
    ]),
  });

  const prod2 = await createProductionOrder(app, {
    collectionId: winter.id,
    scheduledDate: now - 2 * DAY,
    notes: 'Buzos de la temporada',
    lines: buildProdLines(app, productIds, colorByName, [
      { product: 3, color: 'Negro', size: 'L', qty: 5 },
      { product: 3, color: 'Gris Melange', size: 'XL', qty: 4 },
    ]),
  });

  const prod3 = await createProductionOrder(app, {
    collectionId: summer.id,
    scheduledDate: now + 21 * DAY,
    notes: 'Pruebas de la colección verano',
    lines: buildProdLines(app, productIds, colorByName, [
      { product: 2, color: 'Blanco', size: 'M', qty: 12 },
      { product: 2, color: 'Rojo', size: 'L', qty: 12 },
    ]),
  });

  // Completar parte de la orden 2 (y generar stock real).
  const prod2Lines = [...(app.state.productionLinesByOrder.get(prod2.id) ?? [])];
  for (const lineId of prod2Lines) {
    const line = app.state.productionLines.get(lineId);
    if (!line) continue;
    const qty = Math.min(line.plannedQty, 3);
    if (qty <= 0) continue;
    await completeProductionLine(app, line.id, qty);
  }

  void prod1;
  void prod3;

  /* ------------------------------------------------------------------ */
  /* Gastos                                                              */
  /* ------------------------------------------------------------------ */
  const expenseSpecs = [
    { days: 4, category: 'insumos' as const, desc: 'Compra de telas (algodón)', amount: 320_000, method: 'transferencia' as const },
    { days: 9, category: 'envio' as const, desc: 'Envíos a Córdoba', amount: 48_000, method: 'efectivo' as const },
    { days: 16, category: 'publicidad' as const, desc: 'Flyers y redes', amount: 90_000, method: 'efectivo' as const },
    { days: 23, category: 'servicios' as const, desc: 'Luz del taller', amount: 65_000, method: 'transferencia' as const },
    { days: 31, category: 'otros' as const, desc: 'Bolsas y packaging', amount: 37_500, method: 'efectivo' as const },
  ];

  for (const e of expenseSpecs) {
    await createExpense(app, {
      date: now - e.days * DAY,
      category: e.category,
      description: e.desc,
      amountCents: e.amount,
      paymentMethod: e.method,
    });
  }

  return true;
}

/* ------------------------------------------------------------------ */

function findVariant(
  app: App,
  productId: string,
  size: SizeCode,
  colorId: string,
): string | undefined {
  for (const vid of app.state.variantsByProduct.get(productId) ?? []) {
    const v = app.state.variants.get(vid);
    if (v && !v.deletedAt && v.sizeCode === size && v.colorId === colorId) return v.id;
  }
  return undefined;
}

function buildProdLines(
  app: App,
  productIds: string[],
  colorByName: Record<string, string>,
  specs: { product: number; color: string; size: SizeCode; qty: number }[],
): { variantId: string; plannedQty: number }[] {
  const out: { variantId: string; plannedQty: number }[] = [];
  for (const s of specs) {
    const colorId = colorByName[s.color];
    if (!colorId) continue;
    const vid = findVariant(app, productIds[s.product], s.size, colorId);
    if (vid) out.push({ variantId: vid, plannedQty: s.qty });
  }
  return out;
}
