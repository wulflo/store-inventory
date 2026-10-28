# Limitaciones v0.2.12 → v0.2.13 — plan escalonado y checklist

> **Base:** `v0.2.12` (`d07f7f5`), rama `main`.
> **Release:** `v0.2.13` (2026-10-28).
> **Última actualización:** 2026-10-28.
> **Objetivo:** corregir las 7 limitaciones conocidas sin depender de internet.
> Este documento es la fuente de verdad para retomar el trabajo si se corta la
> conexión, la sesión o el build.
>
> Convenciones: `[x]` hecho y verificado · `[~]` parcial · `[ ]` pendiente.

---

## 0. Resumen de estado

| # | Limitación | Estado | Decisión |
|---|---|---|---|
| 1 | Moneda sin conversión | `[x]` | Moneda de **visualización** con cotización manual. Los datos siguen en centavos ARS. |
| 2 | Idioma con diccionarios vacíos | `[~]` | Se quitó la opción English para no mentir. i18n real queda para una fase posterior. |
| 3 | Export JSON dice “cifrado” pero exporta descifrado | `[x]` | En Tauri se exportan los payloads cifrados tal como están en disco. En navegador se avisa que van descifrados. |
| 4 | Backups pre-encryption en texto plano | `[x]` | Ajustes > Cifrado muestra y borra `omega/backups/pre-encryption-*`. |
| 5 | Vaciar datos puede dejar longlife vacío | `[x]` | Snapshot previo al vaciado + guarda que impide reemplazar una copia con datos por un `omega` vacío. |
| 6 | `device_id` compartido al copiar la bóveda | `[x]` | El id pasa a ser de la instalación (fuera de la bóveda). Latido en `omega/writer.json` avisa si otro equipo abrió la bóveda hace poco. |
| 7 | Falta prueba física de la APK y Foldersync/Drive | `[ ]` | Requiere teléfono real. Checklist detallada abajo. |

### Lo que NO se hizo (a propósito)

- **i18n completa:** traducir toda la interfaz es un trabajo aparte. Se quitó el
  selector English y se fuerza español para que no haya fechas en inglés con
  textos en español. Ver fase 2.
- **Lock distribuido real:** el aviso de `writer.json` es advisory. No bloquea
  escrituras ni pretende resolver conflictos de Foldersync. La regla sigue
  siendo “un solo equipo escribe a la vez”.
- **Conversión de formularios:** los inputs siguen en ARS. Cambiar la moneda
  solo afecta la visualización de importes ya guardados.

---

## 1. Antes de tocar nada (offline)

- [x] `git status --short` y `git log --oneline -5` revisados.
- [x] `npm run typecheck` en verde.
- [x] `npm test` en verde (58 tests).
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` en verde (60 pass, 1 ignored).
- [ ] Copiar la bóveda real a un lugar seguro antes de probar “Vaciar datos”.
- [ ] Anotar la versión y el `kid` del llavero que se va a usar en la prueba física.

Si no hay internet, **no hace falta** `npm install` ni `cargo fetch`:
`node_modules/` y `src-tauri/target/` ya están en el equipo. Si faltara algo,
usar el teléfono como hotspot o continuar con las fases que no compilan.

---

## 2. Fase 1 — Moneda

### Implementado

- [x] `src/core/money.ts`: `setDisplayCurrency`, `getDisplayCurrency`,
  `arsCentsToDisplay`, `displayCentsToArs`.
- [x] `formatMoney()` usa la moneda de visualización por defecto.
- [x] `src/ui/views/common.ts`: `money()` delega en `formatMoney()`.
- [x] Ajustes: selector ARS/USD/EUR + campo “Cotización (ARS por 1 USD/EUR)”.
- [x] La cotización se guarda en el evento `Setting.Set` con clave
  `currency_rate` (ARS por unidad).
- [x] Al cambiar moneda o cotización se recarga Ajustes para reformatear.
- [x] Al alternar ARS → USD/EUR se recupera la última cotización guardada, sin
  tener que volver a escribirla.
- [x] Aviso explícito: la contabilidad se guarda en centavos ARS y los
  formularios ingresan ARS.
- [x] Tests: `tests/money.test.ts` (ARS, USD, EUR, cotización inválida, redondeo).

### Verificación manual

- [x] Ajustes > Moneda: elegir USD con cotización 1000; Inicio/Reportes deben
  mostrar `US$` y dividir por 1000. Verificado en navegador con cotización 1250:
  un gasto de ARS 1.250 se muestra como `US$ 1,00`.
- [x] Volver a ARS: los importes vuelven a `$` sin perder datos.
- [x] Reiniciar la app: la moneda y la cotización persisten.
- [x] Alternar ARS → USD: la cotización guardada (1250) reaparece sola.
- [x] Confirmar que crear un gasto de ARS 1.000 sigue guardando 100000 centavos
  (no se convierte al ingresar).

### Pendiente / ideas

- [ ] Si se quiere ingresar importes en USD/EUR, hay que convertir en cada
  formulario (`parseMoneyToCents`) y decidir qué moneda tiene el CSV. No hacerlo
  a medias.
- [ ] Mostrar el equivalente en ARS junto al importe convertido (ej.
  `US$ 10,00 · ARS 10.000`).

---

## 3. Fase 2 — Idioma

### Implementado

- [x] Se quitó la opción `English` de Ajustes.
- [x] `main.ts` fuerza `setLanguage('es')`; aunque quede un `language=en`
  viejo en eventos, no se mezclan fechas en inglés con textos en español.
- [x] Ajustes muestra una nota: “La traducción al inglés todavía no está
  implementada”.

### Por qué no se tradujo todo ahora

`src/ui/views/*.ts` tiene cientos de strings en español, muchos dinámicos
(``Debe ${money(...)}` `, mensajes de validación, etc.). Una traducción parcial
sería peor que español consistente. La infraestructura (`src/core/i18n.ts`) ya
existe: `t(key)`, `getLanguage`, `setLanguage`.

### Plan para retomarlo

- [ ] Definir claves estables (ej. `nav.orders`, `settings.currency`) y cargar
  `dictionaries.es` / `dictionaries.en`.
- [ ] Empezar por el shell (`src/ui/app.ts`), navegación y títulos de vistas.
- [ ] Seguir por Ajustes, formularios y mensajes de error del dominio.
- [ ] Cambiar los labels dinámicos a `t()` con parámetros (o funciones por
  vista).
- [ ] Agregar test que falle si una clave usada no existe en `es`.
- [ ] Recién entonces volver a mostrar el selector English y recargar la vista
  al cambiar idioma.
- [ ] Fechas: `src/core/dates.ts` ya usa `getLanguage()` para el locale.

---

## 4. Fase 3 — Export JSON

### Implementado

- [x] Rust: `store_export_raw(root)` devuelve las líneas crudas de todos los
  dominios, sin descifrar. Registrado en `src-tauri/src/lib.rs`.
- [x] `TauriEventStore.exportAll()` usa `store_export_raw`; el bundle lleva los
  payloads cifrados y el `deviceId` de la instalación.
- [x] El modal de export en Ajustes distingue:
  - app nativa: “payloads cifrados tal como están en disco”;
  - navegador de desarrollo: “payloads DESCIFRADOS, no compartir”.
- [x] El import sigue funcionando: `store_append` detecta payloads ya cifrados y
  no los vuelve a cifrar.
- [x] `README.md` actualizado.

### Verificación manual

- [ ] Exportar en Tauri y abrir el `.json`: los `payload` deben tener
  `_encrypted: true`, `kid`, `data`, `nonce`; no debe verse el nombre de un
  cliente.
- [ ] Restaurar ese export en la misma bóveda: no debe duplicar eventos.
- [ ] Restaurar en otra instalación **con el mismo llavero**: debe leer los
  datos.
- [ ] Restaurar en otra instalación **sin el llavero**: debe fallar de forma
  clara (no importar basura ilegible). Si no falla, anotarlo como pendiente.

### Nota importante

Un export cifrado solo se puede leer con el **mismo llavero**. Si se exporta
desde una bóveda y se importa en otra con clave distinta, los eventos quedarán
ilegibles. Para portar datos entre claves distintas, usar “Exportar llavero” o
“Adoptar llavero” antes de importar.

---

## 5. Fase 4 — Backups pre-encryption

### Implementado

- [x] Rust: `crypto_backup_info(root)` lista `backups/pre-encryption-*` y suma
  bytes; `crypto_delete_backups(root)` las borra.
- [x] Ajustes > Cifrado (con cifrado activo): texto explicativo + botón
  “Revisar y borrar respaldos previos al cifrado”.
- [x] Confirmación con cantidad y tamaño; aclara que longlife no las incluye y
  que no se pueden recuperar.
- [x] Test Rust: `backup_info_and_delete_remove_plaintext_pre_encryption_copies`.
- [x] longlife sigue excluyendo `backups/` (no se copian en texto plano).
- [x] `writer.json` también se excluye del snapshot.

### Verificación manual

- [ ] Tras activar/rotar cifrado, el botón debe informar 1+ carpeta y bytes > 0.
- [ ] Borrar y confirmar que `omega/backups/` queda sin `pre-encryption-*`.
- [ ] Confirmar que los datos vivos siguen leyéndose y que longlife no cambió.
- [ ] No borrar estas copias hasta confirmar que la contraseña maestra abre la
  bóveda.

---

## 6. Fase 5 — Vaciar datos y longlife

### Implementado

- [x] `TauriEventStore.clearAll()` ejecuta `longlife_run({ refresh: true })`
  **antes** de `store_clear`. Si el snapshot falla, no se borra nada y se
  muestra el error.
- [x] Después de vaciar **no** se programa un snapshot: el refresco automático
  no debe reemplazar la copia del día con el estado vacío.
- [x] Rust `run_snapshot_refresh` tiene una guarda: si el snapshot existente
  tiene archivos y `omega/events` no tiene ningún `.jsonl`, devuelve
  `protected: true` y no toca la copia.
- [x] `LonglifeResult.protected` se muestra en la UI de Copias longlife.
- [x] “Regenerar desde cero” (`force: true`) sigue permitiendo reemplazar la
  copia de forma explícita.
- [x] Test Rust: `refresh_does_not_replace_a_non_empty_snapshot_with_empty_data`.
- [x] El modal de “Vaciar todos los datos” explica el snapshot previo.

### Verificación manual

- [ ] Con datos: Ajustes > Vaciar todos los datos.
- [ ] Ir a Copias longlife: la copia de hoy debe seguir teniendo los archivos
  previos (o la fecha anterior si el snapshot falló).
- [ ] Reiniciar la app con `omega` vacío: la copia del día no debe quedar
  vacía; el estado debe indicar que se protegió.
- [ ] Crear un dato nuevo después del vaciado y esperar el refresco: la copia
  del día puede actualizarse con el estado nuevo (comportamiento esperado).
- [ ] “Regenerar desde cero” debe poder crear una copia vacía si el usuario lo
  confirma.

### Caso límite conocido

Si se vacía y se vuelve a escribir el mismo día, el snapshot del día termina
reflejando el estado nuevo. La copia previa al vaciado no se conserva como
fecha separada. Si se necesita conservarla, antes de vaciar copiar
`longlife/YYYY-MM-DD/` a otra carpeta o a otra fecha.

---

## 7. Fase 6 — `device_id` y un solo escritor

### Implementado

- [x] Rust `installation_device_id` guarda el id en el directorio privado de la
  app (`installation_id`), no en `omega/`.
- [x] `main.ts` usa ese id para `App.deviceId`, `Device.Registered` y la
  metadata de eventos nuevos.
- [x] Al copiar la bóveda a otro equipo, el id local es distinto.
- [x] `omega/device_id` se conserva por compatibilidad, pero ya no define la
  identidad de la instalación.
- [x] Rust `writer_touch` escribe `omega/writer.json` con
  `{ deviceId, deviceName, seenAt }` y devuelve `conflict` si otro id tocó la
  bóveda en los últimos 10 minutos.
- [x] `main.ts` llama `writer_touch` al arrancar y cada 5 min; si hay conflicto,
  muestra un toast de advertencia.
- [x] Ajustes > Dispositivo explica que el id no viaja con la bóveda.
- [x] Tests Rust de detección de conflicto y writer stale.

### Verificación manual

- [ ] Abrir la bóveda en el equipo A; ver `omega/writer.json` con el id de A.
- [ ] Copiar la bóveda al equipo B (o simular otro id llamando
  `writer_touch` con un id distinto y `seenAt` reciente).
- [ ] Abrir en B: debe aparecer la advertencia de otro equipo.
- [ ] Dejar pasar > 10 minutos sin latido: la advertencia debe desaparecer.
- [ ] Confirmar que el `device_id` de la metadata de un evento nuevo es el de la
  instalación y no el de `omega/device_id`.

### Limitaciones

- [ ] El aviso no bloquea escrituras. Un lock real requeriría decidir qué hacer
  con Foldersync (archivos de lock sincronizados, latencia, falsos positivos) y
  probablemente un modo solo-lectura. No implementar sin diseño.
- [ ] `writer.json` se sincroniza con la bóveda si Foldersync copia `omega/`.
  Es intencional: sirve como señal, no como verdad absoluta.

---

## 8. Fase 7 — Prueba física pendiente (requiere teléfono)

> No se puede completar sin un teléfono Android real y una cuenta de
> Foldersync/Google Drive. Hacer esta fase al final, con la bóveda real
> respaldada.

### 8.1 Instalación de la APK de release

- [ ] Descargar el APK universal de `v0.2.12` desde GitHub Releases (o usar el
  que ya está en `Descargas/InventarioTienda/`).
- [ ] Verificar que la firma sea la de release (no debug). Si hay una build
  debug instalada con otra firma, desinstalarla primero; eso borra los datos
  locales de la app, **no** la bóveda.
- [ ] Instalar en el teléfono.
- [ ] Abrir la app, elegir una carpeta bóveda local (no la carpeta virtual de
  Google Drive), crear contraseña maestra y guardar el código de recuperación.
- [ ] Cerrar y reabrir: debe pedir desbloqueo.
- [ ] Probar desbloqueo con contraseña y con código de recuperación.
- [ ] Crear un producto/pedido de prueba, cerrar la app y reabrir: los datos
  deben seguir.

### 8.2 Longlife en el teléfono

- [ ] Ir a Copias longlife y verificar que existe `longlife/YYYY-MM-DD/` dentro
  de la bóveda elegida.
- [ ] Hacer un cambio, esperar ~3 minutos, y confirmar que el snapshot se
  actualiza.
- [ ] Pasar la app a segundo plano y confirmar el refresco.
- [ ] Borrar una copia longlife con doble confirmación; confirmar que `omega/`
  no se tocó.

### 8.3 Foldersync / Google Drive

- [ ] En el teléfono, configurar Foldersync para sincronizar la carpeta bóveda
  local con Drive (sincronización de archivos, no carpeta virtual).
- [ ] En la PC, elegir la carpeta local espejo de Drive como bóveda.
- [ ] Confirmar que ambos ven el mismo `omega/keys/keyring.json` y el mismo
  `kid` en Ajustes > Cifrado.
- [ ] **Un solo escritor:** cerrar la app en el teléfono antes de editar en la
  PC, y viceversa. Esperar a que Foldersync/Drive terminen en ambas direcciones.
- [ ] Crear un dato en la PC, esperar la sincronización, abrir en el teléfono y
  confirmar que aparece.
- [ ] Crear un dato en el teléfono, esperar, abrir en la PC y confirmar.
- [ ] Verificar que `longlife` también se sincroniza (o documentar si se
  excluye de Foldersync).
- [ ] Probar el aviso de `writer.json`: abrir en un equipo y, antes de 10
  minutos, abrir en el otro; debe advertir.

### 8.4 Registro de resultados

| Prueba | Fecha | Dispositivo | Resultado | Notas |
|---|---|---|---|---|
| Instalar APK release | | | | |
| Desbloqueo con contraseña | | | | |
| Desbloqueo con código | | | | |
| Persistencia tras reinicio | | | | |
| Longlife diario | | | | |
| Foldersync subida | | | | |
| Foldersync bajada | | | | |
| Aviso de dos escritores | | | | |
| Export cifrado + import | | | | |

### 8.5 Problemas conocidos a vigilar

- Si Android muestra una carpeta virtual de Drive, **no** elegirla como bóveda:
  la app necesita archivos reales.
- Si Foldersync reemplaza archivos, las dos copias convergen a una sola
  versión; no hay merge automático de `.jsonl`.
- Si una build debug y una release conviven, la firma cambia y Android no
  actualiza: desinstalar primero.
- El APK se guarda en `Descargas/InventarioTienda/`; la instalación es manual.

---

## 9. Comandos de verificación (sin internet)

```bash
# Estado del árbol
git status --short
git diff --stat

# Frontend
npm run typecheck
npm test

# Rust
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml

# Build de escritorio (si el entorno lo permite)
npm run build
npx tauri build --no-bundle

# Android (requiere SDK/NDK y JDK local)
# JAVA_HOME=/tmp/opencode/jdk npx tauri android build --debug --apk --target aarch64
```

Resultados de esta tanda:

- `npm run typecheck`: OK.
- `npm test`: 58 tests OK (se agregaron 5 de moneda).
- `cargo test`: 60 pass, 1 ignored, 0 failed.
- `cargo check`: OK.

---

## 10. Cómo retomar si se corta internet

1. Leer este documento completo y `docs/PROGRESO.md` sección 10.
2. `git status --short` para ver qué quedó sin commitear.
3. Buscar el primer `[ ]` de la fase que se estaba haciendo.
4. Ejecutar `npm run typecheck` y `npm test` antes de seguir.
5. Si se tocó Rust, ejecutar `cargo test` antes de compilar la APK.
6. No borrar `docs/KEYSTORES.md`, `scripts/sign-local.sh`,
   `scripts/verify-signing.sh` (untracked del usuario).
7. Para la prueba física, usar una bóveda de prueba y no la real; si se usa la
   real, copiarla antes.

---

## 11. Rollback de esta tanda

- Los cambios son de código y documentación; no migran datos de forma
  destructiva.
- `device_id`: los eventos viejos conservan el id anterior; los nuevos usan el
  id de instalación. No hay que migrar nada.
- `writer.json` es nuevo y se puede borrar sin afectar datos.
- Si el export cifrado diera problemas, se puede volver temporalmente a
  `readAll()` en `TauriEventStore.exportAll()` y corregir el mensaje, pero
  avisar que el export queda descifrado.
- Si la guarda de longlife molestara, se puede quitar el bloque `protected` de
  `run_snapshot_refresh`, pero se pierde la protección al vaciar datos.

---

## 12. Release v0.2.13

- Versión de la app: `0.2.13`.
- Android: `versionName=0.2.13`, `versionCode=2013`.
- Tag/release: `v0.2.13`.
- Incluye las seis correcciones de esta checklist, el arreglo de la cotización
  al alternar ARS → USD/EUR y la documentación de continuidad.
- El workflow de release publica APK universal, AAB, AppImage, `.deb`, MSI,
  NSIS y `latest.json` firmado.
- Pendiente después del release: instalar la APK en un teléfono físico y probar
  Foldersync/Drive (sección 7).
