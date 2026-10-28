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
- Preferences: currency (ARS/USD/EUR) and light/dark theme.
- Export/import JSON backup (all events).
- Initial CSV import (products, customers, orders) with column mapping.
- **Bóveda elegida por el usuario:** los datos viven en `<bóveda>/omega/`; las copias diarias en `<bóveda>/longlife/YYYY-MM-DD/`, con retención de 7 días. No hay sincronización P2P/LAN integrada.
- **Sincronización externa opcional:** la bóveda se puede compartir con Google Drive + Foldersync, Syncthing u otro agente de archivos. La app solo lee/escribe la carpeta; no fusiona conflictos.
- **Updates:** signed search and installation with minisign. Desktop uses Tauri updater; Android downloads APK, verifies signature and saves to **Downloads** folder for manual installation.
- **Payload encryption (obligatoria):** random 32-byte DEK that encrypts each event `payload` with XChaCha20-Poly1305; the DEK is wrapped (Argon2id) by a master password **and** a one-time recovery code. Metadata stays in plaintext for ordering. The keyring lives in `<bóveda>/omega/keys/keyring.json`; the unlocked key only in RAM. La misma contraseña/código abre la bóveda en otro equipo. Password change re-wraps the DEK; key rotation re-encrypts everything.
- Risk zone (clear data — pending full implementation).

### Data Semantics
- **UUID v7 IDs** (time-sortable, no autoincrement).
- `created_at` / `updated_at` / `deleted_at` / `device_id` on every entity.
- Money always in **ARS cents** (integers).
- Changes recorded as immutable events; state is derived (not overwritten).
- Conflict resolution: movements always merged; editable fields LWW per field with HLC.

### Usage Mode
- 100% local / offline, no cloud or mandatory accounts.
- Web development: `npm run dev` (Vite at `http://127.0.0.1:1420`).
- Native app: `npm run app:dev` (Tauri) / `npm run app:build`.
- Desktop: el usuario elige una carpeta bóveda; los datos quedan en `<bóveda>/omega`.
- Android: el usuario elige una carpeta mediante SAF; los datos quedan en `<bóveda>/omega`.
- No hay sync P2P/LAN. Para compartir entre equipos, usar un agente externo sobre la carpeta (Google Drive + Foldersync, Syncthing, etc.) y no editar en dos equipos a la vez.
- Manual JSON export plus daily snapshots in `<bóveda>/longlife` (local o nube si la bóveda está sincronizada).

### Development Requirements
- Node 20+ and npm.
- Rust (for Tauri).
- Android Studio + NDK (for Android builds).

### Documentation
- See `docs/IMPLEMENTATION_MANUAL.md` for complete implementation details.

## License

MIT
