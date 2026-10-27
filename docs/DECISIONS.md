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
| Backend Rust | Pendiente (fase de implementación `src-tauri/`) | — |

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

### Fase 3 — Android / SAF
- Store primario: copia de trabajo en almacenamiento privado de la app + carpeta SAF como espejo bidireccional.
- Permisos: `INTERNET`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`; **sin** `MANAGE_EXTERNAL_STORAGE`.
- `minSdk`: por definir (matriz API 28/29, 30, 34, última).

### Fase 2 — P2P cifrado LAN (PARCIAL — núcleo implementado, transporte esqueleto)
- Núcleo implementado y testeado (15 tests Rust): identidad (Ed25519 + cert autofirmado, Device ID = SHA-256 del cert, código SAS), peers emparejados, framing (prefijo de longitud, 1 MiB max), protocolo de reconciliación por dominio (resumen, diff de IDs, lotes ≤500 eventos/1 MiB, SHA-256 por lote, validación de HLC futuro).
- Comandos Tauri: `sync_generate_identity`, `sync_list_peers`, `sync_start`, `sync_stop`.
- UI en Ajustes → Sincronización (esqueleto M3).
- Transporte TLS 1.3 mutuo (rustls) y descubrimiento UDP multicast: ESQUELETO no verificado. El crate `ring` (crypto de rustls) no compila para Android en este entorno (falta ensamblador pregenerado del NDK). Documentado como límite conocido.

### Fase 5 — Actualizaciones (PARCIAL — esqueleto)
- `tauri-plugin-updater` agregado a Cargo.toml y package.json.
- Comando Tauri `cmd_updater_check` (esqueleto: informa que requiere pubkey configurada por el usuario).
- UI en Ajustes → Actualizaciones: versión actual, botón "Buscar actualizaciones", mensaje informativo.
- Requisitos del usuario (no implementados por falta de credenciales):
  - Generar pubkey del updater: `npm run tauri signer generate -- -w <ruta>`
  - Configurar `pubkey` y `endpoints` en src-tauri/tauri.conf.json (pendiente de verificar ubicación correcta en schema actual).
  - Crear GitHub Environment `release` con required reviewers.
  - OWNER/REPO de GitHub para releases.
  - Certificado de firma Windows (Authenticode) o construir sin firmar.
  - Keystore Android (mismo que la app instalada para conservar datos).

### Fase 6 — CI/CD
- `ci.yml`: typecheck, vitest, `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo audit`, `npm audit`, build Linux/Windows.
- `release.yml`: tag `v*.*.*`, verify + build linux/windows/android + publish (draft → publish).
- Secrets: GitHub Environment `release` con required reviewers.

### Hotfix de auditoría de UI y persistencia (fase 1/7)
- **Pérdida de datos en navegador:** `WebEventStore.append` usaba `createWritable()` sin `keepExistingData`, que trunca el `.jsonl` en cada escritura. Ahora escribe al final con posición explícita y tiene fallback de reescritura. Regresión cubierta en `tests/store.test.ts`.
- **Layout de escritorio:** `.layout` estaba en `flex-direction: column`, por lo que la sidebar y el contenido se apilaban a partir de 600 px. Ahora es `row` y `.main` es `column`.
- **Utilidades CSS perdidas:** la reescritura M3 no incluía `.grid*`, `.form-row*`, `.search-box`, `.variant-grid`, `.qty-input`, `.autocomplete*`, `.timeline`, `.modal-foot`, `.empty*`, `.btn-icon`, `.page-head`, `.section-title`, `.bar`, `.count` ni varios badges. Se restauraron con tokens M3 (sección 22 de `styles.css`).
- **Acción principal:** en compacto/medio manda el FAB; en expandido manda el botón del topbar (se oculta el duplicado).
- **Navegación:** "Importar datos" se agregó al menú "Más" de móvil y se resalta en la sidebar; atajos corregidos (`i` → Importar, `g` → Gastos, `r` → Reportes, `a` → Ajustes).
- **Textos:** se eliminó el único texto en inglés del dashboard y los chips de pago ahora muestran "Seña"/"Pago parcial".

## Identificador definitivo (fase 3)
- `identifier` / `applicationId`: `com.inventariotienda.app` (definido en src-tauri/tauri.conf.json y gen/android). **No podrá cambiarse luego sin romper las actualizaciones en Android.** El usuario debe confirmar este valor.

## Decisiones pendientes (requieren input del usuario)
- ~~OWNER/REPO de GitHub~~ → `wulflo/store-inventory` (confirmado por `git remote` y `gh auth status`).
- Certificado de firma Windows (Authenticode) o construir sin firmar (SmartScreen).
- Keystore Android: generar y respaldar (si se pierde, no se puede actualizar la app instalada).
- Android SDK completo: no presente en el entorno (directorio vacío). `src-tauri/gen/android` es un esqueleto no verificado; se generará con `tauri android init` cuando el SDK esté disponible.
