# Robustez de sincronización externa — checklist de continuidad

> **Base:** `v0.2.13` (`91d61d4`), rama `main`.
> **Objetivo:** que los agentes de sincronización externos no puedan borrar
> eventos de la bóveda, y que la app detecte y repare sola una pérdida.
> **Última actualización:** 2026-10-28.
> **Uso:** este documento es la fuente de verdad. Si se corta la sesión o el
> internet, retomar por el primer `[ ]` de la fase en curso. No borrar las
> decisiones: explican por qué el código quedó así.

Convenciones: `[x]` hecho y verificado · `[~]` parcial · `[ ]` pendiente.

---

## 0. Síntoma que se está corrigiendo

Secuencia observada:

1. Se edita en el teléfono y el agente de sincronización sube la bóveda al proveedor de nube.
2. En la PC, el proveedor de nube reemplaza `omega/events/*.jsonl` con la versión del teléfono.
3. La app de la PC (o del teléfono) tenía una copia vieja en memoria / en el
   índice SAF y, en la siguiente escritura, reescribió el archivo completo con
   esa copia vieja + el evento nuevo.
4. La siguiente sincronización subió el archivo clobbered y los eventos que
   venían del proveedor de nube desaparecieron.

Causas concretas en `v0.2.13`:

- `SafCtx::append_bytes` (`src-tauri/src/storage.rs`) hacía
  **leer archivo completo → agregar → reescribir archivo completo**. No es un
  append real.
- `SafCtx::files` cacheaba los `FilePath` SAF y solo refrescaba si la ruta no
  existía. Un reemplazo externo (borrar + crear documento) dejaba URIs viejas.
- `mtime_ms` devolvía `None` en SAF, así que `store_mtimes` devolvía `{}` y el
  poller de `TauriEventStore` no detectaba cambios externos en Android.
- `App.reloadDomain` aplicaba los eventos del dominio sobre el estado actual;
  como `appliedEventIds` nunca se limpiaba, los eventos que desaparecían del
  archivo seguían visibles en memoria y ocultaban la pérdida.
- Las reescrituras completas de las migraciones de cifrado
  (`crypto::migrate_files`) podían pisar cambios externos concurrentes.
- `writer.json` era solo un aviso; no bloqueaba ni fusionaba.

---

## 1. Estrategia (por capas)

| Capa | Qué hace | Estado |
|---|---|---|
| 1. Diario local (WAL) | Guarda fuera de la bóveda cada evento escrito. Si el archivo pierde eventos, los vuelve a agregar. | `[x]` |
| 2. Fusionar copias de conflicto | Lee `events/<dominio> (*).jsonl` y `events/<dominio>.*.jsonl`, no solo el canónico. | `[x]` |
| 3. Append real en Android | Abre el documento SAF con modo `"wa"` (append) en vez de leer + reescribir. Refresca el índice antes de escribir. | `[x]` |
| 4. Huellas y reconciliación | Detecta cambios externos por tamaño + mtime (también en SAF) y reconstruye el estado desde cero. | `[x]` |
| 5. Reescrituras seguras | Migraciones de cifrado con verificación y sin pisar cambios externos. | `[x]` |
| 6. UX y configuración | Botón "Verificar/Reparar bóveda", avisos y guía de sincronización externa. | `[~]` |

La capa 1 es la red de seguridad: aunque las demás fallen, un evento perdido se
recupera. La capa 2 evita perder eventos cuando el agente crea una copia de
conflicto. La capa 3 elimina la causa en Android. La capa 4 hace visible la
pérdida y reconstruye la UI. La capa 5 protege las operaciones destructivas.

---

## 2. Fase 0 — Línea base (HECHA)

- [x] `git status --short` limpio.
- [x] `npm run typecheck` en verde.
- [x] `npm test` — 58 tests.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` — 60 pass, 1 ignored.
- [x] Crear este documento.

Comandos de verificación que se repiten al final de cada fase:

```bash
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

---

## 3. Fase 1 — Diario local (WAL) y reparación

### Diseño

- Directorio: `<app_data>/journal/<hash-de-la-bóveda>/<dominio>.jsonl`.
  Fuera de la bóveda, así el agente de sync no lo toca.
- Cada línea: `{"at": <ms>, "kid": "<huella>"|null, "line": <evento>}`.
  `line` es el evento **ya cifrado** tal como se escribió en la bóveda.
- `store_append` escribe el diario **antes** del append a la bóveda (WAL).
  Si el append falla, el diario queda y la reparación lo reintenta.
- `journal_repair`:
  1. Lee los `id` presentes en todos los `.jsonl` de la bóveda (sin descifrar).
  2. Para cada entrada del diario cuyo `id` no está: la re-agrega.
  3. Descarta entradas confirmadas con más de 48 h; conserva las recientes
     como red de seguridad.
  4. Las entradas cifradas con otro `kid` no se re-agregan: se reportan como
     `stale` (recuperables desde longlife / historial del proveedor de nube).
- `store_clear` limpia el diario **antes** de borrar los eventos, para que
  "Vaciar datos" no resucite nada.
- Tras una migración de cifrado exitosa se limpia el diario: la bóveda ya fue
  reescrita y respaldada, y las líneas viejas ya no son compatibles.

### Archivos

- [x] `src-tauri/src/journal.rs` (nuevo).
- [x] `src-tauri/src/event_store.rs`: `domain_files`, `append_payload`,
      `all_event_ids`, `store_fingerprints`, `store_clear` con diario.
- [x] `src-tauri/src/storage.rs`: exponer `app_handle` para resolver app data.
- [x] `src-tauri/src/lib.rs`: comandos `journal_repair`, `journal_status`,
      `journal_clear`; `store_append`/`store_clear` con `AppHandle`.
- [x] `src-tauri/src/crypto.rs`: limpiar diario tras migración exitosa.
- [x] `src/store/EventStore.ts`: `repair()` en la interfaz + `RepairReport`.
- [x] `src/store/TauriEventStore.ts`: implementar `repair()`.
- [x] `src/store/WebEventStore.ts`: `repair()` no-op.
- [x] `src/app/App.ts`: `reloadAll()` con reconstrucción desde cero.

### Tests

- [x] Rust: diario escribe/lee/repara en un directorio temporal.
- [x] Rust: una entrada confirmada vieja se descarta; una reciente se conserva.
- [x] Rust: una entrada con `kid` distinto no se re-agrega.
- [x] TS: `repair()` no-op en `WebEventStore`/`MemoryEventStore`.

### Verificación manual

- [ ] Escribir un evento, borrar su línea del `.jsonl` a mano, reiniciar la
      app: el evento vuelve y aparece un aviso de reparación.

---

## 4. Fase 2 — Copias de conflicto y huellas

### Diseño

- `store_read` lee todos los archivos del dominio:
  - `events/<dominio>.jsonl`
  - `events/<dominio> (*).jsonl` (copia de conflicto del agente)
  - `events/<dominio>.*.jsonl` (futuros archivos por dispositivo/sesión)
- `store_fingerprints` devuelve por dominio `{size, mtime}` agregados
  (suma de tamaños, mtime máximo). En SAF, el mtime se obtiene abriendo el
  descriptor con `api.open_file` y leyendo `metadata()`.
- El poller compara huellas, no timestamps. Si un dominio cambia o desaparece:
  1. llama a `repair()`,
  2. reconstruye todo el estado (`reloadAll`),
  3. avisa si se recuperaron eventos.

### Archivos

- [x] `src-tauri/src/storage.rs`: `FileFingerprint`, `fingerprint()` y
      `mtime_ms` para SAF.
- [x] `src-tauri/src/event_store.rs`: `store_fingerprints`.
- [x] `src/store/TauriEventStore.ts`: poller por huellas + `repair()` previo.
- [x] `src/app/App.ts`: `reloadAll` con debounce/cola.

### Tests

- [x] Rust: fingerprint local detecta cambio de tamaño y desaparición
      (`event_store::tests::fingerprints_aggregate_size_and_mtime_of_conflict_copies`).
- [~] TS: la lógica del poller no se aisló; se verificó por typecheck/build y
      prueba manual. El no-op de `repair()` sí tiene test.

---

## 5. Fase 3 — Append real en Android

### Diseño

- Puente JNI en `src-tauri/src/android_fs.rs`:
  `append_saf_file(uri, bytes)` llama a
  `ContentResolver.openAssetFileDescriptor(uri, "wa")`, obtiene el fd y escribe.
- `SafCtx::append_bytes`:
  1. refresca el índice SAF (para no usar un `FilePath` viejo),
  2. si el archivo no existe, lo crea con el contenido,
  3. si existe, usa el append real.
- Si el documento fue reemplazado y la URI vieja ya no existe, el append falla
  (no pisa nada); el diario lo repara en la próxima pasada.

### Archivos

- [x] `src-tauri/src/android_fs.rs`: `append_saf_file`.
- [x] `src-tauri/src/storage.rs`: `SafCtx::append_bytes` + refresco previo.

### Verificación

- [x] `cargo check` en escritorio (el módulo Android está bajo `cfg`).
- [x] Cross-check Android con el NDK instalado:

```bash
NDK=$HOME/Android/Sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/linux-x86_64/bin
export CC_aarch64_linux_android=$NDK/aarch64-linux-android21-clang
export AR_aarch64_linux_android=$NDK/llvm-ar
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$NDK/aarch64-linux-android21-clang
cargo check --manifest-path src-tauri/Cargo.toml --target aarch64-linux-android
```

- [ ] Prueba física: editar en Android con el agente de sincronización corriendo; confirmar que
      el archivo conserva las líneas anteriores. **Pendiente: requiere
      dispositivo.**

---

## 6. Fase 4 — Reescrituras seguras

### Diseño

- `crypto::migrate_files`: captura `storage::fingerprint` antes de leer cada
  archivo y lo compara después de transformarlo, antes de escribir. Si cambió
  (un agente de sincronización externo lo reemplazó), aborta sin sobrescribirlo.
- La versión externa se guarda como copia de conflicto
  `events/<dominio>.external-<timestamp>.jsonl`; `store_read` ya la fusiona.
- `crypto::restore_events`: antes de restaurar el respaldo, si el archivo
  actual difiere, lo preserva como `events/<dominio>.restore-<timestamp>.jsonl`.
  Así una reversión de migración tampoco pisa un cambio externo.
- `store_clear`: ya limpia el diario antes de borrar, bajo el lock.
- `writer.json`: se mantiene como aviso; la protección real es el diario + la
  reconciliación.

### Limitaciones conocidas

- La ventana entre la verificación y `write_atomic` es de milisegundos; un
  agente que escriba justo ahí todavía podría ganar. El respaldo previo y
  longlife siguen siendo la red de seguridad.
- Si un agente toca el archivo sin cambiar el contenido (solo mtime), la
  migración aborta por precaución. Se puede reintentar con el sync en pausa.
- Un cambio externo **después** de que la migración escribió el archivo puede
  dejar líneas con `kid` viejo; la verificación posterior lo detecta y reporta
  el respaldo, pero no re-migra automáticamente.
- Las copias `events/<dominio>.external-*` y `events/<dominio>.restore-*` se
  pueden borrar cuando ya no se necesiten. Mientras existan, la app las lee y
  deduplica por `id`.

### Archivos

- [x] `src-tauri/src/crypto.rs`.
- [x] `src-tauri/src/event_store.rs` (el `store_clear` con lock ya estaba).

### Verificación

- [x] Test Rust: `crypto::tests::migrate_files_aborts_and_preserves_an_external_change`.
- [x] Test Rust: `crypto::tests::restore_events_reverts_to_the_backup_copy`
      ahora también comprueba la copia `*.restore-*`.

---

## 7. Fase 5 — UX y configuración

- [x] Ajustes > Respaldo: botón **"Verificar/Reparar bóveda"** que llama a
      `repair()` y muestra `repaired / pending / stale`.
- [x] Botón **"Descartar diario local"**: actualiza la copia longlife del día
      y borra el diario. Es el paso previo obligatorio para restaurar una
      copia longlife manualmente; si no, la reparación de arranque volvería a
      agregar los eventos posteriores a la copia.
- [x] Aviso al arrancar si `repair()` recuperó eventos (`startupNotice` en
      `App`, toast `status` en `src/ui/app.ts`).
- [~] Tarjeta "Salud de la bóveda" con una explicación breve. Falta la guía
      detallada de sincronización externa (sync bidireccional con copias de
      conflicto, **no** espejo/reemplazo; excluir `longlife`; no usar una
      carpeta virtual del proveedor de nube en Android; un solo equipo escribe
      a la vez).
- [ ] Actualizar `README.md` y `docs/LIMITACIONES_CHECKLIST.md`.

---

## 7.5 Fase 6 — Snapshots por dispositivo y restauración desde la app

### Diseño

- Cada instalación guarda sus copias en
  `<bóveda>/longlife/<dispositivo>/<YYYY-MM-DD>/`.
  El `<dispositivo>` sale de `writer::installation_device_id` (guardado en el
  directorio privado de la app, fuera de la bóveda). Si el ID no es seguro
  para una carpeta, se usa `device-<sha256[..16]>`.
- Las copias anteriores a esta fase, en `<bóveda>/longlife/<YYYY-MM-DD>/`, se
  siguen leyendo y restaurando como **"Copia anterior"** (`deviceId: null`).
  No se podan automáticamente para no borrar datos del usuario.
- El nombre legible del dispositivo se guarda desde `writer_touch` en
  `installation_name` (directorio privado). Si todavía no existe, se usa un
  nombre por plataforma (`Celular Android`, `Linux`, etc.).
- El manifiesto pasa a versión 2 con campos opcionales `deviceId`,
  `deviceName` y `kind` (`daily`, `pre-restore`, `legacy`). Los manifiestos
  v1 siguen parseando.
- Se conservan **7 fechas diarias por dispositivo** y **3 copias
  `pre-restore-*` por dispositivo**. Las copias legacy no se podan.
- La restauración desde la app sigue este orden:
  1. Validar el manifiesto y **todos** los hashes/tamaños de la copia.
  2. Reparar el diario para que la copia previa capture lo recuperable.
  3. Tomar una copia `pre-restore-<timestamp>` del estado actual, bajo el
     dispositivo actual (aunque la copia restaurada sea de otro dispositivo).
  4. Limpiar el diario bajo `EVENTS_WRITE_LOCK`.
  5. Reemplazar el contenido de `omega`: se eliminan los archivos que no
     están en la copia, salvo `backups/` y `.keep-*`; se quita
     `writer.json`; se escriben los archivos validados.
  6. Borrar la clave en memoria. La UI recarga y pide desbloquear con el
     llavero restaurado (o configurar cifrado si la copia no tenía llavero).
- Los pasos 2 a 5 van bajo el mismo `EVENTS_WRITE_LOCK`: ningún append local
  puede colarse entre la reparación, la copia previa y la limpieza del diario.
  La restauración también toma `SNAPSHOT_LOCK`, así que no compite con una
  copia automática.
- La validación rechaza rutas absolutas, `..`, duplicados, archivos fuera del
  snapshot (`backups/`, `manifest.json`, `writer.json`, `.keep-*`) y hashes
  alterados. Durante la escritura se vuelve a verificar cada archivo.
- La UI agrupa las copias por dispositivo, marca "Este dispositivo", muestra
  si están cifradas y ofrece un botón **Restaurar** con dos confirmaciones.
  Después de restaurar, la app se bloquea y se recarga.

### Limitaciones conocidas

- La validación lee la copia dos veces (validar y escribir). Es deliberado:
  evita tocar `omega` si una copia está corrupta.
- Queda una ventana mínima entre la validación y la escritura si un agente
  externo modifica `longlife/` en ese instante. La copia `pre-restore-*`
  permite volver atrás.
- El reemplazo de `omega` no es transaccional: si falla a mitad de la
  escritura (disco lleno, SAF desconectado), `omega` puede quedar parcial.
  La copia `pre-restore-*` se crea antes y permite recuperar el estado
  anterior.
- Si la reparación previa deja entradas `pending` o `stale` en el diario, la
  restauración avisa cuántas son, pero al limpiar el diario no se pueden
  recuperar desde la copia previa (no estaban en `omega`).
- Las copias `pre-restore-*` y los `*.external-*`/`*.restore-*` de las
  migraciones pueden acumularse; las primeras se podan a 3 por dispositivo.
  Una ventana de gracia de 10 minutos protege la copia recién creada aunque el
  reloj esté atrasado, así que puede haber 4 temporalmente.
- El botón "Borrar todas las copias longlife" sigue borrando **todos** los
  dispositivos. No hay borrado por dispositivo.
- La restauración en Android/SAF está implementada con las mismas primitivas
  que el resto de la app, pero **falta la prueba física** en un dispositivo.

### Archivos

- `src-tauri/src/backup.rs`: layout por dispositivo, manifiesto v2, listado
  agrupable, validación y restauración.
- `src-tauri/src/writer.rs`: nombre de instalación persistido, nombre por
  defecto, `writer_touch` con `AppHandle`.
- `src-tauri/src/lib.rs`: registro de `longlife_restore`.
- `src/ui/views/settingsBackup.ts`: lista por dispositivo, estado, botón
  Restaurar, doble confirmación y recarga/bloqueo.
- `docs/SYNC_ROBUSTNESS_CHECKLIST.md`: esta sección.

### Tests

- `backup::tests::snapshots_of_two_devices_do_not_overwrite_each_other`.
- `backup::tests::lists_legacy_and_per_device_snapshots`.
- `backup::tests::restore_replaces_omega_and_keeps_a_pre_restore_snapshot`.
- `backup::tests::restore_legacy_snapshot_works_without_device`.
- `backup::tests::restore_rejects_a_corrupted_snapshot`.
- `backup::tests::restore_rejects_path_traversal_and_missing_manifests`.
- `backup::tests::prunes_old_pre_restore_snapshots_per_device`.
- `backup::tests::restoring_an_old_pre_restore_copy_does_not_prune_it_before_reading`.
- Tests existentes de snapshot/refresh adaptados a
  `longlife/<dispositivo>/<fecha>/`.

### Verificación

```bash
npm run typecheck
npm test
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
```

---

## 8. Decisiones y notas

- **Por qué el diario guarda la línea cifrada y no el payload:** mantiene la
  misma garantía de cifrado en reposo; la app no escribe texto plano fuera de
  la bóveda.
- **Por qué no se implementó todavía "un archivo por dispositivo":** el diario
  + la fusión de copias de conflicto ya evitan la pérdida. El layout por
  dispositivo queda como endurecimiento opcional; requiere migrar
  `crypto::jsonl_files`, los tests que leen `events/<dominio>.jsonl` y el
  export. Ver §9.
- **Rotación de clave:** las entradas del diario con `kid` viejo no se
  re-agregan. Se limpian tras una migración exitosa. Si se perdió un evento
  justo en ese intervalo, queda el respaldo `omega/backups/pre-encryption-*` y
  longlife.
- **`longlife`:** es la copia diaria, ahora separada por dispositivo. El
  diario es para la ventana entre sincronizaciones, no un reemplazo del
  backup. Restaurar desde la app es deliberado: valida, guarda una copia
  previa, limpia el diario y bloquea la app.

---

## 9. Pendiente opcional (no bloquea la corrección)

- [ ] Layout `events/<dominio>/<deviceId>-<sessionId>.jsonl` con merge en
      lectura. Ventaja: cada equipo escribe solo su archivo y el agente no
      puede borrar el de otro. Requiere:
      - `store_append` con `device_id`/`session_id`,
      - `domain_files` recursivo,
      - `crypto::jsonl_files` recursivo,
      - actualizar tests que leen la ruta canónica,
      - compactación periódica para no acumular archivos.
- [ ] Lock distribuido real (más allá del aviso `writer.json`).
- [ ] "Modo sincronización" que ponga la bóveda en solo lectura mientras el
      agente corre.

---

## 9.5 Estado de la implementación (2026-10-28)

Verificado en esta sesión:

```text
npm run typecheck                         OK
npm test                                  59 passed (6 files)
cargo test --manifest-path ...            77 passed, 1 ignored
npm run build                             OK
cargo check --target aarch64-linux-android OK (con NDK 27)
```

Cambios principales ya aplicados:

- `src-tauri/src/journal.rs`: WAL, reparación, estado y limpieza.
- `src-tauri/src/event_store.rs`: merge de copias de conflicto, huellas
  (un solo listado de `events/`), `all_event_ids`, append con WAL,
  `store_clear` con diario y lock, `append_payload_locked` para que la
  reparación sea atómica respecto del vaciado, tests nuevos.
- `src-tauri/src/storage.rs`: `FileFingerprint`, `fingerprint()`, mtime SAF,
  TTL del índice SAF, `refresh_index`, append real en Android.
- `src-tauri/src/android_fs.rs`: `append_saf_file` por JNI (`"wa"`).
- `src-tauri/src/crypto.rs`: limpieza del diario tras migraciones; append
  interno sin re-cifrar; migraciones con fingerprint antes/después y copias de
  conflicto `*.external-*`; `restore_events` preserva `*.restore-*` antes de
  pisar un archivo cambiado.
- `src-tauri/src/lib.rs`: módulo y comandos nuevos.
- `src/store/EventStore.ts`, `TauriEventStore.ts`, `WebEventStore.ts`:
  `repair()`, poller por huellas, no-ops para OPFS/memoria.
- `src/app/App.ts`: `reloadAll()` con reconstrucción total y aviso de
  reparación.
- `src/ui/app.ts`: toast de `status` y aviso de arranque.
- `src/ui/views/settingsBackup.ts`: tarjeta "Salud de la bóveda", botón
  "Verificar/Reparar bóveda" y botón "Descartar diario local" (con copia
  longlife previa) para restaurar una copia sin que el diario la pise.
  Además: lista de copias agrupada por dispositivo, estado por dispositivo,
  botón **Restaurar** con doble confirmación y recarga/bloqueo.
- `src-tauri/src/backup.rs`: snapshots en
  `longlife/<dispositivo>/<fecha>/`, manifiesto v2, copias
  `pre-restore-*`, validación de hashes y `longlife_restore`.
- `src-tauri/src/writer.rs`: nombre de instalación persistido
  (`installation_name`), nombre por defecto y `writer_touch` con `AppHandle`.
- `tests/store.test.ts`: test de `repair()` no-op.

Pendientes reales (no bloquean el uso diario):

1. Prueba física en Android con un agente de sincronización externo.
2. Guía detallada de sincronización externa (`README.md` y
   `docs/LIMITACIONES_CHECKLIST.md` ya actualizados).
3. Layout por dispositivo/sesión (§9), opcional.

> Cambios incluidos en el release `v0.3.0`, sobre la base `v0.2.13`
> (`91d61d4`).

## 10. Cómo retomar después de un corte

1. `git status --short` y `git log --oneline -5`.
2. Abrir este documento y buscar el primer `[ ]`.
3. Si el corte fue a mitad de una edición, correr los comandos de verificación
   de §2 antes de seguir.
4. No mezclar fases: terminar y verificar una antes de empezar la siguiente.
5. Si hay que revertir: `git diff` primero; no usar `git checkout -- .` sin
   revisar cambios del usuario.

### Comandos útiles

```bash
# Solo Rust
cargo test --manifest-path src-tauri/Cargo.toml journal

# Solo TypeScript
npx vitest run tests/store.test.ts

# Ver el diario local (Linux)
find ~/.local/share/com.inventariotienda.app/journal -type f -maxdepth 3 2>/dev/null
```
