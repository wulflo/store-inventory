# Implementation Manual: Local-First Inventory App with P2P LAN Sync (Android + Desktop)

> **OBSOLETO para v0.2.11:** este manual describe la versión 0.1.7, que incluía
> sincronización P2P/LAN. Esa función fue eliminada en v0.2.11. La fuente de
> verdad actual es `docs/REFACTOR_VAULT_CHECKLIST.md`; para compartir datos
> entre equipos se usa una bóveda externa sincronizada (Google Drive +
> Foldersync, Syncthing, etc.).

**Version:** 0.1.7  
**Date:** 2026-10-27  
**Stack:** Tauri v2 + Rust + TypeScript (vanilla) + Vite  
**Platforms:** Linux, Windows, Android (minSdk 28)

---

## 1. Overview

This manual documents the complete implementation of "Inventario Tienda", a local-first inventory management app that runs on desktop (Linux/Windows) and Android, with **peer-to-peer synchronization over LAN** using mutual TLS (mTLS) + certificate pinning + SAS pairing. It covers all corrections applied during development, especially Android permissions, the runtime Tauri error, and the updater.

### Key design principles
- **Local-first / offline-first**: all data lives in append-only JSONL files (Event Sourcing). No cloud, no accounts.
- **P2P LAN sync**: devices pair via 6-digit SAS code, then sync deltas (only missing events) over TLS 1.3 with mutual authentication and certificate pinning.
- **Append-only events**: events are never overwritten or deleted. State is derived from the event log.
- **LAN-only**: sync connections are restricted to RFC1918/link-local/ULA/loopback IPs. No Internet connections.

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (TypeScript)                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │  Views   │ │  Store   │ │  Sync UI │ │  Updater UI  │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
│       │            │            │              │           │
│  ┌────┴────────────┴────────────┴──────────────┴───────┐   │
│  │              Tauri IPC (invoke / listen)            │   │
│  └────┬────────────┬────────────┬──────────────┬───────┘   │
└───────┼────────────┼────────────┼──────────────┼───────────┘
        │            │            │              │
┌───────┴────────────┴────────────┴──────────────┴───────────┐
│                    Rust Backend (Tauri v2)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Event    │ │  Sync    │ │  Backup  │ │  Updater     │   │
│  │ Store    │ │  Manager │ │  Vault   │ │  (desktop/   │   │
│  │ (JSONL)  │ │ (mTLS)   │ │  (SAF)   │ │   Android)   │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                    │
│  │ Android  │ │  Net     │ │  TLS     │                    │
│  │ FS (JNI) │ │  (LAN)   │ │  (mTLS)  │                    │
│  └──────────┘ └──────────┘ └──────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### Data flow
- **Local data**: `events/<domain>.jsonl` (append-only) + `device_id` file
- **Sync**: TLS 1.3 mutual auth → exchange ID lists → send only missing events → append + dedupe
- **Backup**: daily snapshots to `backups/daily/YYYY-MM-DD/` + optional external vault

---

## 3. Project Structure

```
inventario-tienda/
├── src/                          # Frontend TypeScript
│   ├── main.ts                   # App bootstrap, routing, auto-sync init
│   ├── app/App.ts                # App state and event sourcing
│   ├── store/
│   │   ├── EventStore.ts         # Interface + WebEventStore
│   │   └── TauriEventStore.ts    # Tauri-backed store (invoke to Rust)
│   ├── sync/
│   │   └── autoSync.ts           # Auto-sync: debounce, backoff, battery
│   └── ui/
│       ├── views/                # All views (dashboard, orders, etc.)
│       │   ├── settings.ts       # Settings view
│       │   ├── settingsBackup.ts # Backup UI
│       │   ├── settingsSync.ts   # P2P sync UI
│       │   ├── settingsAutoSync.ts # Auto-sync + battery UI
│       │   └── settingsUpdates.ts # Updater UI
│       └── ...
├── src-tauri/                    # Rust backend
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── capabilities/
│   │   └── default.json          # Tauri v2 capabilities
│   ├── src/
│   │   ├── lib.rs                # Main entry, plugin registration, commands
│   │   ├── event_store.rs        # JSONL append/read/mtime/device_id
│   │   ├── backup.rs             # Daily backup + vault + pull/merge
│   │   ├── android_fs.rs         # JNI bridge for Android (Downloads, Vault, battery)
│   │   ├── updater.rs            # Multi-platform updater
│   │   └── sync/
│   │       ├── manager.rs        # SyncManager state machine
│   │       ├── client.rs         # TLS client + delta sync
│   │       ├── server.rs         # TLS server + delta sync + rate limiting
│   │       ├── protocol.rs       # DomainSummary, diff, batch, validate
│   │       ├── framing.rs        # Frame types, read/write frames
│   │       ├── wire.rs           # JSON messages (Hello, Events, IdList, etc.)
│   │       ├── tls.rs            # mTLS config
│   │       ├── identity.rs       # Ed25519 identity + cert
│   │       ├── pairing.rs        # SAS pairing
│   │       ├── peer.rs           # PeersStore (trusted peers)
│   │       ├── net.rs            # LAN IP validation
│   │       ├── store.rs          # Load/append/summary helpers
│   │       └── discovery.rs      # Multicast discovery
│   └── gen/android/              # Android generated code
│       └── app/src/main/
│           ├── AndroidManifest.xml
│           └── java/com/inventariotienda/app/
│               ├── MainActivity.kt
│               ├── Downloads.kt
│               └── Vault.kt
├── docs/
│   └── IMPLEMENTATION_MANUAL.md  # This file
├── scripts/
│   ├── version.mjs               # Version management
│   └── latest-json.mjs           # Release manifest generator
├── .github/workflows/
│   └── release.yml               # CI/CD release workflow
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## 4. Tauri v2 Setup and Runtime Error Fix

### 4.1 The Problem

When running `npm run app:dev` (Tauri v2), the app showed a white screen with:
```
event.listen not allowed. Permissions associated with this command: core:event:allow-listen, core:event:default
```

Additionally, commands like `store_read` failed with:
```
invalid args `args` for command `store_read`: command store_read missing required key args
```

### 4.2 Root Causes

1. **Missing capabilities file**: Tauri v2 requires a `capabilities/default.json` file declaring permissions. Without it, `core:event:allow-listen` was not granted, so `listen()` from `@tauri-apps/api/event` failed.

2. **Argument mismatch**: Rust commands were defined with a single `args: ReadArgs` struct parameter, but the frontend called them with flat objects `{ root, domain }`. Tauri v2 maps JSON keys to function parameters directly.

3. **Missing plugin registration**: `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-opener` were in Cargo.toml but not registered in `lib.rs`.

### 4.3 The Fix

**A) Register plugins in `lib.rs`:**
```rust
let mut builder = tauri::Builder::default()
  .plugin(tauri_plugin_dialog::init())
  .plugin(tauri_plugin_fs::init())
  .plugin(tauri_plugin_opener::init());
```

**B) Create `src-tauri/capabilities/default.json`:**
```json
{
  "identifier": "default",
  "description": "Default permissions",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:event:allow-listen",
    "core:event:allow-emit",
    "core:event:allow-unlisten",
    "core:window:default",
    "core:app:default"
  ]
}
```

**C) Flatten command arguments in `event_store.rs`:**
```rust
// Before (broken):
#[tauri::command]
pub fn store_read(args: ReadArgs) -> Result<String, String> { ... }

// After (fixed):
#[tauri::command]
pub fn store_read(root: String, domain: String) -> Result<String, String> { ... }
```

Same for `store_append`, `store_mtimes`, `store_device_id`.

**D) Register commands in `lib.rs` `generate_handler!`:**
```rust
.invoke_handler(tauri::generate_handler![
  get_app_data_dir,
  store_default_root,
  store_ensure_layout,
  store_append,
  store_read,
  store_mtimes,
  store_device_id,
  // ... sync, backup, updater commands
])
```

---

## 5. P2P LAN Sync Protocol

### 5.1 Identity

- **Algorithm**: Ed25519 key pair + self-signed certificate (rcgen)
- **Device ID**: `SHA-256(cert_der)` hex (first 32 chars)
- **Fingerprint**: SHA-256 of cert DER, formatted as hex groups
- **Persistence**: `identity/identity.pem` + `identity/certificate.pem` in app data dir
- **Device name**: persisted in `identity/name.txt`, survives reinstalls

### 5.2 Network Restrictions (LAN-only)

**File:** `src-tauri/src/sync/net.rs`

```rust
pub fn is_lan_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local()
      || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 2),
    IpAddr::V6(v6) => v6.is_loopback() || v6.is_unique_local() || v6.is_unicast_link_local(),
  }
}

pub fn validate_peer_addr(input: &str, default_port: u16) -> Result<SocketAddr, String> {
  // Rejects hostnames (no DNS), parses IP directly
  // Rejects non-LAN IPs with error
  // Rejects port 0
}
```

**Key points:**
- No DNS resolution (prevents DNS rebinding)
- Only RFC1918 (10.x, 172.16-31.x, 192.168.x), link-local, ULA, loopback
- Multicast restricted to 224.0.0.0/24 (IPv4) or ff02::/16 (IPv6)

### 5.3 TLS 1.3 Mutual Authentication

**File:** `src-tauri/src/sync/tls.rs`

- Server config: requires client certificate (mTLS), validates against pinned peer cert
- Client config: custom certificate verifier pins server cert to expected fingerprint
- Rustls with ring provider
- Certificate pinning: client verifies server cert matches `peer.cert_pem` stored during pairing

### 5.4 SAS Pairing

**File:** `src-tauri/src/sync/pairing.rs`

1. Both devices generate ephemeral pairing cert
2. Exchange cert + device_id + fingerprint over TLS
3. SAS code = `SHA-256(local_fp || remote_fp || transcript) % 1_000_000` (6 digits)
4. User manually verifies SAS code matches on both devices
5. On confirmation: peer saved to `peers.json` with `trusted=true`, cert pinned
6. Peer can be revoked at any time

### 5.5 Sync Protocol (Delta by IDs)

**Files:** `src-tauri/src/sync/client.rs`, `server.rs`, `protocol.rs`, `wire.rs`, `framing.rs`

**Frame types:**
| Type | Value | Purpose |
|---|---|---|
| Handshake | 0 | Device identity exchange |
| Summary | 1 | Domain event counts/hashes (quick divergence check) |
| IdList | 2 | List of event IDs per domain (delta sync) |
| Events | 3 | Batch of events to send |
| BatchAck | 4 | Acknowledgment |
| Error | 5 | Error message |
| KeepAlive | 6 | Keep connection alive |
| Bye | 7 | End session |

**Sync flow:**
1. Client connects via TCP to server IP (validated LAN)
2. TLS 1.3 handshake + cert pinning verification
3. Exchange `SyncHello` (device_id, name, fingerprint, protocol_version)
4. Exchange `SyncSummary` (domain counts + aggregate hashes)
5. **Delta sync**: Client sends `IdList` (all event IDs it has per domain)
6. Server compares, sends only events whose IDs are NOT in client's list
7. Server sends its `IdList`; client responds with missing events
8. Both sides `append_missing()` (dedupe by event ID)
9. Exchange `Bye`

**Key properties:**
- **Append-only**: events are never overwritten
- **Idempotent**: dedupe by event ID prevents duplicates
- **Minimal traffic**: only missing events travel
- **HLC validation**: events with future HLC (> 24h) rejected
- **Batch limits**: max 500 events or 512 KiB per batch
- **Frame limit**: max 1 MiB per frame

### 5.6 Rate Limiting and Security Logging

**File:** `src-tauri/src/sync/server.rs`

- Max 20 connections per minute per IP (token bucket)
- Rejected connections logged: `[sync] RECHAZO: IP no LAN`, `[sync] RECHAZO rate-limit`, `[sync] RECHAZO pinning`

---

## 6. Android Implementation

### 6.1 AndroidManifest.xml

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />
<!-- Android 9: write to public Downloads -->
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />
<!-- Android 8+: install APKs -->
<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />
```

### 6.2 Downloads.kt (APK save + install)

**File:** `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Downloads.kt`

- **Android 10+ (API 29+)**: Uses `MediaStore.Downloads` (no storage permission needed)
- **Android 9 (API 28)**: Writes directly to public Downloads dir, requires `WRITE_EXTERNAL_STORAGE` runtime permission
- **Install**: Uses `FileProvider` (Android 7+) or direct Uri (legacy), grants read permission to installer

### 6.3 Vault.kt (SAF persistent vault)

**File:** `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Vault.kt`

- `ACTION_OPEN_DOCUMENT_TREE` via Tauri dialog plugin (SAF)
- `takePersistableUriPermission` for read+write
- `DocumentFile` API for create/read/write/list
- Survives app restart and phone reboot
- Permission lost on app uninstall (Android behavior)

### 6.4 android_fs.rs (JNI bridge)

**File:** `src-tauri/src/android_fs.rs`

Functions:
- `save_to_downloads()` / `install_apk()` - APK updater
- `vault_is_accessible()` / `vault_create_dir()` / `vault_write_file()` / `vault_store_uri()` / `vault_get_stored_uri()` / `vault_clear_uri()` / `vault_take_permission()` - SAF vault
- `battery_info()` - PowerManager + BatteryManager

### 6.5 MainActivity.kt

- Edge-to-edge support (Android 15+)
- Permission result forwarding to `Downloads.onPermissionResult()`
- Instance reference for JNI permission requests

---

## 7. Daily Backup System

### 7.1 Backup flow

**File:** `src-tauri/src/backup.rs`

1. Create `backups/daily/YYYY-MM-DD/` directory
2. Copy all `events/*.jsonl` files + `device_id`
3. Calculate SHA-256 per file + total hash
4. Write `manifest.json` with metadata
5. If vault configured: copy to vault path (desktop: filesystem, Android: SAF)
6. Return `BackupResult` with errors (never fail silently)

### 7.2 Vault support

- **Desktop**: normal filesystem path, validated before each backup
- **Android**: SAF URI (`content://`), accessed via `Vault.kt` JNI
- `backup_check_vault`: verifies accessibility, returns error if lost
- `backup_set_vault`: stores path or SAF URI in `settings.json`
- `backup_pull_from_vault`: merges events from vault (append-only by ID) from all other devices

### 7.3 Auto-backup

- On app open: if no backup for today, create one
- Respects battery saver mode

---

## 8. Updater

### 8.1 Desktop

- Uses `tauri-plugin-updater` with minisign verification
- Checks `latest.json` from GitHub releases
- Downloads and installs signed update
- Requires app restart

### 8.2 Android

- Fetches `latest.json` from GitHub
- Maps architecture to APK target (`android-aarch64`, `android-universal`, etc.)
- Downloads APK via `reqwest` (rustls)
- Verifies minisign signature
- Saves to public Downloads via `MediaStore` (API 29+) or direct (API 28)
- Launches installer via `FileProvider` + `REQUEST_INSTALL_PACKAGES`
- Base64-encodes `.sig` content in `latest.json`

### 8.3 latest.json format

```json
{
  "version": "0.1.6",
  "notes": "Release notes",
  "pub_date": "2026-10-27T00:00:00Z",
  "platforms": {
    "linux-x86_64": { "url": "...", "signature": "base64(sig)" },
    "windows-x86_64": { "url": "...", "signature": "base64(sig)" },
    "android-aarch64": { "url": "...", "signature": "base64(sig)" },
    "android-universal": { "url": "...", "signature": "base64(sig)" }
  }
}
```

---

## 9. Auto-Sync and Battery Saver

### 9.1 Auto-sync triggers

1. On app open / return to foreground
2. After local change (`store_append`) with debounce
3. Periodic (every 5 min in normal mode)
4. When discovery detects a paired peer in LAN (not implemented yet)
5. Android background via WorkManager (not implemented yet)

### 9.2 Conditions

- Single-flight: one sync at a time (global flag)
- Exponential backoff on failure (5s → 10s → 20s → ... → 5min max)
- No sync if no WiFi/LAN or no peers
- Loop prevention: received events don't trigger immediate re-sync; second round without differences stops

### 9.3 Battery saver mode

- **Switch 1**: "Auto-sync enabled" (on/off)
- **Switch 2**: "Respect battery saver" (default: on)
- When battery saver is on AND (system power save mode OR battery < 15% without charging):
  - **Ahorro mode**: only on open/foreground, debounce 60s, no periodic, no WorkManager
- When battery saver is off OR normal conditions:
  - **Normal mode**: debounce 10s, periodic every 5 min, WorkManager enabled
- Effective mode shown in UI: "Normal" / "Ahorro (por ahorro de batería del sistema)"

### 9.4 Configuration storage

`sync_auto.json` in app data dir:
```json
{
  "enabled": true,
  "respect_battery_saver": true
}
```

---

## 10. Payload Encryption at Rest

Per-event encryption protects the **content** of the events on disk while
keeping the metadata in plaintext, so ordering, deduplication and sync keep
working without the master password.

Encryption is **opt-in** from *Ajustes → Cifrado de datos*. Once enabled it is
one-way: there is no "disable encryption" command. To go back to plaintext you
must restore a backup made before enabling.

### 10.1 Envelope model (why the password is not the data key)

The password does **not** encrypt the events directly. The design is envelope
encryption:

1. A random 32-byte **DEK** (data encryption key) encrypts every event
   `payload` with XChaCha20-Poly1305.
2. The DEK is stored in `keys/keyring.json` **wrapped** by two independent
   keys derived with Argon2id:
   - one from the **master password**,
   - one from a **recovery code** (Crockford Base32, 20 random bytes → 32
     characters shown as 8 groups of 4).

Changing the password only re-wraps the 32-byte DEK: the events are **not**
re-encrypted. Rotating the key (revoking a device) creates a new random DEK
and re-encrypts everything.

| Layer | Choice |
|---|---|
| DEK | 32 random bytes (`rand`) |
| KEK | Argon2id (64 MiB, t=3, p=1, random 16-byte salt per keyring) |
| Cipher | XChaCha20-Poly1305, 24-byte random nonce per payload |
| AAD | `inventario-event-v2\|{id}\|{type}` (binds ciphertext to its event) |
| `kid` | first 8 bytes of SHA-256(DEK), Base64 → 11 chars |
| Encoding | Base64 URL-safe (no padding) for keyring fields; standard Base64 for payloads |
| Key storage | RAM only, per data root (`Mutex<BTreeMap<root, KeyMaterial>>`) |

`keys/keyring.json` (permissions `0600` on Unix, atomic `tmp` + rename):

```json
{
  "version": 1,
  "kid": "H1-UD2qSeKs",
  "kdf": { "alg": "argon2id", "m_cost": 65536, "t_cost": 3, "p_cost": 1, "salt": "..." },
  "wraps": [
    { "kind": "password", "nonce": "...", "data": "...", "created_at": 1793124748128 },
    { "kind": "recovery", "nonce": "...", "data": "...", "created_at": 1793124751127 }
  ]
}
```

The keyring does **not** contain the password, the recovery code or the DEK in
plaintext. Losing both the password and the recovery code makes the data
unrecoverable; there is no backdoor.

An encrypted event on disk:

```json
{
  "id": "0192f3a4-...",
  "type": "Order.Created",
  "payload": {
    "_encrypted": true,
    "v": 2,
    "alg": "XChaCha20-Poly1305",
    "kid": "H1-UD2qSeKs",
    "data": "base64(ciphertext)",
    "nonce": "base64(24 bytes)"
  },
  "metadata": { "hlc": 1793122609026000, "deviceId": "...", "timestamp": 1793122609026, "version": 1 }
}
```

Because the AAD includes `id` and `type`, moving a ciphertext to another event
fails authentication (the reader marks it with `_error` instead of showing
wrong data).

### 10.2 Multi-device coherence (important)

Each keyring has a **random salt and a random DEK**, so the same password typed
on two devices does **not** produce the same key. Devices that share data must
share the **keyring**:

- New device without encryption: *Ajustes → Cifrado → Importar llavero*, pick
  the `keyring.json` exported from the other device, then enter the same
  password (or recovery code). This imports the DEK and leaves the device
  unlocked. If the device already has plaintext events (for example, files
  copied by hand), they are backed up and encrypted with the imported key.
- Device that already had encryption and must follow a **rotation**: *Adoptar
  llavero*. It decrypts local events with the old key, saves the new keyring
  and re-encrypts them with the new DEK. Events that already arrived with the
  new `kid` are left intact.
- **Exportar llavero** shows the JSON and offers *Copiar* / *Descargar*.
  Import uses an HTML file input (`file.text()`), which also works on Android
  where content URIs are not real paths.

Sync rejects events whose `kid` differs from the local one instead of storing
unreadable data. The error tells the user to import/adopt the keyring.

After importing, each device can change its **local** password (*Cambiar
contraseña*): that only re-wraps the same DEK in that device's keyring, so the
shared `kid` and sync keep working. The recovery code belongs to the keyring
and stays valid until a rotation generates a new keyring.

Daily backups include `keyring.json`, so restoring a backup on another device
is self-sufficient: copy the events and the backup's `keyring.json` into
`keys/keyring.json` (or use *Importar llavero*), then enter the password. The
keyring is wrapped, not encrypted with a separate key; treat it as sensitive.
Backups made **before** enabling encryption remain plaintext; delete them if
that matters.

### 10.3 Migration, rotation and safety

All key-changing operations back up the data first and verify it afterwards:

1. Derive the keys (Argon2id).
2. Copy every `events/*.jsonl` to
   `backups/pre-encryption-<timestamp>/events/`.
3. **Enable**: save `keys/keyring.json` before touching the data, so an
   interruption never leaves encrypted files without their key.
   **Rotate/adopt**: write the new keyring to `keys/keyring.next.json`
   (`stage`); the active keyring is still the old one.
4. Take `EVENTS_WRITE_LOCK` (no concurrent appends) and re-encrypt each line
   into `*.jsonl.tmp` (fsync) with an atomic rename.
5. Enable: if migration fails, restore the events from the backup and remove
   the keyring (back to plaintext). Rotate/adopt: discard the staged keyring,
   restore the events from the backup and keep the old key active. If the
   restore itself fails, the error says so and points to the backup (and to
   `keyring.next.json` if it holds the only copy of the new key).
6. On success, enable keeps the already-saved keyring; rotate/adopt activate
   the staged one with an atomic rename (`keyring.next.json` →
   `keyring.json`) and only then put the new key in RAM.
7. Verify that **every** line decrypts with the new key; a mismatch aborts with
   the backup path.

Other error paths:

- `ENC_LOCKED:` is returned by store reads/writes and by sync when a keyring
  exists but the key is not in RAM. The frontend shows the unlock screen before
  `App.init()`, so this normally only happens if the key is cleared mid-session.
- Enabling is blocked if a keyring already exists.
- Importing a keyring is blocked if the device already has one (use *Adoptar*).
- Vault merge requires unlock; it encrypts incoming plaintext, skips events
  with a foreign `kid`, deduplicates by `id` (not by full line) and reports
  `skipped_incompatible`.

### 10.4 Rust API

`src-tauri/src/keys.rs`:

| Item | Purpose |
|---|---|
| `KdfParams` | Argon2id params + random salt; `derive(secret)` → 32-byte KEK |
| `Keyring` / `Wrap` | Versioned on-disk format with `kid` and wrapped DEK |
| `create(password, kdf)` | New DEK + password/recovery wraps + recovery code |
| `unlock(root, secret)` | Load keyring and unwrap with password or recovery code |
| `change_password(root, current, new)` | Re-wrap the same DEK (no re-encryption) |
| `save` / `load` / `parse` | Atomic 0600 save; strict parse/version/KDF bounds |
| `stage` / `commit_staged` / `discard_staged` | Prepare, activate or discard `keyring.next.json` during rotation/adoption |

`src-tauri/src/crypto.rs`:

| Item | Purpose |
|---|---|
| `resolve_key(root)` | `None` (plaintext mode) / `Some(KeyMaterial)` / `ENC_LOCKED:` |
| `encrypt_event_line` / `decrypt_event_line` | Transform only `payload`, keep metadata; legacy 0.1.x fallback |
| `encrypt_event_value` / `ensure_compatible_payload` | Sync/vault paths; idempotent, rejects foreign `kid` |
| `migrate_files` / `verify_files` | Atomic re-encryption + full verification |
| `current_key` / `set_current` / `clear_current` | Per-root in-memory map (test isolation, multi-root safety) |

Tauri commands:

| Command | Flow |
|---|---|
| `crypto_boot_state(root)` | `{ enabled, unlocked, kid }` for the boot gate |
| `crypto_enable(root, password)` | Create keyring, backup, migrate, verify → recovery code |
| `crypto_unlock(root, secret)` | Password **or** recovery code → key in RAM |
| `crypto_lock()` | Wipe all keys from RAM |
| `crypto_status()` | `true` if any key is unlocked |
| `crypto_change_password(root, currentSecret, newPassword)` | Re-wrap only |
| `crypto_rotate(root, currentSecret, newPassword)` | New DEK + full re-encryption → new recovery code |
| `crypto_keyring_json(root)` | Export the wrapped keyring |
| `crypto_import_keyring(root, keyringJson, secret)` | First device setup from another device; encrypts existing plaintext events |
| `crypto_adopt_keyring(root, keyringJson, currentSecret, newSecret)` | Follow a rotation |
| `crypto_encrypt_text` / `crypto_decrypt_text` | Diagnostics (require a root) |
| `crypto_append_event` / `crypto_read_events` | Diagnostic flows |

The normal store is transparent: `event_store::store_append` encrypts and
`store_read` decrypts when a keyring exists. `sync::store::append_missing`
encrypts incoming plaintext, validates `kid` and fails with `ENC_LOCKED:` when
locked.

### 10.5 Frontend

- `src/ui/views/unlock.ts`: full-screen unlock before `app.init()`; supports
  password or recovery-code modes; errors are shown inline.
- `src/ui/views/settingsCrypto.ts`: enable (password + confirmation + warning),
  one-time recovery-code modal (copy/download), lock (reload → unlock screen),
  change password, rotate (new recovery code), export keyring, import keyring,
  adopt keyring.
- `src/ui/views/settingsBackup.ts`: warns when vault merge skipped incompatible
  events.
- `src/store/TauriEventStore.ts`: deduplicates by event `id` after merges.

Limitations: losing password **and** recovery code is unrecoverable; backups
made before enabling are plaintext; changing the password does not revoke an
attacker who already copied the old keyring + password (use rotation for that);
rotation re-encrypts the live data but **does not delete old backups or vault
copies** made with the previous key, so remove those separately if they matter;
the in-memory key is not protected against a compromised OS or memory dump.


---

## 11. Security Review Summary

### Threat model
- LAN-only communication
- Devices are trusted after SAS pairing
- Device compromise is out of scope

### Controls implemented

| Control | Status | Details |
|---|---|---|
| TLS 1.3 | ✅ | Rustls with ring provider |
| mTLS | ✅ | Both client and server present certs |
| Certificate pinning | ✅ | Client pins server cert; server validates client against peers.json |
| SAS pairing | ✅ | 6-digit code, manual verification |
| LAN-only IP validation | ✅ | RFC1918/link-local/ULA/loopback only, no DNS |
| Multicast restriction | ✅ | 224.0.0.0/24 or ff02::/16 only |
| Rate limiting | ✅ | 20 connections/min per IP |
| Security logging | ✅ | Rejected connections logged |
| Append-only events | ✅ | No overwrites, dedupe by ID |
| HLC validation | ✅ | Future events rejected (> 24h tolerance) |
| Frame/batch limits | ✅ | 1 MiB frame, 500 events/512 KiB batch |
| No Internet connections | ✅ | Fallback UDP to 8.8.8.8 removed |
| Payload encryption at rest | ✅ (opt-in) | Random DEK + Argon2id-wrapped password/recovery keys, XChaCha20-Poly1305, AAD `id\|type` |

### Known limitations
- `0.0.0.0` bind (necessary for multi-interface LAN, filtered by IP)
- Encryption at rest is opt-in and only covers `payload`; metadata stays readable
- Recovery depends on sharing `keyring.json` between devices (the same password alone is not enough)
- Changing the password does not revoke an attacker who already has the old keyring + password; use key rotation
- Backups created before enabling encryption stay plaintext until deleted
- No rate limiting on handshake/pairing (only sync connections)

---

## 12. Corrections Applied During Development

### 12.1 Runtime Tauri Error (White Screen)

**Problem:** `event.listen not allowed` + `store_read missing required key args`

**Fixes:**
1. Created `capabilities/default.json` with `core:event:allow-listen` etc.
2. Registered `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-opener` in `lib.rs`
3. Flattened command args (`store_read(root, domain)` instead of `store_read(args: ReadArgs)`)

### 12.2 Android Layout (Portrait)

**Problem:** UI not adapted to vertical screens.

**Fixes:**
- CSS safe areas (`viewport-fit=cover`, `env(safe-area-inset-*)`)
- Responsive breakpoints for mobile
- Touch-friendly input sizes (min 44px)

### 12.3 Android Updater

**Problem:** No way to install APK updates on Android.

**Fixes:**
- Fetch `latest.json`, verify minisign
- Download APK via `reqwest` (rustls)
- Save to public Downloads via `MediaStore` (API 29+) or direct (API 28)
- Launch installer via `FileProvider` + `REQUEST_INSTALL_PACKAGES`
- Base64-encode `.sig` in `latest.json`

### 12.4 Desktop Updates

**Problem:** Desktop updater not working.

**Fixes:**
- Registered `tauri-plugin-updater` in `lib.rs`
- Added `createUpdaterArtifacts: true` in `tauri.conf.json`
- CI signs artifacts with Tauri signing key

### 12.5 Permission Issues

**Problem:** Various permission errors on Android and desktop.

**Fixes:**
- Added `REQUEST_INSTALL_PACKAGES` to manifest
- Added `WRITE_EXTERNAL_STORAGE` (maxSdkVersion 28) for Android 9
- Created capabilities file with minimal permissions
- Removed restrictive custom capabilities

### 12.6 Data Loss Prevention

**Problem:** No backup mechanism.

**Fixes:**
- Daily backup to `backups/daily/YYYY-MM-DD/`
- External vault support (desktop: filesystem, Android: SAF)
- `backup_pull_from_vault`: merge from other devices (append-only by ID)
- SHA-256 integrity verification
- Error propagation (never fail silently)

### 12.7 Sync Efficiency

**Problem:** Sending full domain history on every sync.

**Fixes:**
- Delta sync by ID exchange (`IdList` frame type)
- Only missing events travel
- Append + dedupe on receive

### 12.8 Security

**Problem:** Potential Internet traffic from fallback.

**Fixes:**
- Removed UDP fallback to 8.8.8.8 in `local_lan_addresses()`
- Added rate limiting (20 conn/min per IP)
- Added security logging
- Created security review documentation

### 12.9 Settings page rendered only the title

**Problem:** Selecting *Ajustes* showed the page title but an empty body.

**Cause:** `el()` in `src/ui/dom.ts` assumed `style` was an object. Cards passed
a CSS string (`style: 'justify-content: space-between;'`), and
`Object.entries(string)` produced numeric keys, so `node.style['0'] = 'j'`
threw `TypeError: Failed to set an indexed property [0] on
'CSSStyleDeclaration'`. The exception aborted `settingsView()` before
`mount()`, leaving only the title.

**Fixes:**
- `el()` now accepts `style` as an object **or** a CSS string (`cssText`).
- Object keys are applied with `setProperty()` (camelCase → kebab-case).
- All string-style call sites converted to objects (`settingsCrypto`,
  `settingsAutoSync`, `settingsBackup`).

### 12.10 Android-only compile error (`E0106`)

**Problem:** The v0.1.6 release failed in `build-android` while the desktop
build passed.

**Cause:** `call_vault_static()` in `android_fs.rs` (compiled only for Android)
had elided lifetimes in its `JNIEnv`/`JObject`/`JValue` parameters and return
type.

**Fix:** explicit `'local` lifetime plus an owned `JValueOwned` return, so the
result no longer borrows from the `AttachGuard`. Verified locally with
`cargo check --target aarch64-linux-android --lib`.

---

## 13. Build and Release

### 13.1 Local development

```bash
# Web dev
npm run dev

# Tauri dev (desktop)
npm run app:dev

# Tauri build
npm run app:build
```

### 13.2 CI/CD

**File:** `.github/workflows/release.yml`

- Triggered on `v*.*.*` tag push
- Jobs: verify (tests + typecheck), build-linux, build-windows, build-android, publish
- Artifacts: .deb, .AppImage, .msi, .exe, .apk, .aab
- Updater: signed with Tauri signing key

### 13.3 Version management

```bash
# Check version coherence
node scripts/version.mjs check

# Set new version
node scripts/version.mjs set 0.1.7
```

Synchronizes: `package.json`, `Cargo.toml`, `tauri.conf.json`, `package-lock.json`

### 13.4 Release checklist

1. Update version: `node scripts/version.mjs set X.Y.Z`
2. Push: `git push origin main && git push origin vX.Y.Z`
3. Wait for CI to complete
4. Verify artifacts on GitHub Releases
5. Test updater on desktop + Android

---

## 14. Testing

### 14.1 Rust tests

```bash
cd src-tauri && cargo test
```

**51 tests** covering:
- Sync net (LAN IP validation)
- Sync identity (cert, fingerprint, SAS)
- Sync pairing (registry, handshake)
- Sync protocol (summary, diff, batch, validation)
- Sync TLS (mTLS, pinning)
- Sync store (append, idempotent, summary)
- Sync server (full mTLS exchange)
- Updater (semver, base64 signature)
- Backup (SAF URI, vault path, accessibility)
- Keys (keyring create/unlock, recovery code, password change, rotation)
- Crypto (envelope encryption, AAD binding, migration/verify, per-root lock, legacy fallback)
- Sync store (incoming plaintext encryption, foreign-kid rejection, locked writes)
- Payload encryption migration (real-data copy audit, ignored by default)

### 14.2 Frontend tests

```bash
npm test
```

**49 tests** covering:
- Domain commands
- Event sourcing
- Store operations
- Sync UI

### 14.3 Typecheck

```bash
npm run typecheck  # tsc --noEmit
```

---

## 15. Known Issues and Future Work

### Not implemented (requires more work)
1. **WorkManager** for Android background sync (min 15 min, WiFi only)
2. **MulticastLock** for Android discovery
3. **Discovery → auto-sync trigger** when paired peer detected
4. **Single-flight per peer** (currently global flag)
5. **Frontend unit tests** for debounce/single-flight/backoff
6. **Wire encrypted write/read into the normal store** (commands exist; the default path still writes plaintext)

### Testing not possible in this environment
- Android device testing (SAF, WorkManager, battery saver)
- Windows build verification
- Real LAN sync between two devices
- Android updater (APK install)

---

## 16. Quick Reference: Key Files

| Purpose | File |
|---|---|
| Main entry | `src-tauri/src/lib.rs` |
| Event store (JSONL) | `src-tauri/src/event_store.rs` |
| Sync manager | `src-tauri/src/sync/manager.rs` |
| Sync client (TLS) | `src-tauri/src/sync/client.rs` |
| Sync server (TLS) | `src-tauri/src/sync/server.rs` |
| Sync protocol | `src-tauri/src/sync/protocol.rs` |
| Sync framing | `src-tauri/src/sync/framing.rs` |
| Sync wire format | `src-tauri/src/sync/wire.rs` |
| Sync TLS | `src-tauri/src/sync/tls.rs` |
| Sync identity | `src-tauri/src/sync/identity.rs` |
| Sync pairing (SAS) | `src-tauri/src/sync/pairing.rs` |
| Sync net (LAN) | `src-tauri/src/sync/net.rs` |
| Backup system | `src-tauri/src/backup.rs` |
| Payload encryption | `src-tauri/src/crypto.rs`, `src-tauri/src/keys.rs` |
| DOM helper (`el`) | `src/ui/dom.ts` |
| Android FS (JNI) | `src-tauri/src/android_fs.rs` |
| Updater | `src-tauri/src/updater.rs` |
| Android manifest | `src-tauri/gen/android/app/src/main/AndroidManifest.xml` |
| Android Downloads | `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Downloads.kt` |
| Android Vault (SAF) | `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Vault.kt` |
| Android MainActivity | `src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/MainActivity.kt` |
| Tauri config | `src-tauri/tauri.conf.json` |
| Capabilities | `src-tauri/capabilities/default.json` |
| Cargo deps | `src-tauri/Cargo.toml` |
| Frontend store | `src/store/TauriEventStore.ts` |
| Auto-sync | `src/sync/autoSync.ts` |
| Backup UI | `src/ui/views/settingsBackup.ts` |
| Crypto UI | `src/ui/views/settingsCrypto.ts` |
| Auto-sync UI | `src/ui/views/settingsAutoSync.ts` |
| Sync UI | `src/ui/views/settingsSync.ts` |
| Updater UI | `src/ui/views/settingsUpdates.ts` |
| App bootstrap | `src/main.ts` |
| CI workflow | `.github/workflows/release.yml` |
| Version script | `scripts/version.mjs` |
| Release manifest | `scripts/latest-json.mjs` |

---

*This manual is a living document. Update it as the implementation evolves.*
EOF
echo "---"
wc -l /home/alonso/Documentos/Repositorios/inventario-tienda/docs/IMPLEMENTATION_MANUAL.md