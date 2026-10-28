# Progreso del proyecto — Inventario Tienda

**Fecha de inicio de este registro:** 2026-10-27  
**Versión publicada al iniciar:** `v0.2.5`  
**Última versión publicada:** `v0.2.7`  
**Estado actual:** correcciones de esta sesión en el árbol de trabajo, sin publicar.
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
- [x] **2026-10-27 — v0.2.6:** versión y tag creados, pero el workflow de Release fue cancelado antes de publicar. No existe release `v0.2.6`; `releases/latest` no la toma.
- [x] **2026-10-27 — v0.2.7:** release publicado con APK, AAB, AppImage, `.deb`, EXE y MSI firmados, más `latest.json` apuntando a `0.2.7`.
  - URL: https://github.com/wulflo/store-inventory/releases/tag/v0.2.7
  - Workflow Release: `40597849000` — verificación, Linux, Windows, Android y publicación en verde.
  - Commit del release: `dff087a` (`chore(release): v0.2.7`).

---

## 2. Documento de continuidad

- [x] **2026-10-27:** crear este archivo `docs/PROGRESO.md`.
- [x] Mantenerlo actualizado al final de cada tanda de cambios.
- [x] Registrar comando de release usado y resultado del workflow: `node scripts/version.mjs set X.Y.Z` + `git push origin main --tags`; `v0.2.7` terminó publicada correctamente.

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
- [x] Simplificar el alta de pedido para clientes frecuentes: el buscador ordena por cantidad de pedidos.
- [x] Mostrar clientes frecuentes en el alta: al abrir el buscador aparecen primero los clientes con más pedidos.
- [ ] Mantener saldo y estado de pago visibles en el listado.

---

## 5. Producción en marcha

- [x] Órdenes de producción y líneas ya existen.
- [x] Vista rápida de “producción en marcha” en Inicio (tarjeta “Qué producir esta semana”).
- [ ] Priorizar órdenes con pedidos pendientes.
- [ ] Completar producción parcial desde la vista principal.

---

## 6. Gastos

- [x] Alta, edición y borrado de gastos.
- [x] Resumen por categoría y período.
- [x] Mantener gastos generales separados de costos de producto (los gastos no se mezclan con el costo unitario).

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

- [x] Revisar flujo de escaneo de QR con cámara: jsQR + detector nativo `BarcodeDetector` cuando está disponible.
- [ ] Agregar OCR de texto real (si aplica a códigos/facturas/etiquetas). El escáner actual decodifica QR, no texto.
- [~] El SAS se muestra al recibir la conexión; falta validar en dispositivo real.
- [x] Permitir pegar/tipear el contenido del QR.
- [x] Manejar permisos de cámara denegados con mensaje claro.

---

## 10. Sincronización P2P

- [~] Desktop debe descubrir dispositivos Android en la LAN: se agregó “Buscar en la red” (escaneo TCP del puerto 14243) para saltar el bloqueo de UDP/multicast.
- [~] Android debe recibir respuesta al escanear el QR: se agregó reintento con la IP vista por discovery si falla la IP del QR.
- [x] Iniciar conexión al seleccionar un dispositivo descubierto (usa puerto de pairing).
- [~] Mostrar solicitud de emparejamiento en ambos lados: el SAS se muestra al recibir la conexión; falta probarlo en dispositivos reales.
- [~] Diagnóstico visible: IP, puerto, firewall, multicast. Se muestran IPs y resultados del escaneo TCP; falta un diagnóstico más detallado.
- [~] Reintentar conexión y mostrar error real: fallback QR → discovery y mensajes de error detallados.

---

## 11. Actualizaciones

- [x] Timeout para evitar espera infinita.
- [~] Desktop: descargar e instalar cuando detecta versión nueva. Si el plugin falla, se descarga el `.deb` o AppImage a Descargas y se abre el instalador.
- [~] Android: evitar congelamiento al buscar/descargar. Timeout de UI y botón “Abrir descargas” como salida manual.
- [~] Mostrar progreso de descarga: mensaje de estado y botón deshabilitado; falta progreso porcentual real.
- [x] Validar `latest.json`, firma y arquitectura: manifiesto y firma minisign verificados; arquitectura elegida por plataforma.
- [x] Registrar errores en UI: el mensaje de error queda visible en la tarjeta de actualizaciones.

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

## 13. Commits de esta sesión

- [x] `c101123` — Alta de producto simplificada, edición, stock manual, reportes y tema aero.
- [x] `50cf9e1` — Actualizaciones con fallback de descarga, QR con reintento LAN y diagnóstico de SAS.
- [x] `3e1cb4f` — Release `v0.2.6` (versión y tag).
- [x] `2a9b566` — Búsqueda de dispositivos por escaneo TCP cuando falla el descubrimiento UDP.
- [x] `ccac80d` — Priorizar clientes frecuentes en el alta de pedidos.
- [x] `dbc1d09` — Mensajes de firma genéricos para actualizaciones de escritorio.
- [x] `1abfa7b` — Mostrar el ajuste aplicado al fijar stock manual.
- [x] `e0235ec` — Documentación de producción y gastos.
- [x] `18af15d` — Detector nativo de QR como respaldo del escáner.
- [x] `ed63a9b` — Script de versión sincroniza también `src-tauri/gen/android/app/tauri.properties` (versionName/versionCode).
- [x] `dff087a` — Release `v0.2.7` (versión, `Cargo.lock`, tag y publicación).

---

## 14. Bitácora de cambios

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
- Agregado fallback de descarga manual del updater en desktop:
  - Si la app corre como AppImage, descarga el AppImage firmado.
  - Si está instalada desde `.deb`, descarga el `.deb` del release y abre el instalador.
  - Si el plugin falla, el error del plugin queda en el mensaje y se intenta la descarga manual.
- Agregado botón “Abrir descargas” en Actualizaciones para ir a la página de releases.
- Agregado fallback de conexión QR: si la IP del QR no responde, se reintenta con `ip:pairing_port` obtenido por discovery.
- Aclarado en la UI que el SAS de 6 dígitos se genera al recibir la conexión.
- Agregado “Buscar en la red”: escanea la subred /24 por el puerto TCP 14243 y lista dispositivos con emparejamiento abierto, como plan B si el firewall bloquea UDP.
- El escáner de cámara usa `BarcodeDetector` nativo como respaldo de jsQR, para mejorar la lectura en Android.
- Verificación: `npm run typecheck`, `npm test` (49), `npm run build`, `cargo test` (85) y `cargo check` pasan.
- Pendiente: validar sync real entre desktop/Android, OCR de texto real y descarga de actualizaciones en cada dispositivo.

### 2026-10-27 — publicación de `v0.2.7`
- Cancelado el workflow de Release `v0.2.6` antes de publicar; no quedó release `v0.2.6`.
- Versión subida a `0.2.7` en `package.json`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `version.ts` y `tauri.properties` (`versionCode 2007`).
- Tag `v0.2.7` creado sobre `dff087a` y enviado junto con `main`.
- Workflow Release `40597849000` terminó en verde: verificación, build Linux, build Windows, build Android y publicación.
- Release publicado: https://github.com/wulflo/store-inventory/releases/tag/v0.2.7
- Assets publicados:
  - `app-universal-release.apk` + `.sig`
  - `app-universal-release.aab`
  - `Inventario.Tienda_0.2.7_amd64.AppImage` + `.sig`
  - `Inventario.Tienda_0.2.7_amd64.deb`
  - `Inventario.Tienda_0.2.7_x64-setup.exe` + `.sig`
  - `Inventario.Tienda_0.2.7_x64_en-US.msi` + `.sig`
  - `latest.json`
- `latest.json` publicado con `"version": "0.2.7"` y firmas reales para Android, Linux y Windows.
- Siguiente paso: instalar `v0.2.7` en desktop y Android, y probar actualizaciones, QR, “Buscar en la red” y el SAS de 6 dígitos.

---

## 15. Sesión 2026-10-27 — sync, stock, búsqueda, tema y seguridad

> Estado: cambios aplicados y verificados con typecheck/tests/build/cargo. Falta la prueba visual y de sync entre dispositivos reales.

### 15.1 Sincronización: la solicitud de Android ya no queda en nada

Causa encontrada:
- El desktop solo abría el listener de emparejamiento (TCP `14243`) cuando el usuario pulsaba “Mostrar QR y esperar”.
- Android sí enviaba la solicitud, pero si el listener no estaba abierto la conexión se rechazaba y la pantalla quedaba esperando.
- Aunque el listener estuviera abierto, la UI de Ajustes solo consultaba solicitudes pendientes dentro de esa ventana; al salir de Ajustes se perdía el aviso.

Cambios:
- [x] El listener de emparejamiento queda como “bandeja” siempre activa mientras la sincronización está encendida.
- [x] El QR ya no reinicia el listener: solo actualiza el token y su vencimiento (`PAIRING_QR_TTL_MS = 120 s`).
- [x] Una solicitud manual sin token válido sigue siendo aceptada, pero requiere comparar el SAS de 6 dígitos y confirmar en **ambos** dispositivos.
- [x] `PAIRING_TTL_MS` subió a 5 minutos para que una solicitud no expire mientras el usuario abre Ajustes.
- [x] La UI de Ajustes consulta solicitudes pendientes mientras la sincronización está activa, aunque no se haya abierto el QR.
- [x] El polling solo vuelve a renderizar cuando cambia el dispositivo pendiente, para no borrar el foco de los campos.
- [x] Al recibir una solicitud se emite `sync-pairing-request`; si el usuario no está en Ajustes aparece un aviso para ir a confirmar.
- [x] Al completar el emparejamiento se refresca la lista de peers, se avisa y se dispara un `sync_now` en segundo plano.
- [x] `stop_pairing` ya no cierra el listener; solo invalida el QR y limpia pendientes.
- [x] `sync_stop` sigue cerrando todo (sync + discovery + bandeja).

Cómo probar:
1. En la PC: `npm run tauri dev` y esperar a que Ajustes › Sincronización muestre “Activa”.
2. En Android: abrir la app, ir a Ajustes › Sincronización y buscar la PC.
3. En Android: enviar la solicitud.
4. En la PC: abrir Ajustes › Sincronización; debe aparecer la tarjeta con el SAS y el nombre del dispositivo.
5. Comparar el código en ambos lados y confirmar en Android **y** en la PC.
6. Verificar que el peer aparece en la lista y que se sincronizan eventos.

Si no aparece:
- [ ] Revisar que la PC y Android estén en la misma red y que el router no tenga “aislamiento de AP”.
- [ ] Permitir el puerto TCP de sincronización, el siguiente de emparejamiento y UDP `14244` en el firewall de la PC.
- [ ] Probar “Buscar en la red” (escaneo TCP del puerto de emparejamiento) como plan B si UDP está bloqueado.
- [ ] Verificar que la sincronización esté “Activa” en la PC antes de enviar la solicitud.

### 15.2 Stock editable desde el producto

- [x] La tabla de variantes del producto ahora tiene un input de **Stock real** editable.
- [x] Al cambiarlo se registra un movimiento `ajuste_pos` o `ajuste_neg` con motivo “Edición manual desde producto”.
- [x] Se valida que el stock sea un entero mayor o igual a cero.
- [x] Se actualiza el stock sin depender de una orden de producción.
- [x] El botón “Fijar” de la vista Stock sigue disponible como alternativa.

### 15.3 Productos básicos que pasan a colección

- [x] El modal de edición de producto permite cambiar la colección.
- [x] Se agregó el botón “Nueva colección” dentro de la edición; al crearla queda seleccionada.
- [x] `openCreateCollection` ahora devuelve el id de la colección creada.

### 15.4 Búsqueda

- [x] `matches()` normaliza mayúsculas y acentos; se aplicó en:
  - [x] búsqueda de clientes en el alta de pedido;
  - [x] búsqueda de productos/colección en el alta de pedido;
  - [x] búsqueda de productos en el alta de producción.
- [x] El autocompletado muestra las primeras opciones al enfocar vacío (antes decía “Sin resultados”).
- [x] Se agregó buscador al catálogo de productos por nombre, SKU, tipo o colección.
- [x] El catálogo muestra “Sin resultados” cuando no hay coincidencias.

### 15.5 Tema aero celeste / azul oscuro y superposiciones

- [x] Tema claro: primario celeste (`#0369a1`), contenedores celestes y fondo azul muy claro.
- [x] Tema oscuro: primario celeste claro (`#4fc3f7`) sobre fondo azul océano (`#04121f`).
- [x] Acento por defecto “Celeste” en Ajustes (antes “Azul” índigo).
- [x] Fondo “aero” con gradientes celestes/turquesa y vidrio en sidebar/topbar.
- [x] Corregido el solapamiento del catálogo:
  - [x] `.list-item` permite wrap;
  - [x] `.list-item-title` tiene `min-width: 0` y corte de palabras;
  - [x] los badges no se encogen;
  - [x] el valor (precio/margen) y los botones se acomodan sin invadir el nombre.

### 15.6 Seguridad (informe `TXT.txt`)

- [x] `.deb`: el updater ya no descarga un `.deb` sin verificar. El workflow firma el `.deb` y `latest.json` publica `linux-x86_64-deb` con firma.
- [x] Si una versión no trae `.deb` firmado, el updater muestra un mensaje para descargarlo manualmente desde Releases.
- [x] `manifest.version` se valida como semver y ya no se usa para construir una ruta/URL.
- [x] Nombre de archivo descargado saneado contra path traversal.
- [x] CSP activada en `tauri.conf.json` (IPC, dev WebSocket, imágenes data/blob, estilos inline).
- [x] `event_store`: los dominios se validan contra una lista blanca; `../` queda rechazado.
- [x] `event_store`: cada línea debe ser JSON de una sola línea antes de escribir en texto plano.
- [x] `identity.pem`: permisos `0600`; carpeta de identidad `0700` en Unix; se corrige al cargar.
- [x] `KeyMaterial`: `Zeroize`/`ZeroizeOnDrop` y `Debug` redactado.
- [x] Comandos de diagnóstico criptográfico deshabilitados en builds de producción.
- [x] Exportación de copia con advertencia explícita antes de descargar.
- [x] `Projector`: descarta eventos con HLC `NaN`/`Infinity`/negativo y payloads `{ _encrypted: true }` que no se pudieron descifrar, antes de contaminar `lastHlc` o el stock.
- [x] `autoSync`: los reintentos usan un timer propio, no se cancelan por el debounce ni por el intervalo mínimo; los cambios durante un sync se reprograman al terminar.

### 15.7 Verificación local

- [x] `npm run typecheck`
- [x] `npm test` — 51 tests
- [x] `npm run build`
- [x] `cargo check`
- [x] `cargo test` — 85 tests + 1 ignorado
- [x] Prueba en navegador (Vite en `1421`): buscador del catálogo, edición de stock a 5, tema oscuro y ausencia de solapamiento nombre/badges/botones.
- [ ] `npm run tauri dev` — prueba visual y de sync real (pendiente del usuario)
- [ ] Probar actualización desde una versión anterior; el `.deb` firmado recién estará disponible a partir del próximo release.
- [ ] Probar cámara/QR en Android y “Buscar en la red”.

### 15.8 Próximo release

- [ ] Subir versión con `node scripts/version.mjs set 0.2.8`.
- [ ] Revisar el workflow Release: Linux debe publicar `*.deb.sig` y `latest.json` debe incluir `linux-x86_64-deb`.
- [ ] `git push origin main --tags`.
- [ ] Verificar assets y `latest.json` en GitHub.
- [ ] Instalar `0.2.8` en desktop/Android y probar sync + actualización.

### 15.9 Archivos tocados en esta sesión

- `src-tauri/src/sync/manager.rs`
- `src-tauri/src/sync/server.rs`
- `src-tauri/src/sync/pairing.rs`
- `src-tauri/src/sync/identity.rs`
- `src-tauri/src/event_store.rs`
- `src-tauri/src/crypto.rs`
- `src-tauri/src/updater.rs`
- `src-tauri/Cargo.toml` / `Cargo.lock`
- `src-tauri/tauri.conf.json`
- `.github/workflows/release.yml`
- `scripts/latest-json.mjs`
- `tests/latest-json.test.ts`
- `src/ui/views/settingsSync.ts`
- `src/ui/views/products.ts`
- `src/ui/views/productNew.ts`
- `src/ui/views/orderNew.ts`
- `src/ui/views/productionNew.ts`
- `src/ui/views/settings.ts`
- `src/ui/components/autocomplete.ts`
- `src/ui/styles.css`
- `src/ui/theme.ts`
- `src/projection/Projector.ts`
- `src/sync/autoSync.ts`
- `src/main.ts`

---

## 16. Sesión 2026-10-27 — puertos configurables y refresco de stock

### 16.1 Puerto de sincronización configurable

Decisión: **sí conviene que sea configurable**, pero con un puerto base persistente y sin cambios aleatorios. Un puerto aleatorio rompería las reglas de firewall y haría impredecible el QR. El descubrimiento UDP queda fijo en `14244` para que dos instalaciones se encuentren aunque una haya cambiado sus puertos TCP.

- [x] Nuevo `src-tauri/src/sync/ports.rs` con validación de rango (`1024..=65534`).
- [x] El puerto de emparejamiento se deriva como `puerto_base + 1`.
- [x] Configuración persistida en `<datos>/sync/ports.json`.
- [x] Comando `sync_set_ports`; si la sincronización está activa, reinicia sync, emparejamiento y descubrimiento con los puertos nuevos.
- [x] Si el puerto nuevo no se puede abrir, se restauran los puertos anteriores y se reinicia el servidor.
- [x] El QR y los anuncios de descubrimiento incluyen los puertos configurados, así que el otro dispositivo no necesita adivinarlos.
- [x] La UI de Ajustes › Sincronización muestra un campo **Puerto de red** y los puertos efectivos.
- [x] Los textos que decían “14242” fijo ahora usan el puerto real.

Nota: para el descubrimiento automático, ambos dispositivos deben poder usar UDP `14244`; si el router o el firewall lo bloquean, sigue disponible “Buscar en la red” por TCP.

### 16.2 Refresco del stock al editarlo

- [x] La lista de productos se vuelve a renderizar después de un ajuste manual de stock, sin cambiar de sección.
- [x] El input del modal queda con el valor aplicado y el movimiento sigue siendo append-only (`ajuste_pos`/`ajuste_neg`).
- [x] La corrección aplica tanto a variantes como al resumen de stock del producto/colección.
- [x] Al archivar un producto también se refresca la lista; antes quedaba visible hasta cambiar de sección.

### 16.3 Verificación

- [x] `npm run typecheck`
- [x] `npm test` — 51 tests
- [x] `cargo check`
- [x] `cargo test` — 89 tests + 1 ignorado
- [x] Prueba en navegador: stock XS de 11 a 13 actualizó el resumen de 48 a 50 sin salir de Catálogo.
- [x] `fuser -k 1420/tcp` liberó el puerto que ocupaba el Vite de `fitness-app`.
- [x] `npm run tauri dev` arrancó con sync en `14242`, emparejamiento en `14243` y descubrimiento UDP en `14244`.
- [x] Prueba en la app nativa: cambiar el puerto a `15000` movió los listeners a `15000/15001`, liberó `14242/14243` y persistió `ports.json`.
- [x] Prueba de rollback: con `16000` ocupado, la app volvió a `15000/15001`, restauró la configuración y el campo volvió a mostrar `15000`.
- [x] Se restauró el puerto por defecto `14242`; la app quedó ejecutándose con `npm run tauri dev`.
- [x] Prueba en la app nativa: producto de prueba, stock XS de 0 a 5; el Catálogo mostró “5 en stock” sin cambiar de sección (captura revisada).
- [x] El producto de prueba se archivó y desapareció de la lista con el refresco nuevo.
- [ ] Probar el cambio de puerto con Android y reiniciar ambos dispositivos.
- [ ] Confirmar que el firewall permite el puerto elegido y el siguiente.

### 16.4 Release v0.2.8 para probar en hardware real

- [ ] Commit de preparación con sync LAN, puertos configurables, stock editable y correcciones de seguridad.
- [ ] `node scripts/version.mjs set 0.2.8`.
- [ ] Actualizar `src-tauri/Cargo.lock` y verificar `node scripts/version.mjs check`.
- [ ] `git push origin main` y `git push origin v0.2.8`.
- [ ] Verificar que el workflow Release compile Linux, Windows y Android.
- [ ] Verificar `latest.json` con `v0.2.8`, `linux-x86_64-deb`, APK y firmas.
- [ ] Instalar `0.2.8` en desktop/Android y probar sync, QR, puertos y actualización.

---

## 17. Limitaciones de v0.2.12 (2026-10-28)

Se trabajó sobre las 7 limitaciones conocidas. El detalle completo, comandos y
pruebas físicas pendientes están en **`docs/LIMITACIONES_CHECKLIST.md`**.

- [x] **Moneda:** el selector ahora es moneda de visualización con cotización
  manual ARS por USD/EUR; los datos siguen en centavos ARS. `money()` usa la
  configuración global. Tests en `tests/money.test.ts`.
- [~] **Idioma:** se quitó la opción English para no ofrecer una traducción
  inexistente; la app fuerza español. La i18n completa queda planificada en la
  checklist.
- [x] **Export JSON:** en Tauri se exportan los payloads cifrados crudos
  (`store_export_raw`); en navegador se avisa que van descifrados.
- [x] **Backups pre-encryption:** `crypto_backup_info` / `crypto_delete_backups`
  y botón en Ajustes > Cifrado para revisar y borrar `omega/backups/`.
- [x] **Vaciar datos:** se refresca longlife antes de borrar; el refresco
  automático protege un snapshot con datos de un `omega` vacío
  (`LonglifeResult.protected`).
- [x] **`device_id`:** ahora es de la instalación (`installation_id` en app
  data), no de la bóveda. `omega/writer.json` + `writer_touch` avisan si otro
  equipo abrió la bóveda en los últimos 10 minutos.
- [ ] **Prueba física:** instalar la APK de release en un teléfono real y probar
  Foldersync/Drive según la checklist.

Verificación de esta tanda:

- [x] `npm run typecheck`
- [x] `npm test` — 58 tests
- [x] `cargo test` — 60 pass, 1 ignored
- [x] `cargo check`

---

## 18. Release v0.2.13 (2026-10-28)

Cierre de las limitaciones de `v0.2.12` y publicación de una versión nueva.
El detalle de decisiones y la checklist de continuidad están en
**`docs/LIMITACIONES_CHECKLIST.md`**.

Cambios incluidos:

- **Moneda de visualización:** selector ARS/USD/EUR con cotización manual
  (`currency_rate`, ARS por unidad). Los datos y formularios siguen en centavos
  ARS; al alternar ARS → USD/EUR se recupera la última cotización guardada.
- **Idioma:** se quitó English y la app fuerza español hasta completar la i18n.
- **Export cifrado:** `store_export_raw` exporta los payloads cifrados reales en
  Tauri; el store de navegador avisa que exporta en claro.
- **Backups pre-encryption:** `crypto_backup_info` / `crypto_delete_backups` y
  botón en Ajustes > Cifrado.
- **Vaciar datos:** refresco de longlife antes del vaciado y guarda
  `LonglifeResult.protected` para no reemplazar una copia con datos por un
  `omega` vacío.
- **Identidad de dispositivo:** `installation_device_id` fuera de la bóveda y
  latido `omega/writer.json` para avisar si otro equipo abrió la bóveda.
- **Arreglo de UX:** la cotización ya no se pierde al pasar por ARS.

Verificación:

- [x] `npm run typecheck`
- [x] `npm test` — 58 tests
- [x] `npm run build`
- [x] `cargo test` — 60 pass, 1 ignored
- [x] `cargo check`
- [x] Smoke test en navegador: gasto de ARS 1.250 mostrado como `US$ 1,00` con
  cotización 1250; persistencia tras recargar y al alternar monedas.

Pendiente: prueba física de la APK y sincronización Foldersync/Drive.
