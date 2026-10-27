#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod event_store;
mod sync;
mod updater;
#[cfg(target_os = "android")]
mod android_fs;

use event_store::{
  store_append, store_device_id, store_ensure_layout, store_mtimes, store_read, AppendArgs,
  DeviceIdArgs, MtimesArgs, ReadArgs,
};
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
fn sync_list_peers(state: tauri::State<'_, SyncManager>) -> Result<Vec<Peer>, String> {
  Ok(state.list_peers())
}

#[tauri::command]
async fn sync_pair_listen_start(
  state: tauri::State<'_, SyncManager>,
  name: String,
) -> Result<PairingStart, String> {
  let (info, expires_at) = state.start_pairing(&name).await?;
  Ok(PairingStart { info, expires_at })
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
    None => state.sync_all().await,
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

/* ------------------------------------------------------------------ */
/* Aplicación                                                         */
/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default();

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
      store_append,
      store_read,
      store_mtimes,
      store_device_id,
      sync_get_identity,
      sync_local_info,
      sync_start,
      sync_stop,
      sync_list_peers,
      sync_pair_listen_start,
      sync_pair_listen_stop,
      sync_pair_pending,
      sync_pair_connect,
      sync_pair_confirm,
      sync_pair_cancel,
      sync_now,
      sync_set_peer_address,
      sync_remove_peer,
      updater::cmd_updater_check,
      updater::cmd_updater_install,
    ])
    .run(tauri::generate_context!())
    .expect("error al ejecutar Inventario Tienda");
}
