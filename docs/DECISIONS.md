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

### Fase 1 — UI Material Design 3
- Componentes: propios sobre tokens M3 (preferencia), salvo que `@material/web` aporte claramente más.
- Iconos: Material Symbols como SVG inline, empaquetados localmente.
- Fuentes: Roboto / Roboto Flex locales, sin CDN.

### Fase 3 — Android / SAF
- Store primario: copia de trabajo en almacenamiento privado de la app + carpeta SAF como espejo bidireccional.
- Permisos: `INTERNET`, `ACCESS_WIFI_STATE`, `CHANGE_WIFI_MULTICAST_STATE`; **sin** `MANAGE_EXTERNAL_STORAGE`.
- `minSdk`: por definir (matriz API 28/29, 30, 34, última).

### Fase 2 — P2P cifrado LAN
- Identidad: par de claves Ed25519 + certificado autofirmado (rcgen). Device ID = SHA-256 del cert DER.
- Transporte: TLS 1.3 mutuo (rustls), ALPN `inventario-sync/1`, pinning de fingerprints.
- Descubrimiento: mDNS/DNS-SD o UDP multicast propio; fallback IP:puerto manual.
- Puerto: configurable, no 22000/21027 (Syncthing).

### Fase 5 — Actualizaciones
- Desktop: `tauri-plugin-updater`, endpoint `latest.json` en GitHub Releases.
- Android: consulta `api.github.com/repos/.../releases/latest`, descarga APK a Descargas, verifica SHA-256 y certificado de firma.

### Fase 6 — CI/CD
- `ci.yml`: typecheck, vitest, `cargo fmt --check`, `clippy -D warnings`, `cargo test`, `cargo audit`, `npm audit`, build Linux/Windows.
- `release.yml`: tag `v*.*.*`, verify + build linux/windows/android + publish (draft → publish).
- Secrets: GitHub Environment `release` con required reviewers.

## Decisiones pendientes (requieren input del usuario)
- Identificador de la app (TAURI identifier / package ID Android): **definitivo, no cambiará luego**.
- OWNER/REPO de GitHub para releases y updater.
- Certificado de firma Windows (Authenticode) o construir sin firmar (SmartScreen).
- Keystore Android: generar y respaldar (si se pierde, no se puede actualizar la app instalada).
