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
- Desarrollo web: `npm run dev` (Vite en `http://127.0.0.1:1420`).
- App nativa: `npm run app:dev` (Tauri) / `npm run app:build`.
- Escritorio: datos en `~/.local/share/inventario-tienda` (Linux).
- Android: datos en el almacenamiento privado de la app (`app_data_dir`).
- Sincronización por agentes externos sobre una carpeta de datos
  (Syncthing/Drive) o por el protocolo P2P propio (transporte en desarrollo).
- Backup manual desde Ajustes; la rotación automática diaria aún no está.

### Requisitos de desarrollo
- Node 20+ y npm.
- Rust estable y dependencias de Tauri (WebKitGTK 4.1 en Linux).
- Android: JDK 17, Android SDK 35/37, NDK 27 y CMake.

## Limitaciones conocidas
- **P2P:** el núcleo (identidad, peers, framing, reconciliación) está implementado
  y testeado; el transporte TLS/mDNS y la convergencia LAN no.
- **Android/SAF:** funciona con almacenamiento privado; no hay selector de
  carpeta SAF ni espejo bidireccional.
- **Android:** el APK universal del CI (4 ABIs, 39.923.555 B) se instaló y
  ejecutó en emulador API 35, conservando 315 eventos. Falta probarlo en un
  dispositivo físico y validar el APK arm64 en hardware real.
- **Actualizaciones:** el updater de escritorio está configurado y el release
  dry-run generó los artefactos firmados; el draft `v1.0.0` todavía no está
  publicado, así que falta probar una actualización real. En Android se actualiza
  reinstalando.
- **Firma Windows:** sin certificado Authenticode (posible aviso de SmartScreen).
- **CI/CD:** CI [`40484597887`](https://github.com/wulflo/store-inventory/actions/runs/40484597887)
  en verde y release dry-run [`40484612737`](https://github.com/wulflo/store-inventory/actions/runs/40484612737)
  completo (Linux, Windows, Android y publish). El draft `v1.0.0` tiene 10
  assets firmados; falta publicarlo.
- **Testing:** 45 tests vitest + 15 tests Rust; sin Playwright/E2E. La UI se
  verificó manualmente en navegador y emulador Android.
- **Dependencias:** Dependabot reporta 17 alertas en `main`; `npm audit` local da
  6 vulnerabilidades dev-only, 0 en producción.
- **Logo:** falta el archivo de logo definitivo.
