//! Copias "longlife".
//!
//! Cada 24 horas se guarda una copia idéntica de `<bóveda>/omega` en
//! `<bóveda>/longlife/YYYY-MM-DD/`. Se conservan las **7 fechas más
//! recientes**. La app **nunca** lee `longlife` automáticamente: es un
//! snapshot para que el usuario lo restaure a mano si lo necesita.
//!
//! El snapshot incluye el llavero (`keys/keyring.json`), que está envuelto con
//! la contraseña maestra. Sin esa contraseña (o el código de recuperación) el
//! contenido cifrado no sirve, aunque alguien copie la carpeta.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use crate::{storage, vault};

pub const MAX_SNAPSHOTS: usize = 7;
const LONGLIFE_DIR: &str = "longlife";
const MANIFEST_FILE: &str = "manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeFile {
  pub name: String,
  pub bytes: u64,
  pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeManifest {
  pub version: u32,
  pub date: String,
  pub created_at: String,
  pub data_root: String,
  pub files: Vec<LonglifeFile>,
  pub total_bytes: u64,
  pub sha256_total: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeStatus {
  pub has_vault: bool,
  pub vault_path: Option<String>,
  pub last_date: Option<String>,
  pub last_created_at: Option<String>,
  pub count: usize,
  pub max_days: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeEntry {
  pub date: String,
  pub created_at: Option<String>,
  pub files: usize,
  pub total_bytes: u64,
  pub valid: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeResult {
  pub date: String,
  pub path: String,
  pub files: usize,
  pub total_bytes: u64,
  /// `true` si ya existía la copia del día y no se regeneró.
  pub reused: bool,
}

fn today_str() -> String {
  chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339()
}

fn sha256(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

fn is_date_dir(name: &str) -> bool {
  name.len() == 10
    && name.as_bytes()[4] == b'-'
    && name.as_bytes()[7] == b'-'
    && name
      .chars()
      .all(|c| c.is_ascii_digit() || c == '-')
}

/// Ordena fechas ISO (`YYYY-MM-DD`) y deja solo las `keep` más recientes.
pub fn keep_latest(dates: &[String], keep: usize) -> (Vec<String>, Vec<String>) {
  let mut sorted: Vec<String> = dates
    .iter()
    .filter(|date| is_date_dir(date))
    .cloned()
    .collect();
  sorted.sort();
  sorted.dedup();
  if sorted.len() <= keep {
    return (sorted, Vec::new());
  }
  let split = sorted.len() - keep;
  let (old, recent) = sorted.split_at(split);
  (recent.to_vec(), old.to_vec())
}

fn list_dates(vault_root: &str) -> Result<Vec<String>, String> {
  let mut dates: Vec<String> = storage::list_dir(vault_root, LONGLIFE_DIR)?
    .into_iter()
    .filter(|name| is_date_dir(name))
    .collect();
  dates.sort();
  Ok(dates)
}

fn read_manifest(vault_root: &str, date: &str) -> Option<LonglifeManifest> {
  let text = storage::read_string(
    vault_root,
    &format!("{LONGLIFE_DIR}/{date}/{MANIFEST_FILE}"),
  )
  .ok()??;
  serde_json::from_str(&text).ok()
}

/// Estado resumido de las copias, sin crear ni modificar nada.
#[tauri::command]
pub fn longlife_status(app: AppHandle) -> Result<LonglifeStatus, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Ok(LonglifeStatus {
      has_vault: false,
      vault_path: None,
      last_date: None,
      last_created_at: None,
      count: 0,
      max_days: MAX_SNAPSHOTS,
    });
  };
  let dates = match list_dates(&config.vault_root) {
    Ok(dates) => dates,
    Err(_) => Vec::new(),
  };
  let last = dates.last().cloned();
  let last_created_at = last
    .as_deref()
    .and_then(|date| read_manifest(&config.vault_root, date))
    .map(|manifest| manifest.created_at);
  Ok(LonglifeStatus {
    has_vault: true,
    vault_path: Some(config.vault_root),
    last_date: last,
    last_created_at,
    count: dates.len(),
    max_days: MAX_SNAPSHOTS,
  })
}

/// Lista las copias existentes, de la más nueva a la más vieja.
#[tauri::command]
pub fn longlife_list(app: AppHandle) -> Result<Vec<LonglifeEntry>, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Ok(Vec::new());
  };
  let mut dates = list_dates(&config.vault_root)?;
  dates.reverse();
  let mut out = Vec::with_capacity(dates.len());
  for date in dates {
    match read_manifest(&config.vault_root, &date) {
      Some(manifest) => out.push(LonglifeEntry {
        date,
        created_at: Some(manifest.created_at),
        files: manifest.files.len(),
        total_bytes: manifest.total_bytes,
        valid: true,
      }),
      None => out.push(LonglifeEntry {
        date,
        created_at: None,
        files: 0,
        total_bytes: 0,
        valid: false,
      }),
    }
  }
  Ok(out)
}

/// Copia `<vault>/omega` a `<vault>/longlife/YYYY-MM-DD/`.
///
/// Es idempotente por día: si ya existe `manifest.json` y `force` es falso,
/// devuelve la copia existente. Tras copiar, elimina las fechas sobrantes.
#[tauri::command]
pub fn longlife_run(app: AppHandle, force: Option<bool>) -> Result<LonglifeResult, String> {
  let force = force.unwrap_or(false);
  let Some(config) = vault::load_config(&app)? else {
    return Err(format!(
      "{} Elegí una carpeta bóveda para empezar.",
      vault::VAULT_NOT_CONFIGURED
    ));
  };
  run_snapshot(
    &config.data_root,
    &config.vault_root,
    &today_str(),
    force,
  )
}

/// Núcleo del snapshot, separado del `AppHandle` para poder probarlo.
fn run_snapshot(
  data_root: &str,
  vault_root: &str,
  date: &str,
  force: bool,
) -> Result<LonglifeResult, String> {
  let day_dir = format!("{LONGLIFE_DIR}/{date}");

  // En SAF `list_dir` falla si la carpeta no existe; crearla es idempotente.
  storage::create_dir_all(vault_root, LONGLIFE_DIR)?;

  if !force {
    if let Some(existing) = read_manifest(vault_root, date) {
      return Ok(LonglifeResult {
        date: date.to_string(),
        path: day_dir,
        files: existing.files.len(),
        total_bytes: existing.total_bytes,
        reused: true,
      });
    }
  } else {
    storage::remove_dir_all(vault_root, &day_dir)?;
  }

  // Copia completa de omega, salvo los respaldos previos a una migración
  // (pueden ser grandes y no forman parte del estado vivo).
  let files = storage::list_files_recursive(data_root, "")?;
  let mut manifest_files: Vec<LonglifeFile> = Vec::new();
  let mut total_bytes = 0u64;

  {
    let _guard = crate::event_store::EVENTS_WRITE_LOCK
      .lock()
      .unwrap_or_else(|e| e.into_inner());

    for relative in files {
      let file_name = relative.rsplit('/').next().unwrap_or(relative.as_str());
      if relative.starts_with("backups/")
        || relative == MANIFEST_FILE
        || file_name.starts_with(".keep-")
      {
        continue;
      }
      let Some(bytes) = storage::read_bytes(data_root, &relative)? else {
        continue;
      };
      let destination = format!("{day_dir}/{relative}");
      storage::write_bytes(vault_root, &destination, &bytes)?;
      total_bytes += bytes.len() as u64;
      manifest_files.push(LonglifeFile {
        name: relative,
        bytes: bytes.len() as u64,
        sha256: sha256(&bytes),
      });
    }
  }

  manifest_files.sort_by(|a, b| a.name.cmp(&b.name));
  let mut total_hasher = Sha256::new();
  for file in &manifest_files {
    total_hasher.update(file.sha256.as_bytes());
  }
  let manifest = LonglifeManifest {
    version: 1,
    date: date.to_string(),
    created_at: now_iso(),
    data_root: "omega".to_string(),
    files: manifest_files,
    total_bytes,
    sha256_total: format!("{:x}", total_hasher.finalize()),
  };
  let json = serde_json::to_string_pretty(&manifest)
    .map_err(|e| format!("No se pudo serializar el manifiesto: {e}"))?;
  storage::write_atomic(
    vault_root,
    &format!("{day_dir}/{MANIFEST_FILE}"),
    json.as_bytes(),
  )?;

  prune_old(vault_root)?;

  Ok(LonglifeResult {
    date: date.to_string(),
    path: day_dir,
    files: manifest.files.len(),
    total_bytes: manifest.total_bytes,
    reused: false,
  })
}

fn prune_old(vault_root: &str) -> Result<(), String> {
  let dates = list_dates(vault_root)?;
  let (_, old) = keep_latest(&dates, MAX_SNAPSHOTS);
  for date in old {
    storage::remove_dir_all(vault_root, &format!("{LONGLIFE_DIR}/{date}"))?;
  }
  Ok(())
}

/// Borra **todas** las copias longlife. No toca `omega`.
#[tauri::command]
pub fn longlife_delete(app: AppHandle) -> Result<(), String> {
  let Some(config) = vault::load_config(&app)? else {
    return Ok(());
  };
  storage::remove_dir_all(&config.vault_root, LONGLIFE_DIR)?;
  storage::create_dir_all(&config.vault_root, LONGLIFE_DIR)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir().join(format!("inventario-longlife-{tag}-{nanos}"))
  }

  #[test]
  fn detects_date_directories() {
    assert!(is_date_dir("2026-10-28"));
    assert!(!is_date_dir("2026-1-28"));
    assert!(!is_date_dir("manifest.json"));
    assert!(!is_date_dir("2026-10-28-copia"));
  }

  #[test]
  fn keeps_only_the_latest_seven_dates() {
    let dates: Vec<String> = (1..=10)
      .map(|day| format!("2026-10-{day:02}"))
      .collect();
    let (recent, old) = keep_latest(&dates, 7);
    assert_eq!(old, vec!["2026-10-01", "2026-10-02", "2026-10-03"]);
    assert_eq!(recent.len(), 7);
    assert_eq!(recent.first().unwrap(), "2026-10-04");
    assert_eq!(recent.last().unwrap(), "2026-10-10");
  }

  #[test]
  fn ignores_non_date_entries_and_dedupes() {
    let dates = vec![
      "2026-10-02".to_string(),
      "manifest.json".to_string(),
      "2026-10-01".to_string(),
      "2026-10-02".to_string(),
    ];
    let (recent, old) = keep_latest(&dates, 7);
    assert_eq!(recent, vec!["2026-10-01", "2026-10-02"]);
    assert!(old.is_empty());
  }

  #[test]
  fn snapshot_copies_omega_and_prunes_to_seven_days() {
    let base = temp_dir("snapshot");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"uno\n").unwrap();
    storage::write_bytes(&omega_s, "keys/keyring.json", b"{}").unwrap();
    storage::write_bytes(&omega_s, "events/.keep-123", b"").unwrap();
    storage::write_bytes(&omega_s, "backups/pre-encryption/events/orders.jsonl", b"viejo\n")
      .unwrap();

    for day in 1..=7 {
      storage::write_bytes(
        &vault_s,
        &format!("longlife/2026-10-{day:02}/manifest.json"),
        b"{}",
      )
      .unwrap();
    }

    let result = run_snapshot(&omega_s, &vault_s, "2026-10-08", false).unwrap();
    assert!(!result.reused);
    assert_eq!(result.files, 2, "no debe copiar backups/");
    assert!(storage::exists(
      &vault_s,
      "longlife/2026-10-08/events/orders.jsonl"
    )
    .unwrap());
    assert!(storage::exists(
      &vault_s,
      "longlife/2026-10-08/keys/keyring.json"
    )
    .unwrap());
    assert!(storage::exists(
      &vault_s,
      "longlife/2026-10-08/manifest.json"
    )
    .unwrap());
    assert!(!storage::exists(
      &vault_s,
      "longlife/2026-10-08/backups/pre-encryption/events/orders.jsonl"
    )
    .unwrap());
    assert!(!storage::exists(&vault_s, "longlife/2026-10-08/events/.keep-123").unwrap());

    // 8 fechas → se conservan las 7 más nuevas (02..08).
    assert_eq!(
      list_dates(&vault_s).unwrap(),
      (2..=8)
        .map(|day| format!("2026-10-{day:02}"))
        .collect::<Vec<_>>()
    );

    let reused = run_snapshot(&omega_s, &vault_s, "2026-10-08", false).unwrap();
    assert!(reused.reused);
    let forced = run_snapshot(&omega_s, &vault_s, "2026-10-08", true).unwrap();
    assert!(!forced.reused);

    let _ = std::fs::remove_dir_all(&base);
  }
}
