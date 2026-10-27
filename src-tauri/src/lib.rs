//! Biblioteca de Inventario Tienda.
//! Los comandos de Tauri para el store de eventos viven en
//! `src-tauri/src/event_store.rs` y se registran en `run()`.
//! La sincronización P2P vive en `src-tauri/src/sync/`.
//!
//! `run()` es el entrypoint compartido por escritorio (main.rs) y Android
//! (`tauri::mobile_entry_point`).

mod event_store;
pub mod sync;

use event_store::{AppendArgs, DeviceIdArgs, MtimesArgs, ReadArgs};
use std::sync::{Mutex, OnceLock};
use sync::identity::Identity;
use sync::peer::PeersStore;
use sync::server::SyncServer;

/* ------------------------------------------------------------------ */
/* Estado global de sincronización (único por proceso)                */
/* ------------------------------------------------------------------ */

static SYNC_SERVER: OnceLock<Mutex<SyncServer>> = OnceLock::new();
static SYNC_PEERS: OnceLock<Mutex<PeersStore>> = OnceLock::new();

fn sync_server() -> &'static Mutex<SyncServer> {
  SYNC_SERVER.get_or_init(|| Mutex::new(SyncServer::new(14242)))
}

fn sync_peers() -> &'static Mutex<PeersStore> {
  SYNC_PEERS.get_or_init(|| Mutex::new(PeersStore::new()))
}

/* ------------------------------------------------------------------ */
/* Comandos de store de eventos                                       */
/* ------------------------------------------------------------------ */

/// Raíz de datos. En Android usa el almacenamiento privado de la app
/// (`app_data_dir`), que es escribible y no requiere SAF. En escritorio
/// conserva `~/.local/share/inventario-tienda`.
fn root_for_app(app: &tauri::AppHandle) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    use tauri::Manager;
    let dir = app
      .path()
      .app_data_dir()
      .map_err(|e| format!("No se pudo resolver el almacenamiento de la app: {e}"))?;
    std::fs::create_dir_all(&dir)
      .map_err(|e| format!("No se pudo crear el almacenamiento de la app: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
  }

  #[cfg(not(target_os = "android"))]
  {
    let _ = app;
    event_store::store_default_root()
  }
}

#[tauri::command]
fn store_default_root(app: tauri::AppHandle) -> Result<String, String> {
  root_for_app(&app)
}

#[tauri::command]
fn store_ensure_layout(root: String) -> Result<(), String> {
  event_store::store_ensure_layout(root)
}

#[tauri::command]
fn store_append(root: String, domain: String, lines: Vec<String>) -> Result<(), String> {
  event_store::store_append(AppendArgs { root, domain, lines })
}

#[tauri::command]
fn store_read(root: String, domain: String) -> Result<String, String> {
  event_store::store_read(ReadArgs { root, domain })
}

#[tauri::command]
fn store_mtimes(root: String) -> Result<serde_json::Value, String> {
  event_store::store_mtimes(MtimesArgs { root })
}

#[tauri::command]
fn store_device_id(root: String) -> Result<String, String> {
  event_store::store_device_id(DeviceIdArgs { root })
}

/* ------------------------------------------------------------------ */
/* Comandos de sincronización P2P (núcleo implementado; transporte    */
/* TLS/UDP esqueleto no verificado)                                   */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn sync_generate_identity(app: tauri::AppHandle, name: String) -> Result<String, String> {
  let ident = Identity::generate(&name)?;
  let device_id = ident.device_id.clone();
  let root = root_for_app(&app)?;
  let dir = sync::identity::identity_dir(&root);
  ident.persist(&dir)?;
  let server = sync_server();
  let s = server.lock().unwrap();
  s.set_identity(ident);
  Ok(device_id)
}

#[tauri::command]
fn sync_list_peers() -> Result<Vec<sync::peer::Peer>, String> {
  let p = sync_peers();
  let lock = p.lock().unwrap();
  Ok(lock
    .list()
    .iter()
    .map(|p| (**p).clone())
    .collect::<Vec<sync::peer::Peer>>())
}

#[tauri::command]
fn sync_start() -> Result<(), String> {
  let server = sync_server();
  let mut s = server.lock().unwrap();
  s.start()
}

#[tauri::command]
fn sync_stop() -> Result<(), String> {
  let server = sync_server();
  let mut s = server.lock().unwrap();
  s.stop();
  Ok(())
}

/* ------------------------------------------------------------------ */
/* Comando de actualización (fase 5)                                  */
/* El plugin solo se registra en escritorio; Android se actualiza      */
/* reinstalando el APK o desde la tienda.                             */
/* ------------------------------------------------------------------ */

#[tauri::command]
async fn cmd_updater_check(app: tauri::AppHandle) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    let _ = app;
    Ok("En Android la actualización se instala reinstalando el APK (o desde la tienda).".to_string())
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
