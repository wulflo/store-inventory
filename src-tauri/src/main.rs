#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod event_store;
mod sync;

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

#[tauri::command]
fn cmd_store_default_root() -> Result<String, String> {
  event_store::store_default_root()
}

#[tauri::command]
fn cmd_store_ensure_layout(root: String) -> Result<(), String> {
  event_store::store_ensure_layout(root)
}

#[tauri::command]
fn cmd_store_append(args: AppendArgs) -> Result<(), String> {
  event_store::store_append(args)
}

#[tauri::command]
fn cmd_store_read(args: ReadArgs) -> Result<String, String> {
  event_store::store_read(args)
}

#[tauri::command]
fn cmd_store_mtimes(args: MtimesArgs) -> Result<serde_json::Value, String> {
  event_store::store_mtimes(args)
}

#[tauri::command]
fn cmd_store_device_id(args: DeviceIdArgs) -> Result<String, String> {
  event_store::store_device_id(args)
}

/* ------------------------------------------------------------------ */
/* Comandos de sincronización P2P (fase 2 - núcleo implementado,      */
/* transporte TLS/UDP esqueleto no verificado)                        */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn cmd_sync_generate_identity(name: String) -> Result<String, String> {
  let ident = Identity::generate(&name)?;
  let device_id = ident.device_id.clone();
  let root = event_store::store_default_root()?;
  let dir = sync::identity::identity_dir(&root);
  ident.persist(&dir)?;
  let server = sync_server();
  let mut s = server.lock().unwrap();
  s.set_identity(ident);
  Ok(device_id)
}

#[tauri::command]
fn cmd_sync_list_peers() -> Result<Vec<sync::peer::Peer>, String> {
  let p = sync_peers();
  let lock = p.lock().unwrap();
  Ok(lock
    .list()
    .iter()
    .map(|p| (**p).clone())
    .collect::<Vec<sync::peer::Peer>>())
}

#[tauri::command]
fn cmd_sync_start() -> Result<(), String> {
  let server = sync_server();
  let mut s = server.lock().unwrap();
  s.start()
}

#[tauri::command]
fn cmd_sync_stop() -> Result<(), String> {
  let server = sync_server();
  let mut s = server.lock().unwrap();
  s.stop();
  Ok(())
}

/* ------------------------------------------------------------------ */
/* Comando de actualización (fase 5 - requiere pubkey configurada por   */
/* el usuario; el plugin tauri-plugin-updater se activa al generar la   */
/* clave con `tauri signer generate` y configurar tauri.conf.json)     */
/* ------------------------------------------------------------------ */

#[tauri::command]
fn cmd_updater_check() -> Result<String, String> {
  Ok("El updater requiere configuración: genera la clave con\n  npm run tauri signer generate -- -w <ruta>\ny configura pubkey y endpoint en src-tauri/tauri.conf.json (sección tauri.updater).".to_string())
}

/* ------------------------------------------------------------------ */

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      cmd_store_default_root,
      cmd_store_ensure_layout,
      cmd_store_append,
      cmd_store_read,
      cmd_store_mtimes,
      cmd_store_device_id,
      cmd_sync_generate_identity,
      cmd_sync_list_peers,
      cmd_sync_start,
      cmd_sync_stop,
      cmd_updater_check,
    ])
    .run(tauri::generate_context!());
}
