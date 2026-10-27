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
- **Sincronización P2P (LAN):** emparejamiento por código SAS de 6 dígitos con TLS 1.3 mutuo y certificados autofirmados fijados (pinning). Solo acepta direcciones LAN privadas; reconciliación por dominios con deduplicación por ID.
- **Actualizaciones:** búsqueda e instalación firmadas con minisign. En escritorio se usa el actualizador de Tauri; en Android se descarga el APK, se verifica su firma y se guarda en la carpeta **Descargas** para instalarlo manualmente.
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
- Sincronización P2P directa por LAN (TLS mutuo + emparejamiento SAS). También se puede sincronizar por agentes externos sobre una carpeta de datos (Syncthing/Drive).
- Backup manual desde Ajustes; la rotación automática diaria aún no está.

### Requisitos de desarrollo
- Node 20+ y npm.
- Rust estable y dependencias de Tauri (WebKitGTK 4.1 en Linux).
- Android: JDK 17, Android SDK 35/37, NDK 27 y CMake.

## Limitaciones conocidas
- **P2P:** transporte TLS 1.3 mutuo con pinning y emparejamiento SAS implementado y probado con tests; requiere estar en la misma LAN y direcciones privadas. Sin descubrimiento mDNS automático (se usa IP manual).
- **Android/SAF:** funciona con almacenamiento privado; no hay selector de carpeta SAF ni espejo bidireccional.
- **Android:** APK universal firmado, con soporte portrait y guardado del APK actualizado en Descargas (con permiso en Android 9). Pendiente validación en hardware físico.
- **Actualizaciones:** updater firmado con minisign (base64 en `latest.json`). En Android se verifica la firma antes de guardar el APK; en escritorio usa `tauri-plugin-updater`. Requiere que el release esté publicado.
- **Firma Windows:** sin certificado Authenticode (posible aviso de SmartScreen).
- **CI/CD:** el workflow firma el APK Android con la keystore release, genera `.apk.sig` para el updater y publica `latest.json` con firmas reales.
- **Testing:** 49 tests vitest + 31 tests Rust; sin Playwright/E2E. La UI se verificó manualmente en navegador y emulador Android.
- **Dependencias:** Dependabot reporta alertas en `main`; revisar con regularidad.
- **Logo:** falta el archivo de logo definitivo.
