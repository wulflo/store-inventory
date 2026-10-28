//! Bóveda elegida por el usuario.
//!
//! La bóveda es una carpeta normal en escritorio y un árbol SAF en Android.
//! Dentro de ella la app usa siempre:
//!
//! ```text
//! <bóveda>/omega/       datos vivos (events/, keys/, device_id, settings.json)
//! <bóveda>/longlife/    copias diarias (la app no las lee automáticamente)
//! ```
//!
//! La configuración (`vault.json`) se guarda en el directorio privado de la
//! app, fuera de la bóveda, para no mezclar datos con configuración.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub const VAULT_NOT_CONFIGURED: &str = "VAULT_NOT_CONFIGURED:";
const CONFIG_FILE: &str = "vault.json";

#[cfg(target_os = "android")]
use tauri_plugin_android_fs::{
  AndroidFs, AndroidFsExt, DirPath, EntryPath, PersistableAccessMode,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultConfig {
  /// `local` o `saf`.
  pub kind: String,
  /// En escritorio: ruta de la carpeta elegida. En Android: `DirPath` JSON.
  pub vault_root: String,
  /// En escritorio: `<vault_root>/omega`. En Android: `DirPath` JSON de omega.
  pub data_root: String,
  pub vault_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
  pub configured: bool,
  pub accessible: bool,
  pub kind: Option<String>,
  pub vault_root: Option<String>,
  pub data_root: Option<String>,
  pub vault_name: Option<String>,
  pub error: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("No se pudo resolver el directorio de la app: {e}"))?;
  fs::create_dir_all(&dir)
    .map_err(|e| format!("No se pudo crear el directorio de la app: {e}"))?;
  Ok(dir.join(CONFIG_FILE))
}

pub fn load_config(app: &AppHandle) -> Result<Option<VaultConfig>, String> {
  let path = config_path(app)?;
  let text = match fs::read_to_string(&path) {
    Ok(text) => text,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("No se pudo leer la configuración de la bóveda: {e}")),
  };
  let config: VaultConfig = serde_json::from_str(&text)
    .map_err(|e| format!("La configuración de la bóveda está dañada: {e}"))?;
  if config.vault_root.trim().is_empty() || config.data_root.trim().is_empty() {
    return Err("La configuración de la bóveda está incompleta.".to_string());
  }
  Ok(Some(config))
}

fn save_config(app: &AppHandle, config: &VaultConfig) -> Result<(), String> {
  let path = config_path(app)?;
  let json = serde_json::to_string_pretty(config)
    .map_err(|e| format!("No se pudo serializar la bóveda: {e}"))?;
  fs::write(&path, json).map_err(|e| format!("No se pudo guardar la bóveda: {e}"))
}

fn accessible(config: &VaultConfig) -> bool {
  if config.kind == "saf" || crate::storage::is_saf(&config.data_root) {
    crate::storage::exists(&config.data_root, "").unwrap_or(false)
  } else {
    std::path::Path::new(&config.data_root).is_dir()
  }
}

/// Estado actual de la bóveda sin abrir ningún selector.
#[tauri::command]
pub fn vault_status(app: AppHandle) -> Result<VaultStatus, String> {
  match load_config(&app)? {
    None => Ok(VaultStatus {
      configured: false,
      accessible: false,
      kind: None,
      vault_root: None,
      data_root: None,
      vault_name: None,
      error: Some("Todavía no elegiste una carpeta bóveda.".to_string()),
    }),
    Some(config) => {
      let ok = accessible(&config);
      Ok(VaultStatus {
        configured: true,
        accessible: ok,
        kind: Some(config.kind.clone()),
        vault_root: Some(config.vault_root.clone()),
        data_root: Some(config.data_root.clone()),
        vault_name: Some(config.vault_name.clone()),
        error: if ok {
          None
        } else {
          Some(
            "La carpeta bóveda ya no es accesible. Elegila de nuevo para continuar.".to_string(),
          )
        },
      })
    }
  }
}

/// Devuelve la raíz de datos (`omega`) y falla si no hay bóveda configurada.
pub fn data_root(app: &AppHandle) -> Result<String, String> {
  let config = load_config(app)?.ok_or_else(|| {
    format!("{VAULT_NOT_CONFIGURED} Elegí una carpeta bóveda para empezar.")
  })?;
  Ok(config.data_root)
}

/* ------------------------------------------------------------------ */
/* Android SAF                                                        */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "android")]
fn saf_subdir(
  app: &AppHandle,
  parent: &DirPath,
  name: &str,
) -> Result<DirPath, String> {
  let api = app.android_fs();
  let entries = api
    .read_dir(parent)
    .map_err(|e| format!("No se pudo leer la carpeta bóveda: {e}"))?;
  for (entry_name, entry) in entries {
    if entry_name == name {
      if let EntryPath::Dir(dir) = entry {
        return Ok(dir);
      }
    }
  }

  let marker_file = format!(
    ".keep-{}",
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_nanos())
      .unwrap_or(0)
  );
  let marker = format!("{name}/{marker_file}");
  let keep = api
    .new_file_with_contents(parent, &marker, Some("text/plain"), b"")
    .map_err(|e| format!("No se pudo crear la carpeta '{name}' en la bóveda: {e}"))?;
  let _ = api.remove_file(&keep);

  let entries = api
    .read_dir(parent)
    .map_err(|e| format!("No se pudo leer la carpeta bóveda: {e}"))?;
  for (entry_name, entry) in entries {
    if entry_name == name {
      if let EntryPath::Dir(dir) = entry {
        return Ok(dir);
      }
    }
    if entry_name == marker_file {
      if let EntryPath::File(path) = entry {
        let _ = api.remove_file(&path);
      }
    }
  }
  Err(format!("No se pudo crear la carpeta '{name}' en la bóveda."))
}

/* ------------------------------------------------------------------ */
/* Selección                                                          */
/* ------------------------------------------------------------------ */

/// Abre el selector de carpetas, crea `omega`/`longlife` y guarda la elección.
///
/// Devuelve el estado nuevo. Si el usuario cancela, `configured` conserva el
/// valor anterior (normalmente `false`).
#[tauri::command]
pub async fn vault_pick(app: AppHandle) -> Result<VaultStatus, String> {
  let previous = load_config(&app).ok().flatten();

  #[cfg(target_os = "android")]
  {
    let api = app.android_fs();
    let picked = api
      .show_open_dir_dialog()
      .map_err(|e| format!("No se pudo abrir el selector de carpetas: {e}"))?
      .ok_or_else(|| "Selección cancelada.".to_string())?;

    api.grant_persistable_dir_access(&picked, PersistableAccessMode::ReadAndWrite)
      .map_err(|e| format!("No se pudo conservar el permiso de la carpeta: {e}"))?;

    let vault_name = api
      .get_dir_name(&picked)
      .unwrap_or_else(|_| "Bóveda".to_string());
    let vault_root = tauri_plugin_android_fs::convert_dir_path_to_string(&picked)
      .map_err(|e| format!("La ruta SAF no es válida: {e}"))?;

    let omega = saf_subdir(&app, &picked, "omega")?;
    saf_subdir(&app, &picked, "longlife")?;
    let data_root = tauri_plugin_android_fs::convert_dir_path_to_string(&omega)
      .map_err(|e| format!("La ruta SAF de omega no es válida: {e}"))?;

    let config = VaultConfig {
      kind: "saf".to_string(),
      vault_root,
      data_root,
      vault_name,
    };
    save_config(&app, &config)?;
    if let Some(old) = previous {
      if old.data_root != config.data_root {
        crate::crypto::clear_current_for(&old.data_root);
      }
    }
    return vault_status(app);
  }

  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_dialog::DialogExt;

    let picked = app
      .dialog()
      .file()
      .blocking_pick_folder()
      .ok_or_else(|| "Selección cancelada.".to_string())?;
    let picked = picked
      .into_path()
      .map_err(|e| format!("La carpeta elegida no es válida: {e}"))?;
    let picked = fs::canonicalize(&picked).unwrap_or(picked);

    let data_root = picked.join("omega");
    let longlife_root = picked.join("longlife");
    fs::create_dir_all(&data_root)
      .map_err(|e| format!("No se pudo crear <bóveda>/omega: {e}"))?;
    fs::create_dir_all(&longlife_root)
      .map_err(|e| format!("No se pudo crear <bóveda>/longlife: {e}"))?;

    let vault_name = picked
      .file_name()
      .and_then(|n| n.to_str())
      .unwrap_or("Bóveda")
      .to_string();
    let config = VaultConfig {
      kind: "local".to_string(),
      vault_root: picked.to_string_lossy().to_string(),
      data_root: data_root.to_string_lossy().to_string(),
      vault_name,
    };
    save_config(&app, &config)?;
    if let Some(old) = previous {
      if old.data_root != config.data_root {
        crate::crypto::clear_current_for(&old.data_root);
      }
    }
    vault_status(app)
  }
}

/// Olvida la bóveda configurada. No borra ningún dato.
#[tauri::command]
pub fn vault_clear(app: AppHandle) -> Result<(), String> {
  if let Some(config) = load_config(&app)? {
    crate::crypto::clear_current_for(&config.data_root);
  }
  let path = config_path(&app)?;
  match fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("No se pudo olvidar la bóveda: {e}")),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn config_roundtrip_shape() {
    let config = VaultConfig {
      kind: "local".into(),
      vault_root: "/tmp/boveda".into(),
      data_root: "/tmp/boveda/omega".into(),
      vault_name: "boveda".into(),
    };
    let json = serde_json::to_string(&config).unwrap();
    assert!(json.contains("\"vaultRoot\""));
    let back: VaultConfig = serde_json::from_str(&json).unwrap();
    assert_eq!(back.data_root, config.data_root);
  }
}
