#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backup;
mod crypto;
mod event_store;
mod journal;
mod keys;
mod storage;
mod updater;
mod vault;
mod writer;
#[cfg(target_os = "android")]
mod android_fs;

use event_store::{
  store_append, store_clear, store_device_id, store_ensure_layout, store_export_raw,
  store_fingerprints, store_mtimes, store_read,
};
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
 * Raíz de datos por defecto: `<bóveda>/omega`.
 *
 * En el arranque normal el frontend ya eligió la bóveda y pasa la raíz
 * explícitamente, pero este comando mantiene compatibilidad con el store.
 */
#[tauri::command]
fn store_default_root(app: AppHandle) -> Result<String, String> {
  vault::data_root(&app)
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

  #[cfg(target_os = "android")]
  {
    builder = builder.plugin(tauri_plugin_android_fs::init());
  }

  #[cfg(not(target_os = "android"))]
  {
    // El actualizador de escritorio necesita el plugin registrado para que
    // `app.updater()` encuentre su estado. En Android se usa el actualizador
    // propio de `updater.rs` y el plugin no se compila.
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
  }

  builder
    .setup(|app| {
      storage::init_app(app.handle().clone());
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
      store_fingerprints,
      store_device_id,
      store_export_raw,
      journal::journal_repair,
      journal::journal_status,
      journal::journal_clear,
      writer::installation_device_id,
      writer::writer_touch,
      vault::vault_status,
      vault::vault_pick,
      vault::vault_clear,
      backup::longlife_status,
      backup::longlife_list,
      backup::longlife_files,
      backup::longlife_open_folder,
      backup::longlife_run,
      backup::longlife_restore,
      backup::longlife_delete,
      updater::cmd_updater_check,
      updater::cmd_updater_install,
      updater::cmd_open_release_page,
      store_space_info,
      crypto::crypto_boot_state,
      crypto::crypto_enable,
      crypto::crypto_unlock,
      crypto::crypto_lock,
      crypto::crypto_status,
      crypto::crypto_change_password,
      crypto::crypto_rotate,
      crypto::crypto_backup_info,
      crypto::crypto_delete_backups,
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
