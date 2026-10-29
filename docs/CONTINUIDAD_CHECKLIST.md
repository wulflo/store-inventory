# Continuidad sin internet — checklist para retomar el trabajo

> **Base:** `v0.3.0` (`51733b8`), rama `main`.
> **Última actualización:** 2026-10-29.
> **Objetivo:** poder cortar la sesión (o perder internet) en cualquier momento y
> retomar exactamente donde quedó, sin volver a investigar el estado del repo.
>
> Convenciones: `[x]` hecho y verificado · `[~]` parcial · `[ ]` pendiente.

---

## 0. Estado al escribir este documento

Trabajo **sin commitear** sobre `v0.3.0`:

| Área | Archivos | Estado |
|---|---|---|
| Stock inicial por color/talle al crear producto | `src/ui/views/productNew.ts` | `[x]` |
| Precio por variante (ofertas, fechas especiales) | `src/domain/commands.ts`, `src/ui/views/products.ts` | `[x]` |
| Revisar archivos y abrir carpeta de un snapshot | `src-tauri/src/backup.rs`, `src-tauri/src/lib.rs`, `src/ui/views/settingsBackup.ts` | `[x]` |
| Tests de overrides y stock inicial | `tests/core.test.ts` | `[x]` |
| Documentación | `docs/CONTINUIDAD_CHECKLIST.md`, `docs/PROGRESO.md` | `[x]` |

### Qué quedó implementado

- **Alta de producto (`/productos/nuevo`):** matriz de variantes con
  **cantidad inicial** y **precio unitario** por combinación talle × color.
  - El stock se registra como movimiento append-only `inicial`
    (`setInitialStock`), no como orden de producción.
  - El precio por variante se pasa a `generateVariants()` mediante
    `overrides["<talle>|<colorId>"]`; si no se toca, usa el precio base.
  - Botones “Aplicar precio base a todas” y “Vaciar cantidades”.
- **Modal “Variantes” (desde el catálogo):**
  - Columna **Precio** editable por variante.
  - Barra “Precio para todas las variantes” + “Aplicar a todas” para cargar una
    oferta o fecha especial de una sola vez.
  - Los pedidos ya guardados conservan el precio de su línea.
- **Copias longlife (`/ajustes` → Copias):**
  - Botón **Archivos** por copia: muestra la ruta y el listado del manifiesto
    (nombre, tamaño y SHA-256 abreviado) sin leer todos los bytes.
  - Botón **Abrir carpeta** por copia y por dispositivo (solo escritorio).
  - Nuevos comandos Rust `longlife_files` y `longlife_open_folder`, con
    validación de `deviceId` y `date` contra traversal de rutas.

---

## 1. Antes de tocar nada (offline)

- [ ] `git status --short` y `git log --oneline -5`.
- [ ] Confirmar que `node_modules/` y `src-tauri/target/` existen. **No hace
      falta** `npm install` ni `cargo fetch` si ya están.
- [ ] `npm run typecheck`.
- [ ] `npm test`.
- [ ] `npm run build`.
- [ ] `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`.

Si falta una dependencia y no hay red:

1. No borrar `node_modules/` ni `src-tauri/target/`.
2. Seguir con las tareas que no requieran compilar (docs, revisión de código,
   tests unitarios que ya tengan dependencias cacheadas).
3. Usar el teléfono como hotspot solo para el paso que falte y volver a modo
   offline.

---

## 2. Verificación pendiente de esta sesión

- [x] `npm run typecheck` en verde.
- [x] `npm test` en verde (61 tests, incluidos los 2 nuevos de overrides y
      stock inicial).
- [x] `npm run build`.
- [x] `cargo check --manifest-path src-tauri/Cargo.toml`.
- [x] `cargo test --manifest-path src-tauri/Cargo.toml` (78 pass, 1 ignored).
- [ ] Smoke test en navegador:
  - [ ] Crear producto con 2 talles × 2 colores, cantidades distintas y un
        precio distinto para una combinación.
  - [ ] Verificar en el catálogo que el stock inicial coincide.
  - [ ] Abrir “Variantes”, cambiar un precio y aplicar un precio a todas.
  - [ ] Crear un pedido y confirmar que toma el precio de la variante.
- [ ] Smoke test en escritorio (Tauri):
  - [ ] “Archivos” muestra el manifiesto de una copia.
  - [ ] “Abrir carpeta” abre el explorador en la carpeta correcta.
  - [ ] “Abrir carpeta” del grupo abre la carpeta del dispositivo.

---

## 3. Si hay que retomar el código

Orden recomendado:

1. **Revisar el diff** de los archivos tocados:
   ```bash
   git diff -- src/domain/commands.ts src/ui/views/productNew.ts \
     src/ui/views/products.ts src/ui/views/settingsBackup.ts \
     src-tauri/src/backup.rs src-tauri/src/lib.rs tests/core.test.ts
   ```
2. **Tests primero:** `npm test -- core` para validar overrides y stock inicial.
3. **Compilar Rust:** `cargo check --manifest-path src-tauri/Cargo.toml`.
4. **Probar la UI** según la sección 2.
5. Recién después, commit:
   ```bash
   git add -A
   git commit -m "feat: stock y precios por variante al crear producto; revisar snapshots"
   ```

### Puntos delicados a revisar

- `generateVariants()` **no** emite `Variant.Updated`: los overrides van en el
  mismo `Variant.Created`. Si se agrega un campo nuevo, incluirlo en el payload.
- `productNew.save()` sólo manda overrides de precios que el usuario tocó. No
  convertir todos los precios en overrides sin querer.
- `longlife_files()` lee el manifiesto, **no** valida todos los hashes (eso lo
  hace `longlife_restore`). Es una vista previa, no una garantía.
- `longlife_open_folder()` en Android devuelve error a propósito: la bóveda SAF
  no tiene una ruta de sistema abrible.
- Las variantes con `priceCents` distinto muestran un rango en el catálogo. Si
  todas tienen el mismo precio, se muestra ese precio; si no hay variantes, el
  precio base del producto.

---

## 4. Tareas siguientes (backlog sugerido)

- [x] Mostrar rango de precios (`$X – $Y`) en la lista de productos cuando las
      variantes tienen precios distintos.
- [ ] Historial de precios por variante (hoy el precio anterior no se conserva
      al cambiarlo).
- [ ] Programar ofertas con fecha de inicio/fin por variante.
- [ ] En Android, ofrecer “Compartir carpeta” o similar en lugar de “Abrir
      carpeta”.
- [ ] Exportar el listado de archivos de un snapshot a texto/CSV para soporte.

---

## 5. Archivos de referencia

| Archivo | Para qué |
|---|---|
| `src/domain/commands.ts` | `generateVariants()` con `overrides`, `setInitialStock()`. |
| `src/ui/views/productNew.ts` | Matriz de stock/precio al crear producto. |
| `src/ui/views/products.ts` | Modal de variantes y edición de precios. |
| `src-tauri/src/backup.rs` | Snapshots, `longlife_files`, `longlife_open_folder`. |
| `src-tauri/src/lib.rs` | Registro de comandos Tauri. |
| `src/ui/views/settingsBackup.ts` | UI de copias, archivos y apertura de carpeta. |
| `docs/PROGRESO.md` | Bitácora general del proyecto. |
| `docs/SYNC_ROBUSTNESS_CHECKLIST.md` | Detalle de snapshots y sincronización. |

---

## 6. Reglas para no romper datos

- No editar a mano archivos dentro de `<bóveda>/omega/events/`.
- Antes de restaurar una copia, actualizar la copia del día o aceptar que se
  guarde una copia `pre-restore-*`.
- Las copias se conservan por dispositivo: **no** borrar
  `<bóveda>/longlife/<otro-dispositivo>/` desde un equipo que no es ese.
- El llavero viaja dentro del snapshot; sin la contraseña maestra (o el código
  de recuperación) la copia cifrada no sirve.
- No commitear archivos personales: `docs/KEYSTORES.md`, `scripts/sign-local.sh`
  y `scripts/verify-signing.sh`.
