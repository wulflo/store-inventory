#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod event_store;

use event_store::{AppendArgs, DeviceIdArgs, MtimesArgs, ReadArgs};

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

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      cmd_store_default_root,
      cmd_store_ensure_layout,
      cmd_store_append,
      cmd_store_read,
      cmd_store_mtimes,
      cmd_store_device_id,
    ])
    .run(tauri::generate_context!());
}
