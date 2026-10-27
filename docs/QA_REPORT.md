# QA_REPORT.md — Resultados de pruebas en vivo (Fase 7)

**Rama:** `feat/material-p2p-release`  
**Entorno:** Linux, Node 18.19.1, Rust 1.99.1, cargo 1.99.1, tauri-cli 2.12.4  
**WebKitGTK:** 4.1 presente (para dev desktop)

---

## Criterios ejecutados y resultado

| # | Función / prueba | Resultado | Motivo / detalle |
|---|------------------|-----------|------------------|
| 1 | `npm run typecheck` | ✅ Verificado | Sin errores de TypeScript. |
| 2 | `npm test` (vitest) | ✅ Verificado | 37 tests pasan (16 core + 19 version-map + 2 store). |
| 3 | `cargo check` (desktop Linux) | ✅ Verificado | Compila sin errores (solo warnings normales). |
| 4 | `cargo check` Android (aarch64, armv7, x86_64, i686) | ✅ Verificado | Compila para los 4 targets Android. |
| 5 | `cargo test` (sync: identidad, peers, framing, protocolo) | ✅ Verificado | 15 tests del núcleo de sync pasan. |
| 6 | `npm run dev` (Vite en 127.0.0.1:1420) | ✅ Verificado | Servidor levanta, app carga con datos de seed. |
| 7 | Navegación por todas las rutas UI | ✅ Verificado | 16 rutas renderizan sin errores de consola (incluye detalle de pedido/cliente y 404). |
| 8 | Datos de seed (2 colecciones, 5 productos, 10 pedidos, producción, gastos) | ✅ Verificado | Se cargan y se derivan correctamente (stock, reservas, márgenes). |
| 9 | Rediseño Material Design 3 (tokens, componentes, layout adaptativo) | ✅ Verificado (manual) | Recorrido visual en navegador a 904×675: sidebar/topbar lado a lado, grillas 2×2, tablas, modales y formularios. No hay Playwright que lo automatice. |
| 10 | Tema claro/oscuro | ✅ Verificado (manual) | Ambos temas renderizan con contraste legible en navegador. |
| 21 | Persistencia OPFS (`WebEventStore.append`) | ✅ Verificado | Regresión cubierta por 2 tests; tras recargar, los 313 eventos del seed siguen en disco. Antes cada append borraba el archivo (bug corregido). |
| 22 | Auditoría de clases CSS usadas vs. definidas | ✅ Verificado | 145 clases literales relevadas; se restauraron ~40 que faltaban (form-row, grid, search-box, variant-grid, autocomplete, timeline, modal-foot, badges). 0 faltantes. |
| 11 | Backend Rust `src-tauri/` (comandos store_*) | ✅ Verificado (desktop) | `cargo check` pasa; comandos implementados. |
| 12 | `src-tauri/` para Android | ⚠️ Compila, no verificado | `cargo check --target` pasa para 4 targets; `gen/android` es esqueleto sin SDK completo. |
| 13 | Sincronización P2P (núcleo: identidad, peers, framing, protocolo) | ✅ Verificado | 15 tests Rust pasan. |
| 14 | Sincronización P2P (transporte TLS 1.3 mutuo, mDNS, SAS, reconciliación de red) | ❌ No verificado | Esqueleto; `ring` (crypto de rustls) no compila para Android en este entorno; no hay dos dispositivos para probar convergencia LAN. |
| 15 | Actualizaciones (updater) | ❌ No verificado | Esqueleto; requiere pubkey generada por el usuario y endpoint real. |
| 16 | CI/CD (GitHub Actions) | ⚠️ Implementado sin verificar | Workflows creados; no se ejecutaron en este entorno. |
| 17 | Android / SAF (almacenamiento vía SAF) | ❌ No verificado | No hay Android SDK completo (directorio vacío); no hay emulador. |
| 18 | Build nativo de Tauri (appimage, deb, msi, apk) | ❌ No verificado | No se ejecutó `cargo tauri build` (requiere dependencias del sistema y firmas). |
| 19 | Playwright / E2E automatizado | ❌ No verificado | Playwright no instalado; no hay capturas en docs/qa/screenshots/. |
| 20 | actionlint / act | ❌ No verificado | No instalados en este entorno. |

---

## Limitaciones conocidas

1. **Android SDK ausente:** El directorio `/home/alonso/Android/Sdk` existe pero está vacío. `tauri android init` falla. `src-tauri/gen/android` es un esqueleto no verificado. Se necesita instalar Android SDK/NDK completo para compilar y probar Android.
2. **Crypto para Android (`ring`):** El crate `ring` (dependencia de rustls) no compila para Android por falta de ensamblador pregenerado. El transporte TLS 1.3 mutuo de sincronización P2P no está implementado para Android.
3. **Identificador de la app:** `com.inventariotienda.app` ya termina en `.app` (lo pedido por el usuario); queda confirmar el prefijo exacto antes del primer release. No podrá cambiarse después de publicar sin romper actualizaciones en Android.
4. **Secretos de release:** No hay claves de firmante (updater, Windows Authenticode, Android keystore). Los builds de release se producirían sin firmar (SmartScreen en Windows; Android no se puede actualizar sin keystore consistente).
5. **Logo:** El usuario mencionó un logo adjuntado, pero no hay archivo de ícono de app en el repositorio.

---

## Qué debe hacer el usuario (entrega)

1. Confirmar el `identifier` de la app (`com.inventariotienda.app`) o cambiarlo antes del primer release.
2. Generar la clave del updater (`npm run tauri signer generate`) y la keystore Android (`keytool`); respaldar la keystore.
3. Cargar los secretos en GitHub Environment `release` (required reviewers, restricción a tags `v*`).
4. ~~Definir OWNER/REPO~~ → resuelto: `wulflo/store-inventory`; `gh` autenticado como `wulflo` (scopes `repo`, `workflow`). Faltan cargar los secretos de firma (ver más arriba).
5. Instalar Android SDK/NDK completo para compilar y probar Android (API 28, 34, más reciente).
6. Ejecutar `npm run tauri dev` para probar la app nativa en desktop (después de completar `src-tauri/`).
7. Ejecutar Playwright / E2E para cubrir las vistas y generar capturas en `docs/qa/screenshots/`.
8. Ejecutar `actionlint` y `act` para validar los workflows.
