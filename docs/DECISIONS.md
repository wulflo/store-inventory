# DECISIONS.md — Decisiones de arquitectura y versiones

Registra aquí las versiones elegidas y decisiones técnicas. Se actualiza al cerrar cada fase.

## Versiones elegidas (fase 0)

| Componente | Versión / rango | Origen |
|------------|----------------|--------|
| TypeScript | `^5.6.3` | `package.json` (existente) |
| Vite | `^5.4.11` | `package.json` (existente) |
| vitest | `^2.1.8` | `package.json` (existente) |
| Tauri API | `@tauri-apps/api ^2.1.1` | `package.json` (existente) |
| Tauri CLI | `@tauri-apps/cli ^2.1.0` | `package.json` (existente) |
| Tauri plugin fs | `@tauri-apps/plugin-fs ^2.2.0` | `package.json` (existente) |
| Tauri plugin dialog | `@tauri-apps/plugin-dialog ^2.2.0` | `package.json` (existente) |
| Tauri plugin opener | `@tauri-apps/plugin-opener ^2.2.5` | `package.json` (existente) |
| Puerto dev | `127.0.0.1:1420` (strictPort) | `vite.config.ts` |
| Eventos | JSONL append-only, 1 dominio = 1 archivo `.jsonl` | `src/store/EventStore.ts` |
| IDs | UUID v7 (RFC 9562), sin autoincrement | `src/core/ids.ts` |
| Reloj | HLC = `wall_ms * 1000 + counter` (counter 0..999) | `src/core/hlc.ts` |
| Dinero | Centavos ARS (enteros), nunca float para saldo | `src/core/money.ts` |
| Talles | Fijos XS→3XL | `src/core/sizes.ts` |
| Moneda | ARS | decisión de usuario |
| Backend Rust | Implementado (`src-tauri/`, Tauri 2.12.5) | `Cargo.lock` |
| JDK Android | Temurin 17.0.21 | `~/.local/share/jdks/temurin-17` |
| Android SDK | platforms 35/37, build-tools 35/37 | `/home/alonso/Android/Sdk` |
| Android NDK | 27.0.12077973 | `/home/alonso/Android/Sdk/ndk` |

## Decisiones por fase (por rellenar al cerrar cada fase)

### Fase 4 — Versionado
- Fuente de verdad: tag git anotado `vMAJOR.MINOR.PATCH` (SemVer).
- `scripts/version.mjs` con `check` y `set <x.y.z>`.
- `scripts/version-map.mjs`: conversión a `versionName`/`versionCode` (Android), versión numérica (Windows), `~` (Linux prereleases).
- Instalador Windows: por definir (NSIS vs MSI).

### Fase 1 — UI Material Design 3 (EN PROGRESO)
- Componentes: **propios sobre tokens M3** (no se agrega @material/web). Justificación: el proyecto exige "sin dependencias pesadas", @material/web tiene mantenimiento mixto y su WebView en Android puede traer problemas de versionado; componentes propios sobre tokens M3 dan el mismo resultado visual con cero dependencias nuevas.
- Generación de colores: roles M3 (primary/on-primary/primary-container/surface-*/outline/error) derivados de un color semilla, implementación propia (sin @material/material-color-utilities por ahora) para evitar dependencia.
- Iconos: Material Symbols como SVG inline, empaquetados localmente.
- Fuentes: Roboto / Roboto Flex locales, sin CDN.
- Layout: window size classes (compact <600px, medium 600–839px, expanded ≥840px); navigation bar inferior en compacto, rail en medio/expandido.
- Pendiente: archivo de logo del usuario (no presente en el repo); se integrará como icono de app una vez se proporcione.

### Fase 3 — Android / SAF (PARCIAL)
- **Implementado:** store primario en el almacenamiento privado de la app
  (`app_data_dir()`), resuelto por `root_for_app` en `src-tauri/src/lib.rs`. En
  escritorio se conserva `~/.local/share/inventario-tienda`.
- **No implementado:** carpeta SAF elegible y espejo bidireccional. Sin
  `MANAGE_EXTERNAL_STORAGE`.
- Permisos: `INTERNET`, `ACCESS_WIFI_STATE`, `ACCESS_NETWORK_STATE`,
  `CHANGE_WIFI_MULTICAST_STATE`.
- `minSdk 28`, `compileSdk/targetSdk 37`, `versionCode = major*1e6 + minor*1e3 + patch`.
- Proyecto `gen/android` regenerado con `tauri android init`; `MainActivity.kt`
  real con `TauriActivity`; `allowBackup=false`.
- Toolchain local: JDK 17, SDK 35/37, NDK 27, CMake 3.22.1. APK debug x86_64 y
  arm64 compilados y firmados con la keystore de debug.
- **Verificado en emulador Android 35 x86_64 (320×640, KVM):** arranque, dashboard,
  navegación, tema claro/oscuro y persistencia. Datos en
  `/data/user/0/com.inventariotienda.app/events`: 13 archivos, 315 líneas (313
  del seed + 2 `Setting.Set` de tema) antes y después de force-stop/reapertura.
- **Release firmado:** `app/build.gradle.kts` lee `keystore.properties` y configura
  `signingConfigs.release`. APK universal del CI (39.923.555 B, 4 ABIs) firmado
  con el certificado release e instalado en emulador; los 315 eventos sobreviven
  a `adb install -r` y al reinicio.

### Fase 2 — P2P cifrado LAN (PARCIAL — núcleo implementado, transporte esqueleto)
- Núcleo implementado y testeado (15 tests Rust): identidad (Ed25519 + cert
  autofirmado, Device ID = SHA-256 del cert, código SAS), peers emparejados,
  framing (prefijo de longitud, 1 MiB max), protocolo de reconciliación por
  dominio (resumen, diff de IDs, lotes ≤500 eventos/1 MiB, SHA-256 por lote,
  validación de HLC futuro).
- Comandos Tauri: `sync_generate_identity`, `sync_list_peers`, `sync_start`,
  `sync_stop`.
- UI en Ajustes → Sincronización (esqueleto M3).
- **Transporte TLS 1.3 mutuo (rustls) y mDNS: NO implementado.** `ring` y
  `aws-lc-rs` ya compilan para Android con el NDK 27; el bloqueo anterior quedó
  resuelto, pero falta el servidor/cliente real, el descubrimiento y la prueba de
  convergencia entre dos dispositivos.

### Fase 5 — Actualizaciones (IMPLEMENTADO, SIN PRUEBA E2E)
- `tauri-plugin-updater` solo en escritorio (`#[cfg(not(target_os = "android"))]`).
- `cmd_updater_check` usa `UpdaterExt`; en Android devuelve un mensaje que indica
  reinstalar el APK/actualizar desde la tienda.
- UI en Ajustes → Actualizaciones con estado reactivo (buscando, al día,
  disponible, error).
- `tauri.conf.json`: pubkey real, endpoint
  `https://github.com/wulflo/store-inventory/releases/latest/download/latest.json`
  y `bundle.createUpdaterArtifacts: true`.
- `scripts/latest-json.mjs` genera el manifiesto real desde los `.sig`.
  Soporta los artefactos directos de Tauri v2 (`AppImage`, `.exe`, `.msi`) y los
  formatos v1 (`.AppImage.tar.gz`, `.nsis.zip`, `.msi.zip`), con 8 tests.
- El release dry-run `40484612737` generó desde artefactos reales del CI:
  AppImage 83.683.832 B + `.sig` 452 B, NSIS 3.622.879 B + `.sig` 448 B, MSI
  5.488.640 B + `.sig` 448 B y `latest.json` de 1.373 B. Las firmas del
  manifiesto coinciden con los `.sig`.
- GitHub reemplaza los espacios del nombre del asset por puntos; el script
  normaliza la URL (`Inventario.Tienda…`) para evitar un 404 del updater.
- Claves generadas y secretos cargados en el Environment `release` de GitHub.
  Ver `docs/RELEASE.md`.
- El draft `v1.0.0` (`isDraft: true`, sin tag público) no alimenta
  `releases/latest`; el endpoint real todavía devuelve 404.
- **Pendiente:** publicar el release y probar una actualización real.

### Fase 6 — CI/CD
- `ci.yml`: typecheck, 45 tests vitest, `cargo test` (15), builds Linux/Windows
  con `--no-bundle`, y APK Android debug arm64. `cargo fmt --check` y `clippy`
  son informativos (`continue-on-error`) porque el código todavía tiene formato
  de 2 espacios y warnings; no se oculta el resultado.
- `release.yml`: tag `v*.*.*` o `workflow_dispatch` (dry-run por defecto),
  verify de versión/tag, builds Linux (deb/AppImage), Windows (MSI/NSIS) y
  Android (APK/AAB) firmados, y publicación con `latest.json` real.
- Secretos en el Environment `release` (6): updater y keystore Android.
  `keystore.properties` se genera en el runner y está ignorado por git.
- `actionlint 1.7.12` pasa ambos workflows.
- **CI real:** run `40475650914` con `lint`, `build-linux`, `build-windows` y
  `build-android` en verde.
- **Android SDK en CI:** se dejó de usar `android-actions/setup-android@v3`
  porque intenta instalar el paquete `tools`, retirado del repositorio de Google.
  El workflow usa el SDK preinstalado del runner y `sdkmanager` directo.
- **Release workflow:** ejecutado en `main` con `workflow_dispatch` y
  `dry-run=true`. Run `40484612737`: `verify`, `build-linux`, `build-windows`,
  `build-android` y `publish` en verde. Creó el draft `v1.0.0` con 10 assets
  firmados y `latest.json`; **no** publicó ni creó tag público.
- Todos los jobs que consumen secretos (`build-linux`, `build-windows`,
  `build-android`, `publish`) declaran `environment: release`. Sin esa
  declaración GitHub entrega los secretos vacíos y la firma falla con
  `Missing comment in secret key`.

### Hotfix de auditoría de UI y persistencia (fase 1/7)
- **Pérdida de datos en navegador:** `WebEventStore.append` usaba `createWritable()` sin `keepExistingData`, que trunca el `.jsonl` en cada escritura. Ahora escribe al final con posición explícita y tiene fallback de reescritura. Regresión cubierta en `tests/store.test.ts`.
- **Layout de escritorio:** `.layout` estaba en `flex-direction: column`, por lo que la sidebar y el contenido se apilaban a partir de 600 px. Ahora es `row` y `.main` es `column`.
- **Utilidades CSS perdidas:** la reescritura M3 no incluía `.grid*`, `.form-row*`, `.search-box`, `.variant-grid`, `.qty-input`, `.autocomplete*`, `.timeline`, `.modal-foot`, `.empty*`, `.btn-icon`, `.page-head`, `.section-title`, `.bar`, `.count` ni varios badges. Se restauraron con tokens M3 (sección 22 de `styles.css`).
- **Acción principal:** en compacto/medio manda el FAB; en expandido manda el botón del topbar (se oculta el duplicado).
- **Navegación:** "Importar datos" se agregó al menú "Más" de móvil y se resalta en la sidebar; atajos corregidos (`i` → Importar, `g` → Gastos, `r` → Reportes, `a` → Ajustes).
- **Textos:** se eliminó el único texto en inglés del dashboard y los chips de pago ahora muestran "Seña"/"Pago parcial".
- **Iconos Android:** los PNG de `src-tauri/icons` eran de 16 bits por canal y Tauri los leía mal (`invalid icon: dimensions (32x32) ... expected 1024`), provocando un panic al iniciar el APK. Se convirtieron a PNG32 de 8 bits; el arranque en emulador quedó verificado.
- **Comandos Tauri:** Rust registraba `cmd_store_*`/`cmd_sync_*`, pero el frontend invocaba `store_*`/`sync_*`. En Android eso hacía `Command store_default_root not found`, caía a `MemoryEventStore` y no persistía nada. Además los comandos de store esperaban `{ args: {...} }` y el frontend manda campos planos. Se alinearon nombres y firmas (el updater conserva `cmd_updater_check`).
- **Safe area Android:** CSS `env(safe-area-inset-top)` no expone la barra de
  estado en el WebView. `MainActivity` aplica `WindowInsetsCompat` (top, laterales
  y bottom) al contenido; así el topbar no queda debajo de la barra de estado y
  la barra de gestos no tapa la bottom nav.
- **Bottom nav Android:** `.layout` medía `100vh` y empujaba la barra inferior
  fuera de la pantalla. `#root` es flex column con `100dvh`; `.layout` ocupa el
  espacio restante y la nav queda visible.
- **Raíz de `scripts/version.mjs`:** calculaba `ROOT` desde `import.meta.url`
  sin subir un nivel y apuntaba a `scripts/`; el workflow de release no podía
  leer `package.json`. Ahora usa `fileURLToPath(new URL('..', import.meta.url))`.
- **Secretos del release:** los jobs de build no declaraban
  `environment: release`, por lo que `TAURI_SIGNING_PRIVATE_KEY` y el keystore
  Android llegaban vacíos. Se agregó el environment a los tres builds.
- **Nombres de assets:** GitHub reemplaza espacios por puntos al subir; el
  manifiesto usaba `%20` y hubiera dado 404. `latest-json.mjs` normaliza el
  nombre y el test lo cubre.

## Identificador definitivo (fase 3)
- `identifier` / `applicationId`: `com.inventariotienda.app` (definido en
  `src-tauri/tauri.conf.json` y `gen/android`).
- Es válido y **no genera incompatibilidad**: `app` no es palabra reservada de
  Java/Kotlin y el identificador no es un nombre de archivo; la extensión `.app`
  de macOS es independiente. Se puede mantener.
- **No cambiar después del primer release Android**: el sistema lo trata como
  otra app y se pierden continuidad de datos/actualizaciones.

## Decisiones pendientes
- ~~OWNER/REPO de GitHub~~ → `wulflo/store-inventory`.
- ~~Android SDK~~ → instalado (SDK 35/37, NDK 27, JDK 17).
- ~~Keystore/updater~~ → generados y respaldados fuera del repo; secretos
  cargados en el Environment `release`.
- Certificado Authenticode para Windows (hoy se publica sin firmar; SmartScreen
  puede advertir).
- Publicar el draft `v1.0.0` y probar el updater contra `releases/latest`.
- Probar el APK universal/arm64 en un dispositivo físico.
- Implementar transporte P2P real y SAF.
- Revisar las 17 alertas de Dependabot (6 dev-only en `npm audit` local, 0 en
  producción).
