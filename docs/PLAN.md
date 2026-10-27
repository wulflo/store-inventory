# PLAN.md — Hoja de ruta (Fase 0: Auditoría)

## Repositorio y rama
- Rama de trabajo: `feat/material-p2p-release` (creada desde `main`, commit `0fbb9ff`)
- Directorio: `/home/alonso/Documentos/Repositorios/inventario-tienda`

## Estado actual (verificado contra el disco)

### ✅ Lo que YA existe (frontend completo)
- Arquitectura Event Sourcing / CQRS ligera con JSONL append-only (14 dominios → `.jsonl`)
- Reloj HLC (Hybrid Logical Clock) para ordenar eventos entre dispositivos
- Deduplicación por `event.id`, LWW por campo con HLC, soft delete con posible resucitación
- `AppState` (proyección en memoria), `Projector` (~35 tipos de evento), `queries.ts` (read models)
- Capa de comandos `domain/commands.ts` con `ValidationError` en español
- `EventStore` abstracto + `WebEventStore` (OPFS para dev/web) + `MemoryEventStore` (tests)
- `TauriEventStore.ts` que invoca comandos Rust vía `invoke` (pero **no hay Rust**)
- `src/main.ts` bootstrap completo (detecta Tauri, deviceId, seed, tema, rutas, shell)
- `src/seed/seed.ts` (datos demo: 2 colecciones, 5 productos, 4 colores, 28 variantes/producto, 10 clientes, 10 pedidos, producción, gastos)
- 18 vistas UI: dashboard, pedidos (nuevo/detalle), producción, stock, movimientos, catálogo, clientes, gastos, reportes, ajustes, importar CSV
- 16 tests en `tests/core.test.ts` (stock, reservas, márgenes, LWW, dedup, rebuild, validaciones)
- Stack: Tauri 2 (`@tauri-apps/api ^2.1.1`, cli `^2.1.0`), Vite 5, vitest 2, TypeScript 5.6
- Puerto dev: `127.0.0.1:1420` (strictPort)

### ❌ Lo que FALTA (bloqueantes)
1. **`src-tauri/` no existe**: no hay `Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/main.rs`, `src/lib.rs`, ni `src/event_store.rs`. Los comandos `store_default_root`, `store_ensure_layout`, `store_append`, `store_read`, `store_mtimes`, `store_device_id` no tienen implementación Rust.
2. Sin íconos PNG mínimos de la app.
3. Sin capabilities de Tauri.

### ⚠️ Gap menores (no bloquean, se anotan)
- `settings.ts`: botón "Vaciar todos los datos" solo muestra un toast informativo (no borra).
- `dashboard.ts` línea ~68: texto en inglés sin traducir ("When you schedule a delivery...").
- `LICENSE` con placeholders `<AÑO>` y `<TU NOMBRE O USUARIO>` sin rellenar.
- Tests solo en Node (vitest `environment: node`), sin Playwright ni UI tests.
- Sin `docs/` con contenido (se crea en esta fase).

## Riesgos identificados

### R1 — Conflicto de archivos `.jsonl` compartidos entre dispositivos (Syncthing/Drive)
El modelo actual de **un archivo `.jsonl` por dominio compartido en la carpeta sincronizada** tiene un riesgo real de conflicto de escritura concurrente:
- Si dos dispositivos escriben al mismo archivo JSONL al mismo tiempo, las líneas pueden entrelazarse (interleaving) o una escritura puede sobrescribir parcialmente la otra.
- JSONL append-only es resistente a **corrupción de archivo entero** (no es un `.db` binario), pero NO es resistente a **escrituras paralelas en el mismo archivo**.
- Mitigación planificada (FASE 3 Android / FASE 2 P2P): pasar a **segmentos inmutables por dispositivo** (`<dominio>/<deviceId>/<hlcInicial>-<uuid>.jsonl`), que nunca se modifican tras escribirse. Cada archivo tiene un único escritor. Migración aditiva leyendo ambos layouts y deduplicando por `event.id` (nunca se borra el original).

### R2 — Capa Rust ausente
Sin `src-tauri/` la app no empaqueta como escritorio nativo ni móvil. Solo funciona en modo web (OPFS). Esto se resuelve en la fase de implementación de `src-tauri/`.

### R3 — Seguridad de secretos
Los secretos de firma (updater, keystore Android) nunca van al repo. Se inyectan vía GitHub Environment `release` con required reviewers.

## Orden de fases (obligatorio)
0. Auditoría → `docs/PLAN.md` + `docs/DECISIONS.md` (esta fase)
4. Versionado (`scripts/version.mjs`, `scripts/version-map.mjs`, tag `vX.Y.Z`)
1. UI Material Design 3 + adaptación Android (`docs/DESIGN.md`)
3. Android / SAF (`StorageBackend`, SAF, permisos mínimos)
2. P2P cifrado LAN (`src-tauri/src/sync/`, rustls, mDNS, SAS, TOFU)
5. Actualizaciones (updater desktop + APK manual Android)
6. CI/CD (`.github/workflows/ci.yml`, `release.yml`)
7. QA en vivo (`docs/QA_REPORT.md`, capturas en `docs/qa/screenshots/`)
8. Entrega

## Criterio de terminado
- `npm run typecheck` y `npm test` verdes al cerrar cada fase.
- Un commit por fase con mensajes Conventional Commits (`feat(...)`, `chore(release)`, etc.).
- `docs/QA_REPORT.md` distingue honestamente Verificado / Implementado sin verificar / No implementado.
- Secretos nunca al repo, logs, artefactos ni capturas.

## Limitaciones documentadas (fuera de alcance)
- iOS, macOS, sincronización en segundo plano, relays, discovery global, NAT traversal (solo LAN).
- Android: sincronización solo en primer plano (limitación por Doze).
