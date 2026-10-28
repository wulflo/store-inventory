# Refactor: bóveda elegida por el usuario + longlife + cifrado obligatorio

> **Estado:** implementado y verificado en emulador Android; release v0.2.12
> **publicado**. Este documento es la fuente de verdad para retomar el trabajo
> si se corta la conexión, la sesión o el build.
>
> **Continuidad 2026-10-28:** las limitaciones posteriores a v0.2.12 están en
> `docs/LIMITACIONES_CHECKLIST.md`.
>
> Última actualización: 2026-10-28

## 1. Objetivo

1. Eliminar por completo la sincronización LAN/P2P/WiFi.
2. En Android (y escritorio), el usuario elige una **carpeta bóveda**.
3. Los datos de la app viven en `<bóveda>/omega` y la app lee/escribe ahí.
4. Se guarda una copia en `<bóveda>/longlife/YYYY-MM-DD/`; la del día se
   refresca tras los cambios, al pasar a segundo plano, al cerrar y cada 24 h.
5. Se conservan solo **7 copias** diarias (rotación automática).
6. La app **no lee** `longlife` automáticamente. Solo si el usuario mueve una
   copia a `omega` a mano.
7. Menú de alto riesgo para **borrar todas las copias longlife**.
8. El cifrado se configura **obligatoriamente al arrancar** (estilo KeePass).
9. La contraseña debe abrir los datos en otro dispositivo con el mismo
   algoritmo/llavero.
10. Arreglar la descarga/instalación del APK en Android, tomando como
    referencia `SinNotas`.

## 2. Decisiones de arquitectura (no cambiar sin registrar el motivo)

- **Primitivas estándar:** Argon2id + XChaCha20-Poly1305 + llavero envuelto.
  No inventar formatos propietarios. No afirmar compatibilidad con VeraCrypt:
  VeraCrypt cifra contenedores completos, no JSONL a nivel de evento. Lo
  portable es el **llavero** (`keyring.json`) y el algoritmo documentado.
- **Raíz de datos:** `<bóveda>/omega`. Todos los comandos que hoy reciben
  `root` reciben la raíz de datos (`omega`).
- **Bóveda:** `<bóveda>` se guarda aparte, en el directorio privado de la app
  (`vault.json`), nunca dentro de `omega` (para no mezclar configuración con
  datos).
- **Android SAF:** usar `tauri-plugin-android-fs` 2.x (ya cacheado y probado en
  `SinNotas`). `DirPath` se serializa como JSON
  `{ "topTreeUri": "...", "relativeTerms": ["omega"] }` y se usa como `root`.
- **Escritorio:** `root` es una ruta normal; `<bóveda>/omega`.
- **Capas:**
  - `storage.rs`: operaciones de archivos abstractas (local vs SAF).
  - `vault.rs`: elegir/recordar/verificar la bóveda y derivar `omega`.
  - `event_store.rs`, `keys.rs`, `crypto.rs`: usan `storage.rs` (nada de
    `std::fs` directo salvo en `storage.rs` y tests locales).
  - `backup.rs`: se reemplaza por `longlife` (copia de `omega` a
    `<bóveda>/longlife/<fecha>`).
- **Cifrado obligatorio:** al arrancar:
  - Sin bóveda → pantalla para elegir carpeta.
  - Bóveda sin llavero → pantalla para crear contraseña maestra (y mostrar
    código de recuperación una vez).
  - Bóveda con llavero → pantalla de desbloqueo.
  - No hay modo texto plano en la UI nueva.
- **Actualizador Android:** descargar con `reqwest` en Rust (ya existe) pero
  guardar el APK con el storage público del plugin Android FS
  (`PublicGeneralPurposeDir::Download`) en `Descargas/InventarioTienda/`.
  Evitar depender del JNI `Downloads.kt` como camino principal. En Android usar
  `tls_certs_only` con `webpki-root-certs` para no necesitar la inicialización
  JNI de `rustls-platform-verifier`.

## 3. Estado por etapas

### Etapa 0 — Análisis (HECHA)

- [x] Relevar sync LAN/P2P/WiFi y todo su surface.
- [x] Relevar bóveda/backup/cifrado/updater actuales.
- [x] Revisar implementación de referencia `SinNotas`.
- [x] Confirmar que `tauri-plugin-android-fs-2.0.1` está cacheado.

### Etapa 1 — Checklist y documentación (HECHA)

- [x] Crear este documento.

### Etapa 2 — Quitar sync LAN/P2P/WiFi (HECHA)

- [x] Borrar `src-tauri/src/sync/` completo.
- [x] Borrar `src/sync/autoSync.ts`.
- [x] Borrar `src/ui/views/settingsSync.ts`.
- [x] Borrar `src/ui/views/settingsAutoSync.ts`.
- [x] Borrar `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Multicast.kt`.
- [x] Quitar `mod sync;` y comandos `sync_*` de `src-tauri/src/lib.rs`.
- [x] Quitar `SyncManager`, `PairingStart`, `sync_auto_get/set`, `battery_status`.
- [x] Quitar imports/arranque de sync en `src/main.ts`.
- [x] Quitar tarjetas de sync de `src/ui/views/settings.ts`.
- [x] Quitar `onStoreAppended` de `src/store/TauriEventStore.ts`.
- [x] Quitar permisos LAN del `AndroidManifest.xml`
      (`ACCESS_WIFI_STATE`, `ACCESS_NETWORK_STATE`,
      `CHANGE_WIFI_MULTICAST_STATE`).
- [x] Quitar de `Cargo.toml`: `rustls`, `rustls-pki-types`, `rcgen`,
      `tokio-rustls`, `if-addrs`. Conservar `tokio` solo si lo usa el updater.
- [x] Buscar referencias residuales:
      `grep -R "sync\|Multicast\|pairing\|discovery" src src-tauri/src`.

### Etapa 3 — Storage abstracto (HECHA)

- [x] Crear `src-tauri/src/storage.rs`.
- [x] Operaciones mínimas:
      `read_bytes`, `read_string`, `write_bytes`, `write_atomic`,
      `append_bytes`, `exists`, `create_dir_all`, `list_dir`,
      `list_files_recursive`, `remove_file`, `remove_dir_all`, `rename`,
      `mtime_ms`, `root_parent`.
- [x] Implementación local (`std::fs`) y SAF (`tauri-plugin-android-fs`).
- [x] Detectar SAF por `root` que empieza con `{` y contiene `topTreeUri`.
- [x] Cachear índice SAF (`BTreeMap<String, FilePath>` + `DirPath`s).
- [x] Registrar `AppHandle` global para SAF (`storage::init_app`).
- [x] Tests unitarios de normalización de rutas y local storage.

### Etapa 4 — Bóveda elegida por el usuario (HECHA)

- [x] Crear `src-tauri/src/vault.rs`.
- [x] `vault.json` en `app_data_dir`:
      `{ kind, vault_root, data_root, vault_name }`.
- [x] `vault_pick`:
  - Android: `show_open_dir_dialog()` + `grant_persistable_dir_access(ReadAndWrite)`.
  - Escritorio: `blocking_pick_folder()`.
  - Crear `<bóveda>/omega` y `<bóveda>/longlife`.
  - Guardar config y devolver `data_root`.
- [x] `vault_status`: configurada/accesible + `data_root` + nombre visible.
- [x] `vault_clear`: borrar config (no borrar datos).
- [x] `store_default_root` devuelve `vault_status.data_root`.
- [x] `tauri-plugin-android-fs` en `Cargo.toml` + `.plugin(init_android_fs())`.

### Etapa 5 — Migrar event_store/keys/crypto a storage (HECHA)

- [x] `event_store.rs`: reemplazar `std::fs` por `storage::*`.
- [x] `keys.rs`: persistencia del llavero vía storage (sin `std::fs`).
- [x] `crypto.rs`: migración, respaldo previo, verificación y restore vía storage.
- [x] Rutas internas sin cambios: `events/<dominio>.jsonl`, `keys/keyring.json`,
      `device_id`, `settings.json`.
- [x] `resolve_key`: error `ENC_NOT_SETUP:` si no hay llavero (cifrado
      obligatorio). Ajustar tests que escribían antes de activar.
- [x] Tests Rust existentes en verde.

### Etapa 6 — Longlife (HECHA)

- [x] Reescribir `backup.rs` como longlife:
  - [x] `longlife_status`.
  - [x] `longlife_run` (idempotente por día, `force` y `refresh` opcionales).
  - [x] `longlife_list`.
  - [x] `longlife_delete` (borra todo `longlife/`).
- [x] Copiar `omega` completo a `longlife/YYYY-MM-DD/` (excluir `backups/` y
      temporales).
- [x] `manifest.json` con fecha, archivos, bytes y sha256.
- [x] Retención: conservar las 7 fechas más recientes.
- [x] Disparo al arrancar + intervalo de 24 h.
- [x] Refresco de la copia del día con debounce de 3 minutos tras cambios
      locales, al pasar a segundo plano y al cerrar.
- [x] El refresco compara hashes y solo reescribe archivos modificados; no
      borra el snapshot antes de copiar.
- [x] NO leer longlife automáticamente. Eliminar `backup_pull_from_vault`.

### Etapa 7 — Cifrado obligatorio al arrancar (HECHA)

- [x] Nueva pantalla `src/ui/views/vaultSetup.ts` (elegir bóveda).
- [x] Nueva pantalla `src/ui/views/cryptoSetup.ts` (crear contraseña).
- [x] Reutilizar `unlock.ts` para bóveda con llavero.
- [x] `main.ts`: bóveda → estado crypto → setup/unlock → app.
- [x] Mostrar código de recuperación una sola vez.
- [x] Textos de `settingsCrypto.ts` sin referencias a sync.
- [x] Mantener exportar/importar/adoptar llavero como herramientas de
      portabilidad.

### Etapa 8 — UI de ajustes (HECHA)

- [x] Quitar tarjetas de sync.
- [x] Tarjeta “Bóveda”: ruta/nombre, estado, cambiar carpeta (con confirmación
      y recarga).
- [x] Tarjeta “Copias longlife”: última copia, cantidad, crear/actualizar,
      listar fechas.
- [x] Zona de riesgo: “Eliminar todas las copias longlife” con doble
      confirmación.
- [x] Ruta `/respaldos` renombrada a copias longlife.
- [x] Actualizar textos de “Datos y respaldo”.

### Etapa 9 — Actualizador Android (HECHA)

- [x] `updater.rs`: guardar APK con
      `android_fs().public_storage().write_with_contents_writer(...)`.
- [x] Guardar en `Descargas/InventarioTienda/`.
- [x] Mantener verificación minisign antes de guardar.
- [x] No fallar si el instalador automático no se puede abrir; informar ruta.
- [ ] (Opcional) Comando `cmd_open_downloaded_apk` con MediaStore. No hace falta para el flujo actual: el usuario abre el APK desde Descargas.
- [x] Probar build Android (`npx tauri android build --debug --apk`).
- [x] Probar descarga real: APK v0.2.10 (81 MB) verificado con minisign y
      guardado en `Descargas/InventarioTienda/Inventario-Tienda-v0.2.10.apk`.
- [x] Evitar el panic de `rustls-platform-verifier` en Android usando raíces
      Mozilla incluidas (`webpki-root-certs` + `tls_certs_only`).

### Etapa 10 — Verificación final (HECHA EN EMULADOR)

- [x] `npm run typecheck`.
- [x] `npm test` (53 tests).
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` (55 pass, 1 ignored).
- [x] `grep -R "sync" src src-tauri/src` sin resultados funcionales.
- [x] Build escritorio (`npx tauri build --no-bundle` o `cargo check`).
- [x] Build Android debug (SDK/NDK local; `JAVA_HOME=/tmp/opencode/jdk`).
- [x] Elegir bóveda, crear contraseña, ver código de recuperación, reiniciar,
      desbloquear con contraseña y con código de recuperación.
- [x] Crear/regenerar longlife, verificar nombres canónicos y ausencia de
      marcadores `.keep-*`; borrar longlife con doble confirmación.
- [x] Verificar el refresco automático en emulador: cambio de ajuste sin
      actualización inmediata, actualización a los 3 minutos, flush al pasar a
      segundo plano, restauración de un archivo faltante y limpieza de un
      archivo obsoleto dentro del snapshot.
- [x] Buscar actualizaciones y descargar el APK a Descargas.

## 4. Comandos útiles

```bash
# Estado
git status --short

# Typecheck + tests frontend
npm run typecheck
npm test

# Tests/compilación Rust
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml

# Buscar sync residual
grep -RIn "sync\|Multicast\|pairing\|discovery" src src-tauri/src src-tauri/gen/android/app/src/main

# Build Android debug
npx tauri android build --debug --apk --target aarch64
```

## 5. Archivos clave

- `src-tauri/src/lib.rs`: registro de módulos/comandos, plugins, setup.
- `src-tauri/src/storage.rs` (nuevo): abstracción local/SAF.
- `src-tauri/src/vault.rs` (nuevo): selección y config de bóveda.
- `src-tauri/src/event_store.rs`: eventos JSONL.
- `src-tauri/src/keys.rs`: llavero.
- `src-tauri/src/crypto.rs`: cifrado y migraciones.
- `src-tauri/src/backup.rs`: longlife.
- `src-tauri/src/updater.rs`: actualizador (TLS con raíces Mozilla en Android).
- `src-tauri/src/android_fs.rs`: puente JNI mínimo para borrar una carpeta SAF
  vacía (`Vault.deleteDir`).
- `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Vault.kt`:
  `deleteDir` con `DocumentFile`.
- `src-tauri/gen/android/app/build.gradle.kts`: dependencia
  `androidx.documentfile:documentfile:1.0.1`.
- `src/main.ts`: arranque.
- `src/store/TauriEventStore.ts`: store Tauri.
- `src/ui/views/settings*.ts`: UI.
- `src/ui/views/unlock.ts`: desbloqueo.
- `docs/KEYSTORES.md`: notas de firma (no borrar).

## 6. Trampas conocidas / notas

- **SAF no es `std::fs`:** `root` en Android es JSON de `DirPath`, no una ruta.
  No usar `Path::new(root)` para SAF.
- **`new_file_with_contents` agrega sufijo si el archivo existe.** Refrescar el
  índice antes de crear y usar `write` si ya existe.
- **SAF y MIME:** `application/json` hacía que `foo.jsonl` se creara como
  `foo.jsonl.json`; cada arranque generaba `(1)`, `(2)`… Usar
  `application/octet-stream` en `storage::mime_for`. Al arrancar,
  `store_ensure_layout` migra `*.jsonl*.json` al nombre canónico y borra los
  duplicados.
- **`androidx.documentfile` es obligatorio:** el plugin lo usa para
  `removeFile`/`delete`; sin `androidx.documentfile:documentfile:1.0.1` el
  borrado falla con `Failed resolution of: Landroidx/documentfile/...`.
- **`tauri-plugin-android-fs` 2.0.1 vs compileSdk:** el crate publicado usa
  `compileSdk = 34`, pero `:tauri-android` de Tauri 2.12 exige 36. El override
  está en `src-tauri/gen/android/build.gradle.kts`; no quitarlo. Sin él, el
  build local puede pasar con el crate cacheado parcheado, pero CI falla en
  `checkReleaseAarMetadata`.
- **Caché SAF tras borrar carpetas:** `remove_dir_all` debe llamar
  `ctx.refresh()` después del `delete_dir` JNI; si no, `create_dir_all`
  reutiliza un `DirPath` muerto y falla al recrear `longlife`.
- **No hay append nativo en SAF:** implementar append como leer + escribir.
- **No hay rename atómico en SAF:** implementar como leer + escribir + borrar.
- **Borrar carpetas SAF:** el plugin no expone `remove_dir` para `DirPath`.
  Borrar archivos recursivamente; JNI `DocumentFile.delete()` limpia la carpeta
  vacía.
- **TLS del actualizador Android:** `reqwest` 0.13 usa
  `rustls-platform-verifier`, que necesita inicialización JNI y paniquea si no
  se hace. En Android el actualizador usa `tls_certs_only` con las raíces
  Mozilla de `webpki-root-certs`; no requiere JNI y sigue validando TLS.
- **No copiar marcadores internos a longlife:** excluir `.keep-*` además de
  `backups/` y `manifest.json`.
- **`longlife` no debe leerse solo:** es un snapshot; la app solo lee `omega`.
- **SAF no expone mtime:** `storage::mtime_ms` devuelve `None` en Android, así
  que el polling de cambios externos no detecta modificaciones allí. Los datos
  propios se siguen leyendo/escribiendo normalmente; los cambios externos se
  ven al reiniciar.
- **El llavero viaja en `omega/keys/keyring.json`:** por eso otra persona con
  la misma carpeta y contraseña puede abrir los datos.
- **VeraCrypt:** no prometer compatibilidad de contenedor. El formato portátil
  es el llavero + Argon2id/XChaCha20-Poly1305 documentado.
- **No borrar** `docs/KEYSTORES.md`, `scripts/sign-local.sh`,
  `scripts/verify-signing.sh` (untracked del usuario).

## 7. Cómo retomar

1. Leer este documento completo.
2. `git status --short` y `git diff` para ver qué etapas quedaron a medias.
3. Buscar el primer checkbox sin marcar en la etapa correspondiente.
4. Ejecutar los comandos de verificación de esa etapa antes de avanzar.
5. Actualizar este documento al terminar cada etapa (marcar `[x]` y anotar
   decisiones nuevas).

## 8. Release v0.2.12

- Versión de la app: `0.2.12`.
- Android: `versionName=0.2.12`, `versionCode=2012`.
- Tag/release: `v0.2.12`.
- Cambio principal: el snapshot `longlife` del día se refresca sin borrar la
  copia completa. El debounce es de 3 minutos y además se fuerza el refresco al
  iniciar, al pasar a segundo plano, al cerrar la ventana y cada 24 h.
- El refresco compara hashes, reescribe solo archivos cambiados, restaura
  archivos faltantes y elimina archivos obsoletos. `force: true` queda solo
  para “Regenerar desde cero”.
- El APK universal firmado se publica en GitHub Releases junto con
  `latest.json`; la app lo descarga a `Descargas/InventarioTienda/`.
- En hardware real hay que instalar el APK de release; si hay una build debug
  instalada con otra firma, primero hay que desinstalarla (perderá los datos
  locales de la app, no los de la bóveda).
- Release publicado el `2026-10-28`: [v0.2.12](https://github.com/wulflo/store-inventory/releases/tag/v0.2.12).
- Workflow de publicación exitoso: [run 40735500745](https://github.com/wulflo/store-inventory/actions/runs/40735500745).
- Assets publicados: APK universal, AAB, AppImage, `.deb`, MSI, NSIS y
  `latest.json` (con firma para `android-universal`, `linux-x86_64` y
  `windows-x86_64`).
- Pendiente: probar la APK de release en un teléfono físico y luego la
  sincronización real con Foldersync/Google Drive entre teléfono y PC.
- Siguiente release: `v0.2.13` (limitaciones de `v0.2.12` resueltas). Ver
  `docs/LIMITACIONES_CHECKLIST.md` y `docs/PROGRESO.md` §18.

## 9. Sincronización externa de la bóveda

La app **no** sincroniza por red. Google Drive + Foldersync (o Syncthing, etc.)
es una forma válida de compartir la bóveda, pero es sincronización de archivos,
no sync en vivo:

- En Android, elegir en la app una carpeta **local** que Foldersync sincronice
  con Drive. No elegir la carpeta virtual del proveedor de Google Drive.
- En la PC, elegir la carpeta local espejo de Google Drive.
- Usar la misma contraseña maestra o código de recuperación. El llavero viaja
  dentro de `<bóveda>/omega/keys/keyring.json`.
- **Un solo equipo escribe a la vez.** Cerrar la app antes de sincronizar y
  esperar a que Foldersync/Drive terminen en ambas direcciones.
- Si Foldersync reemplaza el archivo, las dos copias convergen a una sola
  versión: se descarta lo editado en la otra. Si en cambio crea una copia de
  conflicto, la app no la lee. No hay merge automático de `.jsonl`.
- Esa política de reemplazo puede ser aceptable si se edita en un solo equipo
  por vez y se usa el historial de versiones de Drive para recuperar. No evita
  la pérdida de eventos si los dos equipos editaron entre sincronizaciones.
- `longlife` también se sincroniza si está dentro de la bóveda. Si se excluye
  de Foldersync, no habrá copias longlife en la nube.
