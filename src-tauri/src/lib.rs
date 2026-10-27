#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod event_store;
mod sync;
#[cfg(target_os = "android")]
mod android_fs;

use event_store::{store_append, store_default_root, store_device_id, store_ensure_layout, store_mtimes, store_read, AppendArgs, DeviceIdArgs, MtimesArgs, ReadArgs};
use sync::identity::{identity_dir, Identity};
use sync::peer::{Peer, PeersStore};
use tauri::{AppHandle, Manager};
use std::sync::{Arc, Mutex};

#[tauri::command]
fn get_app_data_dir(app: AppHandle) -> Result<String, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ */
/* Comandos de sincronización P2P                                      */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn sync_generate_identity(app: AppHandle, name: String) -> Result<String, String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let dir = identity_dir(&root.to_string_lossy());
  std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear carpeta de identidad: {e}"))?;
  if dir.join("identity.pem").exists() && dir.join("certificate.pem").exists() {
    let ident = Identity::load(&dir, &name)?;
    return Ok(ident.device_id);
  }
  let ident = Identity::generate(&name)?;
  ident.persist(&dir)?;
  Ok(ident.device_id)
}

#[tauri::command]
fn sync_list_peers(app: AppHandle) -> Result<Vec<Peer>, String> {
  let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
  let path = root.join("sync/peers.json");
  let store = PeersStore::load(&path)?;
  Ok(store.list().into_iter().cloned().collect())
}

#[tauri::command]
fn sync_start(_app: AppHandle) -> Result<(), String> {
  Ok(())
}

#[tauri::command]
fn sync_stop(_app: AppHandle) -> Result<(), String> {
  Ok(())
}

/* ------------------------------------------------------------------ */
/* Comandos de actualización                                           */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn cmd_updater_check(app: AppHandle) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    return Err("Las actualizaciones se gestionan desde la tienda de Android.".to_string());
  }
  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
      .updater()
      .map_err(|e| format!("El updater no está disponible: {e}"))?;
    match updater.check().await {
      Ok(Some(update)) => Ok(format!(
        "Hay una versión nueva: {} (tenés {}). {}",
        update.version,
        update.current_version,
        update.body.as_deref().unwrap_or("")
      )),
      Ok(None) => Ok("Ya tenés la última versión.".to_string()),
      Err(e) => Err(format!("No se pudo buscar actualizaciones: {e}")),
    }
  }
}

/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  #[cfg(not(target_os = "android"))]
  let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

  builder
    .invoke_handler(tauri::generate_handler![
      store_default_root,
      store_ensure_layout,
      store_append,
      store_read,
      store_mtimes,
      store_device_id,
      sync_generate_identity,
      sync_list_peers,
      sync_start,
      sync_stop,
      cmd_updater_check,
    ])
    .run(tauri::generate_context!())
    .expect("error al ejecutar Inventario Tienda");
}

#[derive(Clone)]
struct SyncState {
    server: Arc<Mutex<crate::sync::server::SyncServerReal>>,
    peers: Arc<Mutex<crate::sync::peer::PeersStore>>,
    identity: Arc<Mutex<Option<crate::sync::identity::Identity>>>,
}

#[tauri::command]
async fn sync_start_real(state: tauri::State<'_, SyncState>) -> Result<(), String> {
    let mut server = state.server.lock().unwrap();
    server.start().await
}

#[tauri::command]
fn sync_stop_real(state: tauri::State<'_, SyncState>) -> Result<(), String> {
    let mut server = state.server.lock().unwrap();
    server.stop();
    Ok(())
}
