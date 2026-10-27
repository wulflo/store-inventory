# Progreso del proyecto — Inventario Tienda

**Fecha de inicio de este registro:** 2026-10-27  
**Versión publicada al iniciar:** `v0.2.5`  
**Rama:** `main`

> Este documento es la fuente de verdad para retomar el trabajo si se pierde el acceso a internet.
> Cada bloque tiene fecha, estado y detalle de los cambios.

---

## Convenciones

- [x] Hecho y verificado
- [ ] Pendiente
- [~] En progreso / parcial

---

## 1. Base ya publicada (histórico)

- [x] **2026-10-27 — v0.2.4:** timeouts de actualización, arranque sin datos de demostración, vaciado real de datos, navegación lateral Android, ajuste de números grandes.
- [x] **2026-10-27 — v0.2.5:** permiso de cámara Android, emparejamiento por descubrimiento usando el puerto correcto, arranque automático de sync/discovery.
- [x] Commit `8998e75`: fixes de actualizaciones, datos vacíos, navegación Android y números grandes.
- [x] Commit `cc5cda4`: fixes de cámara, emparejamiento y arranque de sync.
- [x] Tag y release `v0.2.5` enviados a GitHub.

---

## 2. Documento de continuidad

- [x] **2026-10-27:** crear este archivo `docs/PROGRESO.md`.
- [ ] Mantenerlo actualizado al final de cada tanda de cambios.
- [ ] Registrar comando de release usado y resultado del workflow.

---

## 3. Catálogo y productos

### 3.1 Creación de producto simplificada
- [x] Unificar los 3 pasos actuales en una sola pantalla.
- [x] Permitir crear colección y color sin salir del formulario.
- [x] Mostrar talles y colores seleccionados de forma compacta.
- [x] Calcular variantes en vivo (stock inicial queda para Stock).
- [x] Mantener SKU, precio, costos y margen visibles.

### 3.2 Edición de producto
- [x] Editar nombre, SKU, descripción y precio.
- [x] Cambiar tipo (`remera` ↔ `buzo`).
- [x] Cambiar colección (ej. básica → concierto).
- [x] Editar costos.
- [ ] Editar color/talle de variantes existentes.
- [x] Evitar duplicados de SKU al editar (validación existente).

### 3.3 Stock manual
- [x] Poder fijar la cantidad real de una variante desde Stock.
- [x] Registrar el ajuste como movimiento (`ajuste_pos` / `ajuste_neg`).
- [x] Mostrar el delta aplicado y el motivo.
- [x] Validar cantidades negativas o inválidas.

---

## 4. Ventas, pagos y clientes

- [x] Pedidos con líneas, estados y entrega parcial ya existen.
- [x] Pagos parciales/totales ya existen.
- [ ] Simplificar el alta de pedido para clientes frecuentes.
- [ ] Mostrar clientes frecuentes / últimos clientes en el alta.
- [ ] Mantener saldo y estado de pago visibles en el listado.

---

## 5. Producción en marcha

- [x] Órdenes de producción y líneas ya existen.
- [ ] Vista rápida de “producción en marcha” en Inicio.
- [ ] Priorizar órdenes con pedidos pendientes.
- [ ] Completar producción parcial desde la vista principal.

---

## 6. Gastos

- [x] Alta, edición y borrado de gastos.
- [x] Resumen por categoría y período.
- [ ] Mantener gastos generales separados de costos de producto.

---

## 7. Reportes y gráficos

- [x] Ingresos, ganancia bruta/neta, gastos y producción.
- [x] Ranking de productos más vendidos.
- [x] Agregar productos menos vendidos.
- [x] Gráficos de barras detallados por producto (ranking visual).
- [ ] Gráfico de evolución por período.
- [ ] Exportar reporte.

---

## 8. Tema visual “aero” Material

- [x] Mantener estructura de barra lateral y distribución actual.
- [x] Superficies translúcidas/glass sutil.
- [x] Gradientes suaves y luces de fondo.
- [x] Sombras más profundas y bordes suaves.
- [x] Mantener legibilidad y contraste.
- [x] Respetar `prefers-reduced-motion`.

---

## 9. OCR y escaneo

- [x] Revisar flujo de escaneo de QR con cámara.
- [ ] Agregar OCR de texto (si aplica a códigos/facturas/etiquetas).
- [~] El SAS se muestra al recibir la conexión; falta validar en dispositivo real.
- [x] Permitir pegar/tipear el contenido del QR.
- [x] Manejar permisos de cámara denegados con mensaje claro.

---

## 10. Sincronización P2P

- [ ] Desktop debe descubrir dispositivos Android en la LAN.
- [ ] Android debe recibir respuesta al escanear el QR.
- [x] Iniciar conexión al seleccionar un dispositivo descubierto (usa puerto de pairing).
- [ ] Mostrar solicitud de emparejamiento en ambos lados.
- [ ] Diagnóstico visible: IP, puerto, firewall, multicast.
- [ ] Reintentar conexión y mostrar error real.

---

## 11. Actualizaciones

- [x] Timeout para evitar espera infinita.
- [ ] Desktop: descargar e instalar cuando detecta versión nueva.
- [ ] Android: evitar congelamiento al buscar/descargar.
- [ ] Mostrar progreso de descarga.
- [ ] Validar `latest.json`, firma y arquitectura.
- [ ] Registrar errores en UI.

---

## 12. Próximos comandos útiles

```bash
# Desarrollo web
npm run dev

# App nativa
npm run app:dev

# Verificación
npm run typecheck
npm test
cd src-tauri && cargo check

# Release
node scripts/version.mjs set X.Y.Z
git push origin main --tags

# Estado del workflow
gh run list --limit 5
```

---

## 13. Bitácora de cambios

### 2026-10-27
- Creado este documento.
- Simplificado el alta de producto a un solo formulario.
- Agregada edición de producto (tipo, colección, precios, costos).
- Agregado “Fijar stock real” con ajuste automático.
- Agregados productos menos vendidos y ranking visual en Reportes.
- Aplicado tema “aero” Material (glass, gradientes, sombras).
- Agregado permiso de cámara Android y mensajes de permiso denegado.
- Agregado campo para pegar el contenido del QR.
- Corregido el emparejamiento desde dispositivos descubiertos para usar el puerto de pairing.
- Sincronización/discovery arranca automáticamente al abrir la app.
- Pendiente: validar sync real entre desktop/Android, OCR completo y descarga de actualizaciones.
