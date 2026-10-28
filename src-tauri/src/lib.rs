#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod crypto;
mod event_store;
mod keys;
mod sync;
mod updater;
#[cfg(target_os = "android")]
mod android_fs;

use event_store::{store_append, store_clear, store_device_id, store_ensure_layout, store_mtimes, store_read};
use serde::Serialize;
use sync::manager::{IdentityInfo, SyncBatchResult, SyncLocalInfo, SyncManager};
use sync::pairing::PendingPairing;
use sync::peer::Peer;
use tauri::{AppHandle, Manager};

/* ------------------------------------------------------------------ */
/* Almacenamiento                                                     */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir.to_string_lossy().to_string())
}

/**
 * Carpeta de datos por defecto.
 *
 * En escritorio conservamos el layout histórico (~/.local/share/...). En
 * Android usamos el almacenamiento privado de la app: el SAF/MediaStore se
 * reserva para exportaciones y para guardar el APK del actualizador.
 */
#[tauri::command]
fn store_default_root(app: AppHandle) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
  }
  #[cfg(not(target_os = "android"))]
  {
    let _ = app;
    event_store::default_root()
  }
}

/* ------------------------------------------------------------------ */
/* Sincronización P2P                                                 */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
struct PairingStart {
  info: SyncLocalInfo,
  expires_at: u64,
  /// Token de un solo uso embebido en el QR.
  token: String,
  /// Contenido exacto que se dibuja como QR.
  qr_payload: String,
}

#[tauri::command]
fn sync_get_identity(state: tauri::State<'_, SyncManager>, name: String) -> Result<IdentityInfo, String> {
  let identity = state.ensure_identity(&name)?;
  let fingerprint = identity.fingerprint();
  Ok(IdentityInfo {
    device_id: identity.device_id,
    name: identity.name,
    fingerprint,
  })
}

#[tauri::command]
fn sync_local_info(
  state: tauri::State<'_, SyncManager>,
  name: Option<String>,
) -> Result<SyncLocalInfo, String> {
  if let Some(name) = name {
    state.ensure_identity(&name)?;
  }
  Ok(state.local_info())
}

#[tauri::command]
async fn sync_start(
  state: tauri::State<'_, SyncManager>,
  name: String,
) -> Result<SyncLocalInfo, String> {
  state.start(&name).await
}

#[tauri::command]
fn sync_stop(state: tauri::State<'_, SyncManager>) -> Result<(), String> {
  state.stop();
  Ok(())
}

#[tauri::command]
async fn sync_set_ports(
  state: tauri::State<'_, SyncManager>,
  name: String,
  base_port: u16,
) -> Result<SyncLocalInfo, String> {
  state.set_ports(&name, base_port).await
}

#[tauri::command]
fn sync_list_peers(state: tauri::State<'_, SyncManager>) -> Result<Vec<Peer>, String> {
  Ok(state.list_peers())
}

#[tauri::command]
fn sync_discovered(
  state: tauri::State<'_, SyncManager>,
) -> Result<Vec<sync::discovery::DiscoveredPeer>, String> {
  Ok(state.list_discovered())
}

#[tauri::command]
async fn sync_pair_listen_start(
  state: tauri::State<'_, SyncManager>,
  name: String,
) -> Result<PairingStart, String> {
  let (info, expires_at, token) = state.start_pairing(&name).await?;
  let qr_payload = state.pairing_qr(&info, &token)?;
  Ok(PairingStart {
    info,
    expires_at,
    token,
    qr_payload,
  })
}

#[tauri::command]
async fn sync_pair_qr_connect(
  state: tauri::State<'_, SyncManager>,
  name: String,
  payload: String,
) -> Result<Peer, String> {
  state.connect_pairing_qr(&name, &payload).await
}

#[tauri::command]
fn sync_pair_listen_stop(state: tauri::State<'_, SyncManager>) -> Result<(), String> {
  state.stop_pairing();
  Ok(())
}

#[tauri::command]
fn sync_pair_pending(
  state: tauri::State<'_, SyncManager>,
) -> Result<Option<PendingPairing>, String> {
  Ok(state.pending_pairing())
}

#[tauri::command]
async fn sync_pair_connect(
  state: tauri::State<'_, SyncManager>,
  name: String,
  address: String,
) -> Result<PendingPairing, String> {
  state.connect_pairing(&name, &address).await
}

#[tauri::command]
fn sync_pair_confirm(
  state: tauri::State<'_, SyncManager>,
  device_id: String,
) -> Result<Peer, String> {
  state.confirm_pairing(&device_id)
}

#[tauri::command]
fn sync_pair_cancel(state: tauri::State<'_, SyncManager>, device_id: String) -> Result<(), String> {
  state.reject_pairing(&device_id);
  Ok(())
}

#[tauri::command]
async fn sync_now(
  state: tauri::State<'_, SyncManager>,
  device_id: Option<String>,
  address: Option<String>,
  auto: Option<bool>,
) -> Result<SyncBatchResult, String> {
  match device_id {
    Some(device_id) => {
      let report = state
        .sync_peer(&device_id, address.as_deref())
        .await?;
      Ok(SyncBatchResult {
        reports: vec![report],
        errors: Vec::new(),
      })
    }
    None => state.sync_all(auto.unwrap_or(false)).await,
  }
}

#[tauri::command]
fn sync_set_peer_address(
  state: tauri::State<'_, SyncManager>,
  device_id: String,
  address: Option<String>,
) -> Result<Peer, String> {
  state.set_peer_address(&device_id, address.as_deref())
}

#[tauri::command]
fn sync_remove_peer(state: tauri::State<'_, SyncManager>, device_id: String) -> Result<(), String> {
  state.remove_peer(&device_id)
}

#[tauri::command]
async fn sync_scan_lan(state: tauri::State<'_, SyncManager>) -> Result<Vec<String>, String> {
  state.scan_lan().await
}

/* ------------------------------------------------------------------ */
/* Aplicación                                                         */
/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_opener::init());

  #[cfg(not(target_os = "android"))]
  {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .setup(|app| {
      app.manage(SyncManager::new(app.handle().clone()));
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      get_app_data_dir,
      store_default_root,
      store_ensure_layout,
      store_clear,
      store_append,
      store_read,
      store_mtimes,
      store_device_id,
      sync_get_identity,
      sync_local_info,
      sync_start,
      sync_stop,
      sync_set_ports,
      sync_list_peers,
      sync_discovered,
      sync_pair_listen_start,
      sync_pair_listen_stop,
      sync_pair_pending,
      sync_pair_connect,
      sync_pair_qr_connect,
      sync_pair_confirm,
      sync_pair_cancel,
      sync_now,
      sync_set_peer_address,
      sync_remove_peer,
      sync_scan_lan,
      updater::cmd_updater_check,
      updater::cmd_updater_install,
      updater::cmd_open_release_page,
      store_space_info,
      backup::backup_status,
      backup::backup_set_vault,
      backup::backup_check_vault,
      backup::backup_run_daily,
      backup::backup_pull_from_vault,
      sync_auto_get,
      sync_auto_set,
      battery_status,
      crypto::crypto_boot_state,
      crypto::crypto_enable,
      crypto::crypto_unlock,
      crypto::crypto_lock,
      crypto::crypto_status,
      crypto::crypto_change_password,
      crypto::crypto_rotate,
      crypto::crypto_keyring_json,
      crypto::crypto_import_keyring,
      crypto::crypto_adopt_keyring,
      crypto::crypto_encrypt_text,
      crypto::crypto_decrypt_text,
      crypto::crypto_read_events,
      crypto::crypto_append_event,
    ])
    .run(tauri::generate_context!())
    .expect("error al ejecutar Inventario Tienda");
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn store_space_info() -> Result<serde_json::Value, String> {
  Ok(serde_json::json!({ "ok": true }))
}

/* ------------------------------------------------------------------ */
/* Configuración de sincronización automática                         */
/* ------------------------------------------------------------------ */

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SyncAutoConfig {
  enabled: bool,
  respect_battery_saver: bool,
}

impl Default for SyncAutoConfig {
  fn default() -> Self {
    Self { enabled: false, respect_battery_saver: true }
  }
}

fn sync_config_path(root: &str) -> std::path::PathBuf {
  std::path::Path::new(root).join("sync_auto.json")
}

#[tauri::command]
fn sync_auto_get(root: String) -> Result<SyncAutoConfig, String> {
  let p = sync_config_path(&root);
  if !p.exists() {
    return Ok(SyncAutoConfig::default());
  }
  let s = std::fs::read_to_string(&p).map_err(|e| e.to_string())?;
  serde_json::from_str(&s).map_err(|e| e.to_string())
}

#[tauri::command]
fn sync_auto_set(root: String, enabled: bool, respect_battery_saver: bool) -> Result<(), String> {
  let p = sync_config_path(&root);
  let cfg = SyncAutoConfig { enabled, respect_battery_saver };
  let s = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
  std::fs::write(&p, s).map_err(|e| e.to_string())
}

#[tauri::command]
fn battery_status() -> Result<serde_json::Value, String> {
  #[cfg(target_os = "android")]
  {
    let (power_save, level, charging) = crate::android_fs::battery_info();
    let effective_mode = if power_save || (level < 15 && !charging) {
      "ahorro"
    } else {
      "normal"
    };
    return Ok(serde_json::json!({
      "power_save_mode": power_save,
      "battery_level": level,
      "is_charging": charging,
      "effective_mode": effective_mode
    }));
  }
  #[cfg(not(target_os = "android"))]
  {
    Ok(serde_json::json!({
      "power_save_mode": false,
      "battery_level": 100,
      "is_charging": true,
      "effective_mode": "normal"
    }))
  }
}

mod backup;
