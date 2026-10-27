use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::AppHandle;

static BACKUP_MERGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupManifest {
  version: u32,
  date: String,
  created_at: String,
  device_id: String,
  root: String,
  vault_path: Option<String>,
  files: Vec<BackupFile>,
  total_bytes: u64,
  sha256_total: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BackupFile {
  name: String,
  bytes: u64,
  sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupStatus {
  last_backup_date: Option<String>,
  last_backup_at: Option<String>,
  vault_path: Option<String>,
  has_vault: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupResult {
  date: String,
  local_path: String,
  vault_path: Option<String>,
  files: usize,
  total_bytes: u64,
  errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultCheckResult {
  accessible: bool,
  path: Option<String>,
  error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultPickResult {
  path: Option<String>,
  error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupPullResult {
  pulled_files: usize,
  added_lines: usize,
  scanned_devices: usize,
  /// Eventos descartados por estar cifrados con otra clave o ilegibles.
  skipped_incompatible: usize,
}

fn today_str() -> String {
  chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339()
}

fn sha256_file(path: &Path) -> Result<String, String> {
  let mut file = fs::File::open(path).map_err(|e| format!("No se pudo abrir {path:?}: {e}"))?;
  let mut hasher = Sha256::new();
  let mut buf = [0u8; 8192];
  loop {
    let n = std::io::Read::read(&mut file, &mut buf).map_err(|e| e.to_string())?;
    if n == 0 {
      break;
    }
    hasher.update(&buf[..n]);
  }
  Ok(format!("{:x}", hasher.finalize()))
}

fn copy_file(src: &Path, dst: &Path) -> Result<u64, String> {
  if let Some(parent) = dst.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear carpeta {parent:?}: {e}"))?;
  }
  fs::copy(src, dst).map_err(|e| format!("No se pudo copiar {src:?} -> {dst:?}: {e}"))
}

fn settings_path(root: &str) -> PathBuf {
  Path::new(root).join("settings.json")
}

fn read_vault_path(root: &str) -> Option<String> {
  let p = settings_path(root);
  if !p.exists() {
    return None;
  }
  if let Ok(s) = fs::read_to_string(&p) {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
      if let Some(vault) = v.get("backup_vault_path").and_then(|x| x.as_str()) {
        if !vault.trim().is_empty() {
          return Some(vault.trim().to_string());
        }
      }
      // Soporte SAF URI
      if let Some(vault) = v.get("backup_vault_uri").and_then(|x| x.as_str()) {
        if !vault.trim().is_empty() {
          return Some(vault.trim().to_string());
        }
      }
    }
  }
  None
}

fn is_saf_uri(path: &str) -> bool {
  path.starts_with("content://")
}

fn vault_accessible(path: &str) -> bool {
  #[cfg(target_os = "android")]
  {
    if is_saf_uri(path) {
      return crate::android_fs::vault_is_accessible(path);
    }
  }
  // Escritorio: verificar existencia o creación
  let p = Path::new(path);
  p.exists() || fs::create_dir_all(p).is_ok()
}

fn write_vault_path(root: &str, vault: Option<String>) -> Result<(), String> {
  let p = settings_path(root);
  let mut obj: serde_json::Value = if p.exists() {
    serde_json::from_str(&fs::read_to_string(&p).unwrap_or_else(|_| "{}".to_string()))
      .unwrap_or_else(|_| serde_json::json!({}))
  } else {
    serde_json::json!({})
  };
  if let Some(map) = obj.as_object_mut() {
    if let Some(v) = &vault {
      if v.trim().is_empty() {
        map.remove("backup_vault_path");
        map.remove("backup_vault_uri");
      } else {
        let trimmed = v.trim().to_string();
        if is_saf_uri(&trimmed) {
          map.insert("backup_vault_uri".to_string(), serde_json::Value::String(trimmed));
          map.remove("backup_vault_path");
        } else {
          map.insert("backup_vault_path".to_string(), serde_json::Value::String(trimmed));
          map.remove("backup_vault_uri");
        }
      }
    } else {
      map.remove("backup_vault_path");
      map.remove("backup_vault_uri");
    }
  }
  let s = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;
  fs::write(&p, s).map_err(|e| format!("No se pudo guardar configuración: {e}"))
}

fn read_device_id(root: &str) -> String {
  let p = Path::new(root).join("device_id");
  if let Ok(s) = fs::read_to_string(&p) {
    let v = s.trim().to_string();
    if !v.is_empty() {
      return v;
    }
  }
  String::new()
}

fn last_backup_info(root: &str) -> (Option<String>, Option<String>) {
  let backup_root = Path::new(root).join("backups").join("daily");
  if !backup_root.exists() {
    return (None, None);
  }
  let mut dates: Vec<String> = Vec::new();
  if let Ok(entries) = fs::read_dir(&backup_root) {
    for e in entries.flatten() {
      if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
        if let Some(name) = e.file_name().to_str() {
          if name.len() == 10 && name.chars().all(|c| c.is_ascii_digit() || c == '-') {
            dates.push(name.to_string());
          }
        }
      }
    }
  }
  dates.sort();
  if let Some(last) = dates.last().cloned() {
    let manifest = backup_root.join(&last).join("manifest.json");
    if manifest.exists() {
      if let Ok(s) = fs::read_to_string(&manifest) {
        if let Ok(m) = serde_json::from_str::<BackupManifest>(&s) {
          return (Some(last), Some(m.created_at));
        }
      }
    }
    (Some(last), None)
  } else {
    (None, None)
  }
}

fn read_event_ids(path: &Path) -> HashSet<String> {
  let mut set = HashSet::new();
  if !path.exists() {
    return set;
  }
  if let Ok(file) = fs::File::open(path) {
    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
      if let Some(id) = line_event_id(line.trim()) {
        set.insert(id);
      }
    }
  }
  set
}

/// Extrae el `id` de una línea JSONL, si es válida.
fn line_event_id(line: &str) -> Option<String> {
  if line.is_empty() {
    return None;
  }
  let value: serde_json::Value = serde_json::from_str(line).ok()?;
  let id = value.get("id")?.as_str()?.trim();
  if id.is_empty() {
    None
  } else {
    Some(id.to_string())
  }
}

#[tauri::command]
pub fn backup_status(root: String) -> Result<BackupStatus, String> {
  let vault_path = read_vault_path(&root);
  let has_vault = vault_path
    .as_ref()
    .map(|p| Path::new(p).exists())
    .unwrap_or(false);
  let (last_backup_date, last_backup_at) = last_backup_info(&root);
  Ok(BackupStatus {
    last_backup_date,
    last_backup_at,
    vault_path,
    has_vault,
  })
}

#[tauri::command]
pub fn backup_set_vault(root: String, vault: Option<String>) -> Result<(), String> {
  write_vault_path(&root, vault)
}

#[tauri::command]
pub fn backup_check_vault(root: String) -> Result<VaultCheckResult, String> {
  let path = read_vault_path(&root);
  match path {
    Some(p) => {
      if vault_accessible(&p) {
        Ok(VaultCheckResult { accessible: true, path: Some(p), error: None })
      } else {
        Ok(VaultCheckResult { accessible: false, path: Some(p), error: Some("La bóveda no es accesible. Elegí la carpeta de nuevo.".into()) })
      }
    }
    None => Ok(VaultCheckResult { accessible: false, path: None, error: Some("No hay bóveda configurada.".into()) }),
  }
}

#[tauri::command]
pub fn backup_run_daily(app: AppHandle, root: String, force: Option<bool>) -> Result<BackupResult, String> {
  let force = force.unwrap_or(false);
  let date = today_str();
  let local_backup_dir = Path::new(&root).join("backups").join("daily").join(&date);
  if local_backup_dir.exists() && !force {
    let manifest_p = local_backup_dir.join("manifest.json");
    if let Ok(s) = fs::read_to_string(&manifest_p) {
      if let Ok(m) = serde_json::from_str::<BackupManifest>(&s) {
        return Ok(BackupResult {
          date: m.date.clone(),
          local_path: local_backup_dir.to_string_lossy().to_string(),
          vault_path: m.vault_path.clone(),
          files: m.files.len(),
          total_bytes: m.total_bytes,
          errors: Vec::new(),
        });
      }
    }
  }
  fs::create_dir_all(&local_backup_dir).map_err(|e| format!("No se pudo crear carpeta de backup: {e}"))?;

  let events_dir = Path::new(&root).join("events");
  let domains = [
    "collections",
    "products",
    "colors",
    "variants",
    "customers",
    "orders",
    "order_lines",
    "payments",
    "production_orders",
    "production_lines",
    "stock_movements",
    "expenses",
    "settings",
    "device_info",
  ];

  let mut files_list: Vec<BackupFile> = Vec::new();
  let mut total_bytes: u64 = 0;

  {
    // Copiar eventos y llavero bajo el mismo lock: una migración/rotación no
    // puede dejar el respaldo con archivos de dos claves distintas.
    let _events_guard = crate::event_store::EVENTS_WRITE_LOCK
      .lock()
      .unwrap_or_else(|e| e.into_inner());

    for domain in domains {
      let src = events_dir.join(format!("{domain}.jsonl"));
      if src.exists() {
        let dst = local_backup_dir.join(format!("{domain}.jsonl"));
        let bytes = copy_file(&src, &dst)?;
        let sha = sha256_file(&dst)?;
        total_bytes += bytes;
        files_list.push(BackupFile {
          name: format!("{domain}.jsonl"),
          bytes,
          sha256: sha,
        });
      }
    }

    // El llavero viaja con el respaldo para poder restaurar en otro equipo con
    // la misma contraseña. Está envuelto: sin la contraseña/código no sirve.
    let keyring_src = crate::keys::keyring_path(&root);
    if keyring_src.exists() {
      let dst = local_backup_dir.join("keyring.json");
      let bytes = copy_file(&keyring_src, &dst)?;
      let sha = sha256_file(&dst)?;
      total_bytes += bytes;
      files_list.push(BackupFile {
        name: "keyring.json".to_string(),
        bytes,
        sha256: sha,
      });
    }
  }

  let device_src = Path::new(&root).join("device_id");
  if device_src.exists() {
    let dst = local_backup_dir.join("device_id");
    let bytes = copy_file(&device_src, &dst)?;
    let sha = sha256_file(&dst)?;
    total_bytes += bytes;
    files_list.push(BackupFile {
      name: "device_id".to_string(),
      bytes,
      sha256: sha,
    });
  }

  let mut device_id = read_device_id(root.as_str());
  if device_id.is_empty() {
    if let Ok(s) = fs::read_to_string(&local_backup_dir.join("device_id")) {
      device_id = s.trim().to_string();
    }
  }

  let vault_path_str = read_vault_path(&root);
  let mut vault_backup_path: Option<String> = None;
  if let Some(ref vpath) = vault_path_str {
    #[cfg(target_os = "android")]
    {
      if is_saf_uri(vpath) {
        // Android SAF: usar JNI
        if let Ok(devices_dir) = crate::android_fs::vault_create_dir(vpath, "inventario-tienda-backup") {
          let mut cur = devices_dir.clone();
          if let Ok(d) = crate::android_fs::vault_create_dir(&cur, "devices") { cur = d; }
          if !device_id.is_empty() {
            if let Ok(d) = crate::android_fs::vault_create_dir(&cur, &device_id) { cur = d; }
          }
          if let Ok(d) = crate::android_fs::vault_create_dir(&cur, "daily") { cur = d; }
          if let Ok(d) = crate::android_fs::vault_create_dir(&cur, &date) { cur = d; }
          let vault_daily = cur;
          let mut all_ok = true;
          for f in &files_list {
            let src_f = local_backup_dir.join(&f.name);
            if let Ok(bytes) = fs::read(&src_f) {
              if crate::android_fs::vault_write_file(&vault_daily, &f.name, &bytes).is_err() {
                all_ok = false;
              }
            } else {
              all_ok = false;
            }
          }
          if all_ok {
            vault_backup_path = Some(vault_daily);
          }
        }
      } else {
        // Android: ruta normal (app data dir)
        let vault_dir = Path::new(vpath);
        if vault_dir.exists() || fs::create_dir_all(vault_dir).is_ok() {
          let vault_daily = vault_dir
            .join("inventario-tienda-backup")
            .join("devices")
            .join(&device_id)
            .join("daily")
            .join(&date);
          if fs::create_dir_all(&vault_daily).is_ok() {
            let mut all_ok = true;
            for f in &files_list {
              let src_f = local_backup_dir.join(&f.name);
              let dst_f = vault_daily.join(&f.name);
              if copy_file(&src_f, &dst_f).is_err() {
                all_ok = false;
              }
            }
            if all_ok {
              vault_backup_path = Some(vault_daily.to_string_lossy().to_string());
            }
          }
        }
      }
    }
    #[cfg(not(target_os = "android"))]
    {
      // Escritorio: usar fs normal
      let vault_dir = Path::new(vpath);
      if vault_dir.exists() || fs::create_dir_all(vault_dir).is_ok() {
        let vault_daily = vault_dir
          .join("inventario-tienda-backup")
          .join("devices")
          .join(&device_id)
          .join("daily")
          .join(&date);
        if fs::create_dir_all(&vault_daily).is_ok() {
          let mut all_ok = true;
          for f in &files_list {
            let src_f = local_backup_dir.join(&f.name);
            let dst_f = vault_daily.join(&f.name);
            if copy_file(&src_f, &dst_f).is_err() {
              all_ok = false;
            }
          }
          if all_ok {
            vault_backup_path = Some(vault_daily.to_string_lossy().to_string());
          }
        }
      }
    }
  }

  let mut hasher_total = Sha256::new();
  for f in &files_list {
    hasher_total.update(f.sha256.as_bytes());
  }
  let manifest = BackupManifest {
    version: 1,
    date: date.clone(),
    created_at: now_iso(),
    device_id,
    root: root.clone(),
    vault_path: vault_path_str.clone(),
    files: files_list.clone(),
    total_bytes,
    sha256_total: format!("{:x}", hasher_total.finalize()),
  };
  let manifest_s = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
  fs::write(local_backup_dir.join("manifest.json"), &manifest_s).map_err(|e| e.to_string())?;
  if let Some(ref vbp) = vault_backup_path {
    fs::write(Path::new(vbp).join("manifest.json"), &manifest_s).ok();
  }

  let _ = app;
  let mut errors: Vec<String> = Vec::new();
  if let Some(ref vpath) = vault_path_str {
    let vault_dir = Path::new(vpath);
    if !vault_dir.exists() && fs::create_dir_all(vault_dir).is_err() {
      errors.push(format!("No se pudo crear/acceder a la bóveda externa: {}", vpath));
    }
  }
  // Verificar cada archivo copiado a la bóveda
  if vault_path_str.is_some() && vault_backup_path.is_none() {
    errors.push("No se pudo escribir en la bóveda externa (¿permiso denegado o carpeta inaccesible?)".to_string());
  } else if let Some(ref vbp) = vault_backup_path {
    for f in &files_list {
      let dst = Path::new(vbp).join(&f.name);
      if !dst.exists() {
        errors.push(format!("No se pudo copiar {} a la bóveda", f.name));
      }
    }
  }

  Ok(BackupResult {
    date,
    local_path: local_backup_dir.to_string_lossy().to_string(),
    vault_path: vault_backup_path,
    files: files_list.len(),
    total_bytes,
    errors,
  })
}

#[tauri::command]
pub fn backup_pull_from_vault(app: AppHandle, root: String) -> Result<BackupPullResult, String> {
  let _lock = BACKUP_MERGE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  // Fusionar texto plano en un equipo cifrado lo dejaría sin cifrar, y fusionar
  // ciphertext de otra clave dejaría eventos ilegibles. Se exige desbloqueo.
  if crate::crypto::is_enabled(&root) && crate::crypto::current_key(&root).is_none() {
    return Err(
      "ENC_LOCKED: Desbloqueá el cifrado antes de fusionar respaldos.".to_string(),
    );
  }
  let local_key = crate::crypto::current_key(&root);
  let vault_path_str = read_vault_path(&root).ok_or_else(|| {
    "No hay bóveda externa configurada. Configurá la ruta en Ajustes > Respaldos diarios."
      .to_string()
  })?;
  let vault_dir = Path::new(&vault_path_str);
  if !vault_dir.exists() {
    return Err("La carpeta de bóveda externa no existe o no está accesible.".to_string());
  }
  let our_device_id = read_device_id(&root);
  let devices_root = vault_dir.join("inventario-tienda-backup").join("devices");
  if !devices_root.exists() {
    return Err(
      "La bóveda no tiene respaldos por dispositivo. Generá un backup desde el otro equipo primero."
        .to_string(),
    );
  }

  let events_dir = Path::new(&root).join("events");
  fs::create_dir_all(&events_dir).map_err(|e| format!("No se pudo crear carpeta events: {e}"))?;

  let domains = [
    "collections",
    "products",
    "colors",
    "variants",
    "customers",
    "orders",
    "order_lines",
    "payments",
    "production_orders",
    "production_lines",
    "stock_movements",
    "expenses",
    "settings",
    "device_info",
  ];

  let mut pulled_files: usize = 0;
  let mut added_lines: usize = 0;
  let mut scanned_devices: usize = 0;
  let mut skipped_incompatible: usize = 0;
  let mut seen_global: std::collections::HashSet<String> = std::collections::HashSet::new();

  let mut device_entries: Vec<PathBuf> = Vec::new();
  if let Ok(entries) = fs::read_dir(&devices_root) {
    for e in entries.flatten() {
      if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
        device_entries.push(e.path());
      }
    }
  }

  for dev_dir in device_entries {
    let dev_name = dev_dir
      .file_name()
      .and_then(|n| n.to_str())
      .unwrap_or("")
      .to_string();
    if dev_name.is_empty() || (!our_device_id.is_empty() && dev_name == our_device_id) {
      continue;
    }
    scanned_devices += 1;
    let daily_root = dev_dir.join("daily");
    if !daily_root.exists() {
      continue;
    }
    let mut dates: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&daily_root) {
      for e in entries.flatten() {
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
          if let Some(name) = e.file_name().to_str() {
            if name.len() == 10 && name.chars().all(|c| c.is_ascii_digit() || c == '-') {
              dates.push(name.to_string());
            }
          }
        }
      }
    }
    dates.sort();
    for date in dates {
      let day_dir = daily_root.join(&date);
      for domain in domains {
        let src = day_dir.join(format!("{domain}.jsonl"));
        if !src.exists() {
          continue;
        }
        let dst = events_dir.join(format!("{domain}.jsonl"));
        if let Some(parent) = dst.parent() {
          fs::create_dir_all(parent).ok();
        }
        let existing_ids = read_event_ids(&dst);
        let mut ids = existing_ids.clone();
        let mut to_add: Vec<String> = Vec::new();
        if let Ok(file) = fs::File::open(&src) {
          let reader = BufReader::new(file);
          for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
              continue;
            }
            // Deduplicar por `id`, no por línea completa: un mismo evento puede
            // llegar cifrado con otro nonce (misma clave) y no debe duplicarse.
            let Some(id) = line_event_id(trimmed) else {
              skipped_incompatible += 1;
              continue;
            };
            if ids.contains(&id) {
              continue;
            }
            if !seen_global.insert(format!("{domain}|{id}")) {
              continue;
            }

            let mut event: serde_json::Value = match serde_json::from_str(trimmed) {
              Ok(value) => value,
              Err(_) => {
                skipped_incompatible += 1;
                continue;
              }
            };
            let payload = event
              .get("payload")
              .cloned()
              .unwrap_or(serde_json::Value::Null);

            let stored = match &local_key {
              Some(km) => {
                if crate::crypto::ensure_compatible_payload(&payload, km).is_err() {
                  skipped_incompatible += 1;
                  continue;
                }
                let event_type = event
                  .get("type")
                  .and_then(|v| v.as_str())
                  .unwrap_or_default();
                let sealed =
                  crate::crypto::encrypt_event_value(&id, event_type, &payload, km)
                    .map_err(|e| format!("No se pudo cifrar el evento {id} al fusionar: {e}"))?;
                event["payload"] = sealed;
                serde_json::to_string(&event)
                  .map_err(|e| format!("No se pudo serializar el evento {id}: {e}"))?
              }
              None => {
                if crate::crypto::unwrap_encrypted(&payload).is_some() {
                  skipped_incompatible += 1;
                  continue;
                }
                trimmed.to_string()
              }
            };

            ids.insert(id);
            to_add.push(stored);
          }
        }
        if !to_add.is_empty() {
          // Misma exclusión que store_append para no mezclar escrituras.
          let _write_guard = crate::event_store::EVENTS_WRITE_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
          let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&dst)
            .map_err(|e| format!("No se pudo abrir {dst:?} para fusionar: {e}"))?;
          for l in &to_add {
            writeln!(file, "{l}").map_err(|e| format!("Error escribiendo en fusión: {e}"))?;
            added_lines += 1;
          }
          file.flush().ok();
          pulled_files += 1;
        }
      }
    }
  }

  let _ = app;
  Ok(BackupPullResult {
    pulled_files,
    added_lines,
    scanned_devices,
    skipped_incompatible,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn is_saf_uri_detects_content_scheme() {
    assert!(is_saf_uri("content://com.android.externalstorage.documents/tree/primary:Download"));
    assert!(!is_saf_uri("/home/user/backup"));
    assert!(!is_saf_uri("C:\\\\backup"));
  }

  #[test]
  fn read_vault_path_returns_none_when_no_settings() {
    let tmp = std::env::temp_dir().join("backup_test_no_settings");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let root = tmp.to_string_lossy().to_string();
    assert!(read_vault_path(&root).is_none());
    let _ = std::fs::remove_dir_all(&tmp);
  }

  #[test]
  fn read_vault_path_reads_vault_path() {
    let tmp = std::env::temp_dir().join("backup_test_read");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let root = tmp.to_string_lossy().to_string();
    let settings = serde_json::json!({ "backup_vault_path": "/tmp/vault" });
    std::fs::write(tmp.join("settings.json"), serde_json::to_string(&settings).unwrap()).unwrap();
    assert_eq!(read_vault_path(&root), Some("/tmp/vault".to_string()));
    let _ = std::fs::remove_dir_all(&tmp);
  }

  #[test]
  fn read_vault_path_reads_saf_uri() {
    let tmp = std::env::temp_dir().join("backup_test_saf");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let root = tmp.to_string_lossy().to_string();
    let uri = "content://com.android.externalstorage.documents/tree/primary:Download";
    let settings = serde_json::json!({ "backup_vault_uri": uri });
    std::fs::write(tmp.join("settings.json"), serde_json::to_string(&settings).unwrap()).unwrap();
    assert_eq!(read_vault_path(&root), Some(uri.to_string()));
    let _ = std::fs::remove_dir_all(&tmp);
  }

  #[test]
  fn write_vault_path_persists() {
    let tmp = std::env::temp_dir().join("backup_test_write");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let root = tmp.to_string_lossy().to_string();
    write_vault_path(&root, Some("/tmp/myvault".to_string())).unwrap();
    assert_eq!(read_vault_path(&root), Some("/tmp/myvault".to_string()));
    write_vault_path(&root, None).unwrap();
    assert!(read_vault_path(&root).is_none());
    let _ = std::fs::remove_dir_all(&tmp);
  }

  #[test]
  fn vault_accessible_checks_desktop_path() {
    let tmp = std::env::temp_dir().join("backup_test_accessible");
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let p = tmp.to_string_lossy().to_string();
    assert!(vault_accessible(&p));
    let _ = std::fs::remove_dir_all(&tmp);
    let p2 = std::env::temp_dir().join("backup_test_accessible2").to_string_lossy().to_string();
    assert!(vault_accessible(&p2));
    let _ = std::fs::remove_dir_all(&p2);
  }
}
