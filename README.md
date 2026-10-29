# Inventario Tienda

Local-first inventory management for apparel business (t-shirts and hoodies). Stack: **Tauri 2 + TypeScript vanilla + Vite**, persistence in **Event Sourcing (JSONL append-only)**, no SQL `.db`.

## Features

### Catalog
- Collections with season/year and summary (sales, units produced, margin).
- Products with SKU, type (t-shirt/hoodie), price and costs (fabric, printing, labor, other).
- Colors with hex code.
- Variants generated in **sizes × colors** grid (fixed sizes: XS, S, M, L, XL, XXL, 3XL).
- Minimum stock per variant with alerts.

### Orders
- Create orders with customer, lines (variant + quantity), delivery date and notes.
- States: pending, in production, ready, delivered, cancelled.
- Partial payments and payment states (unpaid, deposit, partial, paid).
- Full or partial line delivery (generates "sale" stock movement).
- Stock availability validation with warning (sale without stock allowed, marked "to produce").
- WhatsApp for customers.
- Order detail printing.

### Production
- Production orders with lines (variant + planned quantity).
- States: planned, in progress, completed, cancelled.
- Complete production (generates "production" stock movement).
- Automatic linking of produced items to open order lines.
- Production suggestions based on pending orders vs available stock.

### Stock
- Stock derived from movements (append-only, immutable).
- Total, reserved (committed by non-cancelled orders) and available stock.
- Movements: production, sale, positive/negative adjustment, return, initial.
- Movement history filterable by type, date and search.
- Minimum stock alerts.

### Customers
- Listing and detail with contact info (phone, email, address, notes).
- Order history and balance per customer.
- Direct WhatsApp link.
- Soft delete (archived) if has orders.

### Expenses
- Expense registration with date, category, description, amount and payment method.
- Summary by category and period.
- Edit and delete expenses.

### Reports
- Income, gross profit, expenses, net profit by period (month/quarter/year/custom).
- Breakdown by collection and top selling products.
- Expenses by category.
- Production of the period.

### Settings and Data
- Device info and storage type.
- Preferences: display currency (ARS/USD/EUR, manual ARS-per-unit rate) and light/dark theme. Amounts are always stored in ARS cents; the selector only changes how they are formatted. The UI is Spanish-only for now.
- Export/import JSON backup (all events). In the native app the export keeps each payload encrypted exactly as it is on disk; the browser development store exports decrypted payloads.
- Initial CSV import (products, customers, orders) with column mapping.
- **Bóveda elegida por el usuario:** los datos viven en `<bóveda>/omega/`; las copias diarias en `<bóveda>/longlife/<dispositivo>/<fecha>/`, con retención de 7 días por dispositivo. La copia del día se actualiza unos minutos después de cada cambio y al cerrar o pasar a segundo plano. No hay sincronización P2P/LAN integrada.
- **Sincronización externa opcional:** la bóveda se puede compartir con un agente de sincronización de archivos o un proveedor de nube. La app lee/escribe la carpeta y tolera copias de conflicto, pero no resuelve conflictos semánticos entre ediciones.
- **Updates:** signed search and installation with minisign. Desktop uses Tauri updater; Android downloads APK, verifies signature and saves to **Downloads** folder for manual installation.
- **Payload encryption (obligatoria):** random 32-byte DEK that encrypts each event `payload` with XChaCha20-Poly1305; the DEK is wrapped (Argon2id) by a master password **and** a one-time recovery code. Metadata stays in plaintext for ordering. The keyring lives in `<bóveda>/omega/keys/keyring.json`; the unlocked key only in RAM. La misma contraseña/código abre la bóveda en otro equipo. Password change re-wraps the DEK; key rotation re-encrypts everything.
- **Pre-encryption backups:** activating or rotating encryption writes plaintext copies under `omega/backups/pre-encryption-*`. They are excluded from longlife; Ajustes > Cifrado lets you review and delete them.
- **Clear data:** before emptying the event files, the app refreshes today's longlife snapshot. The automatic refresh refuses to replace a non-empty snapshot with an empty `omega`, so the pre-clear copy is preserved.
- **Restore:** Ajustes > Respaldo lists snapshots grouped by device, validates every hash, creates a `pre-restore-*` copy, clears the local journal and replaces `omega` under a write lock. The app reloads locked so the restored keyring can be unlocked.
- **Device identity:** `device_id` belongs to the local installation (app data dir), not to the vault. Copying the vault to another computer yields a different id. A heartbeat in `omega/writer.json` warns when another device opened the vault recently; the single-writer rule is still manual.
- Risk zone (clear data).

### Data Semantics
- **UUID v7 IDs** (time-sortable, no autoincrement).
- `created_at` / `updated_at` / `deleted_at` / `device_id` on every entity.
- `device_id` is the local installation id (outside the vault); events keep the id of the device that wrote them.
- Money always in **ARS cents** (integers).
- Changes recorded as immutable events; state is derived (not overwritten).
- Conflict resolution: movements always merged; editable fields LWW per field with HLC.

### Usage Mode
- 100% local / offline, no cloud or mandatory accounts.
- Web development: `npm run dev` (Vite at `http://127.0.0.1:1420`).
- Native app: `npm run app:dev` (Tauri) / `npm run app:build`.
- Desktop: el usuario elige una carpeta bóveda; los datos quedan en `<bóveda>/omega`.
- Android: el usuario elige una carpeta mediante SAF; los datos quedan en `<bóveda>/omega`.
- No hay sync P2P/LAN. Para compartir entre equipos, usar un agente de sincronización externo sobre la carpeta y no editar en dos equipos a la vez.
- Manual JSON export plus automatic snapshots in `<bóveda>/longlife` (daily, refreshed after changes; local o nube si la bóveda está sincronizada).

## Known limitations and continuity

- `docs/LIMITACIONES_CHECKLIST.md`: staged checklist for the remaining known issues, offline verification commands and the pending physical Android test with an external sync agent.
- The UI is Spanish-only for now; the English selector was removed until translations exist.
- Multi-currency is display-only with a manual ARS-per-unit rate; all stored amounts remain ARS cents.
- The single-writer rule is still manual. The app warns when another installation touched the vault recently, but does not merge conflicts.

### Development Requirements
- Node 20+ and npm.
- Rust (for Tauri).
- Android Studio + NDK (for Android builds).

### Documentation
- See `docs/IMPLEMENTATION_MANUAL.md` for complete implementation details.

## License

MIT
