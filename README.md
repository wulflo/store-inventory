# Inventario Tienda

Gestión local-first para emprendimiento de indumentaria (remeras y buzos). Stack: **Tauri 2 + TypeScript vanilla + Vite**, persistencia en **Event Sourcing (JSONL append-only)**, sin base SQL `.db`.

## Funcionalidades

### Catálogo
- Colecciones con temporada/año y resumen (ventas, unidades producidas, margen).
- Productos con SKU, tipo (remera/buzo), precio y costos (tela, estampado, mano de obra, otros).
- Colores con código hex.
- Variantes generadas en grilla **talles × colores** (talles fijos: XS, S, M, L, XL, XXL, 3XL).
- Stock mínimo por variante con alertas.

### Pedidos
- Crear pedidos con cliente, líneas (variante + cantidad), fecha de entrega y notas.
- Estados: pendiente, en producción, listo, entregado, cancelado.
- Pagos parciales y estados de pago (sin pagar, seña, parcial, pagado).
- Entrega total o parcial de líneas (genera movimiento de stock tipo "venta").
- Validación de stock disponible con aviso (venta sin stock permitida, queda "a producir").
- WhatsApp para clientes.
- Impresión de detalle de pedido.

### Producción
- Órdenes de producción con líneas (variante + cantidad planificada).
- Estados: planificada, en proceso, completada, cancelada.
- Completar producción (genera movimiento de stock tipo "producción").
- Vinculación automática de lo producido con líneas de pedidos abiertas.
- Sugerencias de producción basadas en pedidos pendientes vs stock disponible.

### Stock
- Stock derivado de movimientos (append-only, inmutable).
- Stock total, reservado (comprometido por pedidos no cancelados) y disponible.
- Movimientos: producción, venta, ajuste positivo/negativo, devolución, inicial.
- Historial de movimientos filtrable por tipo, fecha y búsqueda.
- Alertas de stock mínimo.

### Clientes
- Listado y detalle con datos de contacto (teléfono, email, dirección, notas).
- Historial de pedidos y saldo por cliente.
- Enlace directo a WhatsApp.
- Soft delete (archivado) si tiene pedidos.

### Gastos
- Registro de gastos con fecha, categoría, descripción, monto y método de pago.
- Resumen por categoría y período.
- Editar y eliminar gastos.

### Reportes
- Ingresos, ganancia bruta, gastos, ganancia neta por período (mes/trimestre/año/personalizado).
- Desglose por colección y top productos más vendidos.
- Gastos por categoría.
- Producción del período.

### Ajustes y datos
- Información del dispositivo y tipo de almacenamiento.
- Preferencias: moneda (ARS/USD/EUR) y tema claro/oscuro.
- Exportar/importar respaldo JSON (todos los eventos).
- Importación inicial de CSV (productos, clientes, pedidos) con mapeo de columnas.
- Lista de dispositivos conocidos (para sincronización).
- Zona de riesgo (vaciar datos — pendiente de implementación completa).

### Semántica de datos
- **IDs UUID v7** (ordenables por tiempo, sin autoincrement).
- `created_at` / `updated_at` / `deleted_at` / `device_id` en toda entidad.
- Dinero siempre en **centavos ARS** (enteros).
- Cambios registrados como eventos inmutables; el estado se deriva (no se sobrescribe).
- Resolución de conflictos: movimientos siempre se unen; campos editables LWW por campo con HLC.

### Modo de uso
- 100% local / offline, sin nube ni cuentas obligatorias.
- Desarrollo: `npm run dev` (Vite en `http://127.0.0.1:1420`).
- App nativa: `npm run app:dev` (Tauri) / `npm run app:build` (pendiente de `src-tauri/`).
- Sincronización mediante agentes externos sobre una carpeta de datos (Syncthing / Google Drive).
- Backup diario con rotación (pendiente de implementar en `src-tauri/`).

## Limitaciones conocidas
- `src-tauri/` aún no implementado: la app funciona en modo web (OPFS) pero no empaqueta como escritorio nativo ni móvil.
- Sincronización P2P cifrada LAN: no implementada aún (fase pendiente).
- Android / SAF: no implementado aún.
- Actualizaciones automáticas: no implementadas aún.
- CI/CD: no configurado aún.
