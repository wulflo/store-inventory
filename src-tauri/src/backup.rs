//! Copias "longlife" por dispositivo.
//!
//! Cada instalación guarda sus snapshots en
//! `<bóveda>/longlife/<dispositivo>/<YYYY-MM-DD>/`. Así dos equipos que
//! sincronizan la misma bóveda no se pisan la copia del día. Las copias
//! antiguas en `<bóveda>/longlife/<YYYY-MM-DD>/` se siguen leyendo como
//! "copias anteriores" (sin dispositivo).
//!
//! La copia del día se crea al arrancar y se refresca pocos minutos después de
//! cada cambio local; además se actualiza al pasar a segundo plano, al cerrar y
//! cada 24 h. Se conservan las **7 fechas más recientes por dispositivo** y
//! hasta **3 copias previas a una restauración**.
//!
//! El snapshot incluye el llavero (`keys/keyring.json`), que está envuelto con
//! la contraseña maestra. Sin esa contraseña (o el código de recuperación) el
//! contenido cifrado no sirve, aunque alguien copie la carpeta.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use tauri::AppHandle;

use crate::{crypto, event_store, journal, storage, vault, writer};

pub const MAX_SNAPSHOTS: usize = 7;
const MAX_PRE_RESTORE_SNAPSHOTS: usize = 3;
const LONGLIFE_DIR: &str = "longlife";
const MANIFEST_FILE: &str = "manifest.json";
const PRE_RESTORE_PREFIX: &str = "pre-restore-";

/// Serializa la creación, el refresco, la restauración y el borrado de
/// snapshots. Sin esto, una actualización automática y una acción manual
/// podrían mezclar archivos y manifiestos.
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());

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
  /// Carpeta del dispositivo que hizo la copia. Ausente en snapshots viejos.
  #[serde(default)]
  pub device_id: Option<String>,
  #[serde(default)]
  pub device_name: Option<String>,
  /// `daily`, `pre-restore` o `legacy`.
  #[serde(default)]
  pub kind: Option<String>,
  pub files: Vec<LonglifeFile>,
  pub total_bytes: u64,
  pub sha256_total: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeStatus {
  pub has_vault: bool,
  pub vault_path: Option<String>,
  pub device_id: Option<String>,
  pub device_name: Option<String>,
  pub last_date: Option<String>,
  pub last_created_at: Option<String>,
  pub count: usize,
  pub total_count: usize,
  pub max_days: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeEntry {
  pub device_id: Option<String>,
  pub device_name: Option<String>,
  pub kind: String,
  pub date: String,
  pub created_at: Option<String>,
  pub files: usize,
  pub total_bytes: u64,
  pub valid: bool,
  pub encrypted: bool,
  pub relative_path: String,
}

/// Detalle de una copia, para revisarla antes de restaurar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeFolder {
  pub relative_path: String,
  /// Ruta absoluta en escritorio; `None` en Android (bóveda SAF).
  pub absolute_path: Option<String>,
  pub created_at: Option<String>,
  pub kind: Option<String>,
  pub device_id: Option<String>,
  pub device_name: Option<String>,
  pub files: Vec<LonglifeFile>,
  pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeResult {
  pub device_id: String,
  pub device_name: String,
  pub kind: String,
  pub date: String,
  pub path: String,
  pub files: usize,
  pub total_bytes: u64,
  /// `true` si la copia del día ya estaba al día (sin cambios).
  pub reused: bool,
  /// `true` si se evitó reemplazar una copia con datos por un `omega` vacío.
  pub protected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LonglifeRestoreResult {
  pub restored_from: String,
  pub pre_restore: String,
  pub files: usize,
  pub total_bytes: u64,
  pub encrypted: bool,
  pub requires_unlock: bool,
  pub journal_repaired: usize,
  pub journal_pending: usize,
  pub journal_stale: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotKind {
  Daily,
  PreRestore,
  Legacy,
}

impl SnapshotKind {
  fn as_str(self) -> &'static str {
    match self {
      SnapshotKind::Daily => "daily",
      SnapshotKind::PreRestore => "pre-restore",
      SnapshotKind::Legacy => "legacy",
    }
  }

}

fn today_str() -> String {
  chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339()
}

fn pre_restore_name() -> String {
  let now = chrono::Local::now();
  format!(
    "{PRE_RESTORE_PREFIX}{}-{:03}",
    now.format("%Y%m%d-%H%M%S"),
    now.timestamp_subsec_millis()
  )
}

fn sha256(bytes: &[u8]) -> String {
  let mut hasher = Sha256::new();
  hasher.update(bytes);
  format!("{:x}", hasher.finalize())
}

/// `true` si el archivo de `omega` debe viajar dentro del snapshot.
fn is_snapshot_file(relative: &str) -> bool {
  let file_name = relative.rsplit('/').next().unwrap_or(relative);
  !(relative.starts_with("backups/")
    || relative == MANIFEST_FILE
    || relative == "writer.json"
    || file_name.starts_with(".keep-"))
}

fn source_snapshot_files(data_root: &str) -> Result<Vec<String>, String> {
  Ok(
    storage::list_files_recursive(data_root, "")?
      .into_iter()
      .filter(|relative| is_snapshot_file(relative))
      .collect(),
  )
}

fn is_date_dir(name: &str) -> bool {
  name.len() == 10
    && name.as_bytes()[4] == b'-'
    && name.as_bytes()[7] == b'-'
    && name
      .chars()
      .all(|c| c.is_ascii_digit() || c == '-')
}

fn is_pre_restore_dir(name: &str) -> bool {
  let Some(suffix) = name.strip_prefix(PRE_RESTORE_PREFIX) else {
    return false;
  };
  // `YYYYMMDD-HHMMSS` o `YYYYMMDD-HHMMSS-mmm`; solo dígitos y guiones.
  suffix.len() >= 15
    && suffix
      .chars()
      .all(|c| c.is_ascii_digit() || c == '-')
}

fn is_snapshot_name(name: &str) -> bool {
  is_date_dir(name) || is_pre_restore_dir(name)
}

/// Nombre de carpeta seguro para un dispositivo.
fn is_safe_device_folder(name: &str) -> bool {
  !name.is_empty()
    && name.len() <= 128
    && name != "."
    && name != ".."
    && !name.starts_with('.')
    && !is_date_dir(name)
    && !is_pre_restore_dir(name)
    && name
      .chars()
      .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Convierte el identificador de instalación en una carpeta segura.
///
/// Los IDs normales son UUID; si alguno trae caracteres raros se usa un hash
/// estable para no romper la ruta ni permitir `..`.
fn safe_device_folder(id: &str) -> String {
  let trimmed = id.trim();
  if is_safe_device_folder(trimmed) {
    return trimmed.to_string();
  }
  let mut hasher = Sha256::new();
  hasher.update(trimmed.as_bytes());
  let hash = format!("{:x}", hasher.finalize());
  format!("device-{}", &hash[..16])
}

fn device_dir(device_id: &str) -> String {
  format!("{LONGLIFE_DIR}/{device_id}")
}

fn snapshot_relative(device_id: Option<&str>, name: &str) -> String {
  match device_id {
    Some(id) => format!("{LONGLIFE_DIR}/{id}/{name}"),
    None => format!("{LONGLIFE_DIR}/{name}"),
  }
}

fn manifest_relative(snapshot: &str) -> String {
  format!("{snapshot}/{MANIFEST_FILE}")
}

/// Valida `device_id`/`date` y arma la ruta relativa de una copia.
fn snapshot_relative_checked(device_id: Option<&str>, date: &str) -> Result<String, String> {
  if !is_snapshot_name(date) {
    return Err(format!("'{date}' no es una copia longlife válida."));
  }
  match device_id {
    Some(id) => {
      if !is_safe_device_folder(id) {
        return Err("El identificador del dispositivo no es válido.".to_string());
      }
      Ok(snapshot_relative(Some(id), date))
    }
    None => Ok(snapshot_relative(None, date)),
  }
}

fn is_safe_relative(name: &str) -> bool {
  !name.is_empty()
    && !name.starts_with('/')
    && !name.contains('\\')
    && name
      .split('/')
      .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn build_manifest(
  date: &str,
  device_id: Option<&str>,
  device_name: Option<&str>,
  kind: SnapshotKind,
  mut files: Vec<LonglifeFile>,
  total_bytes: u64,
) -> LonglifeManifest {
  files.sort_by(|a, b| a.name.cmp(&b.name));
  let mut total_hasher = Sha256::new();
  for file in &files {
    total_hasher.update(file.sha256.as_bytes());
  }
  LonglifeManifest {
    version: 2,
    date: date.to_string(),
    created_at: now_iso(),
    data_root: "omega".to_string(),
    device_id: device_id.map(str::to_string),
    device_name: device_name.map(str::to_string),
    kind: Some(kind.as_str().to_string()),
    files,
    total_bytes,
    sha256_total: format!("{:x}", total_hasher.finalize()),
  }
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

fn read_manifest(vault_root: &str, relative: &str) -> Option<LonglifeManifest> {
  let text = storage::read_string(vault_root, &manifest_relative(relative))
    .ok()??;
  serde_json::from_str(&text).ok()
}

#[derive(Debug, Clone)]
struct SnapshotDir {
  device_id: Option<String>,
  name: String,
  kind: SnapshotKind,
  relative: String,
}

fn list_snapshot_dirs(vault_root: &str) -> Result<Vec<SnapshotDir>, String> {
  let mut out = Vec::new();
  let entries = match storage::list_dir(vault_root, LONGLIFE_DIR) {
    Ok(entries) => entries,
    Err(_) => return Ok(out),
  };
  for name in entries {
    if is_date_dir(&name) {
      out.push(SnapshotDir {
        device_id: None,
        name: name.clone(),
        kind: SnapshotKind::Legacy,
        relative: snapshot_relative(None, &name),
      });
      continue;
    }
    if !is_safe_device_folder(&name) {
      continue;
    }
    let children = match storage::list_dir(vault_root, &device_dir(&name)) {
      Ok(children) => children,
      Err(_) => continue,
    };
    for child in children {
      if !is_snapshot_name(&child) {
        continue;
      }
      out.push(SnapshotDir {
        device_id: Some(name.clone()),
        name: child.clone(),
        kind: if is_pre_restore_dir(&child) {
          SnapshotKind::PreRestore
        } else {
          SnapshotKind::Daily
        },
        relative: snapshot_relative(Some(&name), &child),
      });
    }
  }
  out.sort_by(|a, b| {
    a.device_id
      .cmp(&b.device_id)
      .then_with(|| b.name.cmp(&a.name))
  });
  Ok(out)
}

fn list_device_snapshots(
  vault_root: &str,
  device_id: &str,
) -> Result<Vec<(String, SnapshotKind)>, String> {
  let entries = match storage::list_dir(vault_root, &device_dir(device_id)) {
    Ok(entries) => entries,
    Err(_) => return Ok(Vec::new()),
  };
  let mut out = Vec::new();
  for name in entries {
    if is_date_dir(&name) {
      out.push((name, SnapshotKind::Daily));
    } else if is_pre_restore_dir(&name) {
      out.push((name, SnapshotKind::PreRestore));
    }
  }
  out.sort_by(|a, b| a.0.cmp(&b.0));
  Ok(out)
}

fn prune_old(
  vault_root: &str,
  device_id: &str,
  protect: &[&str],
) -> Result<(), String> {
  let base = device_dir(device_id);
  let names = storage::list_dir(vault_root, &base).unwrap_or_default();

  let daily: Vec<String> = names
    .iter()
    .filter(|name| is_date_dir(name))
    .cloned()
    .collect();
  let (_, old_daily) = keep_latest(&daily, MAX_SNAPSHOTS);
  for date in old_daily {
    if protect.contains(&date.as_str()) {
      continue;
    }
    storage::remove_dir_all(vault_root, &format!("{base}/{date}"))?;
  }

  let mut pre: Vec<String> = names
    .iter()
    .filter(|name| is_pre_restore_dir(name))
    .cloned()
    .collect();
  pre.sort();
  if pre.len() > MAX_PRE_RESTORE_SNAPSHOTS {
    // Ventana de gracia por `createdAt` del manifiesto: si el reloj del equipo
    // está atrasado, el nombre de la copia recién creada puede ordenar como
    // viejo. No se poda una copia de los últimos 10 minutos.
    let now = chrono::Utc::now();
    let recently_created = |name: &str| -> bool {
      read_manifest(vault_root, &snapshot_relative(Some(device_id), name))
        .and_then(|manifest| {
          chrono::DateTime::parse_from_rfc3339(&manifest.created_at).ok()
        })
        .map(|created| now.signed_duration_since(created).num_minutes() < 10)
        .unwrap_or(false)
    };
    for old in &pre[..pre.len() - MAX_PRE_RESTORE_SNAPSHOTS] {
      // Nunca borrar la copia que se está restaurando mientras se la lee, ni
      // la copia previa recién creada.
      if protect.contains(&old.as_str()) || recently_created(old) {
        continue;
      }
      storage::remove_dir_all(vault_root, &format!("{base}/{old}"))?;
    }
  }
  Ok(())
}

/* ------------------------------------------------------------------ */
/* Comandos Tauri                                                     */
/* ------------------------------------------------------------------ */

/// Estado resumido de las copias, sin crear ni modificar nada.
#[tauri::command]
pub fn longlife_status(app: AppHandle) -> Result<LonglifeStatus, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Ok(LonglifeStatus {
      has_vault: false,
      vault_path: None,
      device_id: None,
      device_name: None,
      last_date: None,
      last_created_at: None,
      count: 0,
      total_count: 0,
      max_days: MAX_SNAPSHOTS,
    });
  };

  let installation = writer::installation_device_id(app.clone())?;
  let device_id = safe_device_folder(&installation);
  let device_name =
    writer::installation_name(&app).unwrap_or_else(writer::default_device_name);
  let snapshots = list_device_snapshots(&config.vault_root, &device_id).unwrap_or_default();
  let daily: Vec<String> = snapshots
    .iter()
    .filter(|(_, kind)| *kind == SnapshotKind::Daily)
    .map(|(name, _)| name.clone())
    .collect();
  let last_date = daily.last().cloned();
  let last_created_at = last_date.as_deref().and_then(|date| {
    read_manifest(
      &config.vault_root,
      &snapshot_relative(Some(&device_id), date),
    )
    .map(|manifest| manifest.created_at)
  });
  let total_count = list_snapshot_dirs(&config.vault_root)
    .map(|entries| entries.len())
    .unwrap_or(0);

  Ok(LonglifeStatus {
    has_vault: true,
    vault_path: Some(config.vault_root),
    device_id: Some(device_id),
    device_name: Some(device_name),
    last_date,
    last_created_at,
    count: daily.len(),
    total_count,
    max_days: MAX_SNAPSHOTS,
  })
}

/// Lista las copias de todos los dispositivos, de la más nueva a la más vieja.
#[tauri::command]
pub fn longlife_list(app: AppHandle) -> Result<Vec<LonglifeEntry>, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Ok(Vec::new());
  };
  let dirs = list_snapshot_dirs(&config.vault_root)?;
  let mut out = Vec::with_capacity(dirs.len());
  for dir in dirs {
    let manifest = read_manifest(&config.vault_root, &dir.relative);
    let kind = dir.kind;
    let (created_at, files, total_bytes, valid, encrypted) = match &manifest {
      Some(manifest) => (
        Some(manifest.created_at.clone()),
        manifest.files.len(),
        manifest.total_bytes,
        true,
        manifest
          .files
          .iter()
          .any(|file| file.name == "keys/keyring.json"),
      ),
      None => (None, 0, 0, false, false),
    };
    let device_name = match &dir.device_id {
      Some(id) => manifest
        .as_ref()
        .and_then(|m| m.device_name.clone())
        .or_else(|| Some(id.clone())),
      None => Some("Copia anterior".to_string()),
    };
    out.push(LonglifeEntry {
      device_id: dir.device_id,
      device_name,
      kind: kind.as_str().to_string(),
      date: dir.name,
      created_at,
      files,
      total_bytes,
      valid,
      encrypted,
      relative_path: dir.relative,
    });
  }
  Ok(out)
}

/// Copia `<vault>/omega` a `<vault>/longlife/<dispositivo>/<fecha>/`.
///
/// Es idempotente por día y dispositivo: si ya existe `manifest.json` y
/// `force` es falso, devuelve la copia existente. Con `refresh: true` actualiza
/// la copia del día sin borrarla primero, comparando hashes para escribir solo
/// lo que cambió. Tras copiar, elimina las fechas sobrantes de ese dispositivo.
#[tauri::command]
pub fn longlife_run(
  app: AppHandle,
  force: Option<bool>,
  refresh: Option<bool>,
) -> Result<LonglifeResult, String> {
  let force = force.unwrap_or(false);
  let refresh = refresh.unwrap_or(false);
  let Some(config) = vault::load_config(&app)? else {
    return Err(format!(
      "{} Elegí una carpeta bóveda para empezar.",
      vault::VAULT_NOT_CONFIGURED
    ));
  };
  let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

  let installation = writer::installation_device_id(app.clone())?;
  let device_id = safe_device_folder(&installation);
  let device_name =
    writer::installation_name(&app).unwrap_or_else(writer::default_device_name);
  let date = today_str();

  if refresh {
    run_snapshot_refresh(
      &config.data_root,
      &config.vault_root,
      &device_id,
      &device_name,
      &date,
    )
  } else {
    run_snapshot(
      &config.data_root,
      &config.vault_root,
      &device_id,
      &device_name,
      &date,
      SnapshotKind::Daily,
      force,
    )
  }
}

/// Restaura una copia concreta y deja la app bloqueada.
#[tauri::command]
pub fn longlife_restore(
  app: AppHandle,
  device_id: Option<String>,
  date: String,
) -> Result<LonglifeRestoreResult, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Err(format!(
      "{} Elegí una carpeta bóveda para empezar.",
      vault::VAULT_NOT_CONFIGURED
    ));
  };
  let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());

  let installation = writer::installation_device_id(app.clone())?;
  let current_device_id = safe_device_folder(&installation);
  let current_device_name =
    writer::installation_name(&app).unwrap_or_else(writer::default_device_name);
  let journal_dir = journal::dir_for_app(&app, &config.data_root)?;

  restore_snapshot(
    &config.data_root,
    &config.vault_root,
    device_id.as_deref(),
    &date,
    &current_device_id,
    &current_device_name,
    &journal_dir,
  )
}

/// Núcleo del snapshot, separado del `AppHandle` para poder probarlo.
///
/// Asume que el llamador ya tomó `SNAPSHOT_LOCK` y que esta función toma
/// `EVENTS_WRITE_LOCK` durante la copia.
fn run_snapshot(
  data_root: &str,
  vault_root: &str,
  device_id: &str,
  device_name: &str,
  date: &str,
  kind: SnapshotKind,
  force: bool,
) -> Result<LonglifeResult, String> {
  let _guard = event_store::EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  snapshot_copy_locked(
    data_root,
    vault_root,
    device_id,
    device_name,
    date,
    kind,
    force,
    None,
  )
}

/// Igual que `run_snapshot`, pero el llamador ya tomó `EVENTS_WRITE_LOCK`.
///
/// `protect` evita podar una copia que se está restaurando mientras se la lee.
fn snapshot_copy_locked(
  data_root: &str,
  vault_root: &str,
  device_id: &str,
  device_name: &str,
  date: &str,
  kind: SnapshotKind,
  force: bool,
  protect: Option<&str>,
) -> Result<LonglifeResult, String> {
  let day_dir = snapshot_relative(Some(device_id), date);

  // En SAF `list_dir` falla si la carpeta no existe; crearla es idempotente.
  storage::create_dir_all(vault_root, LONGLIFE_DIR)?;
  storage::create_dir_all(vault_root, &device_dir(device_id))?;

  if !force {
    if let Some(existing) = read_manifest(vault_root, &day_dir) {
      return Ok(LonglifeResult {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        kind: kind.as_str().to_string(),
        date: date.to_string(),
        path: day_dir,
        files: existing.files.len(),
        total_bytes: existing.total_bytes,
        reused: true,
        protected: false,
      });
    }
  } else {
    storage::remove_dir_all(vault_root, &day_dir)?;
  }

  storage::create_dir_all(vault_root, &day_dir)?;

  // Copia completa de omega, salvo los respaldos previos a una migración
  // (pueden ser grandes y no forman parte del estado vivo).
  let mut manifest_files: Vec<LonglifeFile> = Vec::new();
  let mut total_bytes = 0u64;

  for relative in source_snapshot_files(data_root)? {
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

  let manifest = build_manifest(
    date,
    Some(device_id),
    Some(device_name),
    kind,
    manifest_files,
    total_bytes,
  );
  let json = serde_json::to_string_pretty(&manifest)
    .map_err(|e| format!("No se pudo serializar el manifiesto: {e}"))?;
  storage::write_atomic(
    vault_root,
    &manifest_relative(&day_dir),
    json.as_bytes(),
  )?;

  let mut protected = vec![date];
  if let Some(source) = protect {
    if source != date {
      protected.push(source);
    }
  }
  prune_old(vault_root, device_id, &protected)?;

  Ok(LonglifeResult {
    device_id: device_id.to_string(),
    device_name: device_name.to_string(),
    kind: kind.as_str().to_string(),
    date: date.to_string(),
    path: day_dir,
    files: manifest.files.len(),
    total_bytes: manifest.total_bytes,
    reused: false,
    protected: false,
  })
}

/// `true` si `omega/events` tiene al menos un archivo `.jsonl`.
///
/// Se usa como protección barata: si el usuario vació los datos y todavía no
/// volvió a escribir, el refresco automático no debe reemplazar el snapshot
/// del día (que sí tiene datos) por uno vacío.
fn has_event_files(data_root: &str) -> Result<bool, String> {
  let names = storage::list_dir(data_root, "events").unwrap_or_default();
  Ok(names.iter().any(|name| name.ends_with(".jsonl")))
}

fn run_snapshot_refresh(
  data_root: &str,
  vault_root: &str,
  device_id: &str,
  device_name: &str,
  date: &str,
) -> Result<LonglifeResult, String> {
  let _guard = event_store::EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  snapshot_refresh_locked(data_root, vault_root, device_id, device_name, date)
}

/// Actualiza la copia de hoy sin borrarla antes.
///
/// Compara el hash de cada archivo de `omega` con el manifiesto existente y
/// solo reescribe los que cambiaron. También elimina del snapshot los archivos
/// que ya no existen en `omega`. Si no hay cambios, devuelve `reused: true`.
fn snapshot_refresh_locked(
  data_root: &str,
  vault_root: &str,
  device_id: &str,
  device_name: &str,
  date: &str,
) -> Result<LonglifeResult, String> {
  let day_dir = snapshot_relative(Some(device_id), date);

  // En SAF `list_dir` falla si la carpeta no existe; crearla es idempotente.
  storage::create_dir_all(vault_root, LONGLIFE_DIR)?;
  storage::create_dir_all(vault_root, &device_dir(device_id))?;

  let existing = read_manifest(vault_root, &day_dir);
  let existing_hashes: BTreeMap<String, (u64, String)> = existing
    .as_ref()
    .map(|manifest| {
      manifest
        .files
        .iter()
        .map(|file| (file.name.clone(), (file.bytes, file.sha256.clone())))
        .collect()
    })
    .unwrap_or_default();

  // No reemplazar una copia con datos por un omega vacío (por ejemplo, justo
  // después de "Vaciar todos los datos"). `force` sigue permitiendo regenerar
  // desde cero de forma explícita.
  if let Some(manifest) = &existing {
    if !manifest.files.is_empty() && !has_event_files(data_root)? {
      return Ok(LonglifeResult {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        kind: SnapshotKind::Daily.as_str().to_string(),
        date: date.to_string(),
        path: day_dir,
        files: manifest.files.len(),
        total_bytes: manifest.total_bytes,
        reused: true,
        protected: true,
      });
    }
  }

  let mut manifest_files: Vec<LonglifeFile> = Vec::new();
  let mut current_files: BTreeSet<String> = BTreeSet::new();
  let mut total_bytes = 0u64;
  let mut changed = existing.is_none();

  storage::create_dir_all(vault_root, &day_dir)?;

  // Un solo listado del snapshot alcanza para saber qué archivos existen y
  // cuáles sobran; en SAF esto evita un escaneo por cada archivo.
  let mut stored_files: BTreeMap<String, String> = BTreeMap::new();
  if existing.is_some() {
    let prefix = format!("{day_dir}/");
    for stored in storage::list_files_recursive(vault_root, &day_dir)? {
      if let Some(name) = stored.strip_prefix(&prefix) {
        stored_files.insert(name.to_string(), stored);
      }
    }
  }

  for relative in source_snapshot_files(data_root)? {
    let Some(bytes) = storage::read_bytes(data_root, &relative)? else {
      continue;
    };
    let hash = sha256(&bytes);
    let bytes_len = bytes.len() as u64;
    let destination = format!("{day_dir}/{relative}");
    let unchanged = existing_hashes
      .get(&relative)
      .map(|(old_bytes, old_hash)| *old_bytes == bytes_len && old_hash == &hash)
      .unwrap_or(false)
      // Si alguien borró un archivo del snapshot, el manifiesto puede seguir
      // diciendo que estaba al día; en ese caso hay que volver a copiarlo.
      && stored_files.contains_key(&relative);

    if !unchanged {
      storage::write_bytes(vault_root, &destination, &bytes)?;
      changed = true;
    }

    current_files.insert(relative.clone());
    total_bytes += bytes_len;
    manifest_files.push(LonglifeFile {
      name: relative,
      bytes: bytes_len,
      sha256: hash,
    });
  }

  // Si el snapshot anterior tenía archivos que ya no están en omega, se
  // quitan para que la copia siga siendo idéntica al estado vivo.
  for (name, stored) in stored_files {
    if name == MANIFEST_FILE || current_files.contains(&name) {
      continue;
    }
    storage::remove_file(vault_root, &stored)?;
    changed = true;
  }

  if !changed {
    if let Some(existing) = existing {
      return Ok(LonglifeResult {
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        kind: SnapshotKind::Daily.as_str().to_string(),
        date: date.to_string(),
        path: day_dir,
        files: existing.files.len(),
        total_bytes: existing.total_bytes,
        reused: true,
        protected: false,
      });
    }
  }

  let manifest = build_manifest(
    date,
    Some(device_id),
    Some(device_name),
    SnapshotKind::Daily,
    manifest_files,
    total_bytes,
  );
  let json = serde_json::to_string_pretty(&manifest)
    .map_err(|e| format!("No se pudo serializar el manifiesto: {e}"))?;
  storage::write_atomic(
    vault_root,
    &manifest_relative(&day_dir),
    json.as_bytes(),
  )?;

  prune_old(vault_root, device_id, &[date])?;

  Ok(LonglifeResult {
    device_id: device_id.to_string(),
    device_name: device_name.to_string(),
    kind: SnapshotKind::Daily.as_str().to_string(),
    date: date.to_string(),
    path: day_dir,
    files: manifest.files.len(),
    total_bytes: manifest.total_bytes,
    reused: false,
    protected: false,
  })
}

/// Valida el manifiesto y todos los archivos de una copia antes de tocarla.
fn validate_snapshot(vault_root: &str, relative: &str) -> Result<LonglifeManifest, String> {
  let manifest = read_manifest(vault_root, relative).ok_or_else(|| {
    format!("La copia '{relative}' no tiene un manifiesto válido.")
  })?;

  let mut names = BTreeSet::new();
  let mut total = 0u64;
  for file in &manifest.files {
    if !is_safe_relative(&file.name) || !is_snapshot_file(&file.name) {
      return Err(format!(
        "La copia contiene una ruta no permitida: '{}'.",
        file.name
      ));
    }
    if !names.insert(file.name.clone()) {
      return Err(format!("La copia repite el archivo '{}'.", file.name));
    }
    total = total.saturating_add(file.bytes);
  }
  if total != manifest.total_bytes {
    return Err("El manifiesto de la copia tiene un tamaño total inconsistente.".to_string());
  }

  let mut sorted = manifest.files.clone();
  sorted.sort_by(|a, b| a.name.cmp(&b.name));
  let mut hasher = Sha256::new();
  for file in &sorted {
    hasher.update(file.sha256.as_bytes());
  }
  let expected = format!("{:x}", hasher.finalize());
  if expected != manifest.sha256_total {
    return Err("El manifiesto de la copia está alterado (hash total distinto).".to_string());
  }

  for file in &manifest.files {
    let path = format!("{relative}/{}", file.name);
    let bytes = storage::read_bytes(vault_root, &path)?
      .ok_or_else(|| format!("Falta '{}' en la copia.", file.name))?;
    if bytes.len() as u64 != file.bytes || sha256(&bytes) != file.sha256 {
      return Err(format!(
        "El archivo '{}' de la copia está incompleto o alterado.",
        file.name
      ));
    }
  }

  Ok(manifest)
}

/// Reemplaza el contenido de `omega` por el de la copia validada.
///
/// Conserva `backups/` y los marcadores `.keep-*`: no forman parte del estado
/// vivo y pueden contener respaldos de recuperación. El resto se reemplaza.
fn apply_snapshot(
  data_root: &str,
  vault_root: &str,
  source_relative: &str,
  manifest: &LonglifeManifest,
) -> Result<(usize, u64), String> {
  storage::refresh_index(data_root)?;
  let snapshot_files: BTreeSet<String> = manifest
    .files
    .iter()
    .map(|file| file.name.clone())
    .collect();

  for relative in storage::list_files_recursive(data_root, "")? {
    let file_name = relative.rsplit('/').next().unwrap_or(&relative);
    if relative.starts_with("backups/") || file_name.starts_with(".keep-") {
      continue;
    }
    if relative == "writer.json" || !snapshot_files.contains(&relative) {
      storage::remove_file(data_root, &relative)?;
    }
  }

  let mut total = 0u64;
  for file in &manifest.files {
    let path = format!("{source_relative}/{}", file.name);
    let bytes = storage::read_bytes(vault_root, &path)?
      .ok_or_else(|| format!("Falta '{}' en la copia.", file.name))?;
    if bytes.len() as u64 != file.bytes || sha256(&bytes) != file.sha256 {
      return Err(format!(
        "La copia cambió mientras se restauraba ('{}').",
        file.name
      ));
    }
    storage::write_atomic(data_root, &file.name, &bytes)?;
    total += bytes.len() as u64;
  }
  storage::refresh_index(data_root)?;
  Ok((manifest.files.len(), total))
}

/// Restaura una copia concreta.
///
/// Orden:
/// 1. Valida el manifiesto y todos los hashes (sin tocar `omega`).
/// 2. Repara el diario para que la copia previa capture lo recuperable.
/// 3. Toma una copia `pre-restore-*` del estado actual.
/// 4. Limpia el diario (bajo `EVENTS_WRITE_LOCK`).
/// 5. Reemplaza el contenido de `omega`.
/// 6. Borra la clave en memoria: la app debe volver a desbloquear.
fn restore_snapshot(
  data_root: &str,
  vault_root: &str,
  device_id: Option<&str>,
  date: &str,
  current_device_id: &str,
  current_device_name: &str,
  journal_dir: &Path,
) -> Result<LonglifeRestoreResult, String> {
  if !is_snapshot_name(date) {
    return Err("La fecha de la copia no es válida.".to_string());
  }
  if let Some(id) = device_id {
    if !is_safe_device_folder(id) {
      return Err("El identificador del dispositivo no es válido.".to_string());
    }
  }

  // En SAF el índice puede tener URIs viejas si el agente acaba de sincronizar
  // la copia; refrescarlo antes de validar evita fallos por documentos nuevos.
  storage::refresh_index(vault_root)?;
  let source_relative = snapshot_relative(device_id, date);
  let manifest = validate_snapshot(vault_root, &source_relative)?;
  let encrypted = manifest
    .files
    .iter()
    .any(|file| file.name == "keys/keyring.json");

  let _guard = event_store::EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  // La reparación y la copia previa van bajo el mismo lock: ningún append
  // local puede colarse entre ambas y perderse al limpiar el diario.
  let repair = if crypto::is_enabled(data_root) {
    if crypto::current_key(data_root).is_none() {
      return Err(
        "Desbloqueá la bóveda antes de restaurar una copia.".to_string(),
      );
    }
    Some(journal::repair_locked(data_root, journal_dir)?)
  } else {
    None
  };

  // Elegir un nombre que no exista ni coincida con la copia que estamos
  // restaurando: `force` borraría esa carpeta antes de leerla.
  let base_name = pre_restore_name();
  let mut pre_name = base_name.clone();
  let mut suffix = 0;
  while pre_name == date
    || storage::exists(
      vault_root,
      &snapshot_relative(Some(current_device_id), &pre_name),
    )
    .unwrap_or(false)
  {
    suffix += 1;
    pre_name = format!("{base_name}-{suffix}");
  }
  let pre = snapshot_copy_locked(
    data_root,
    vault_root,
    current_device_id,
    current_device_name,
    &pre_name,
    SnapshotKind::PreRestore,
    true,
    Some(date),
  )?;

  // La copia previa ya capturó el estado actual (incluido lo que reparó el
  // diario). Limpiar el diario evita que el próximo arranque vuelva a agregar
  // eventos posteriores a la copia restaurada.
  journal::clear(journal_dir)?;

  let (files, total_bytes) =
    apply_snapshot(data_root, vault_root, &source_relative, &manifest)?;
  storage::refresh_index(data_root)?;

  // Recién ahora la copia restaurada ya se leyó; se puede aplicar el límite
  // de copias previas sin riesgo de borrar la fuente. La copia previa recién
  // creada queda protegida aunque el reloj del equipo esté atrasado. Un fallo
  // de limpieza no invalida una restauración ya aplicada.
  if let Err(err) = prune_old(vault_root, current_device_id, &[pre_name.as_str()]) {
    eprintln!("No se pudieron podar copias previas: {err}");
  }

  // La clave en memoria ya no corresponde al llavero restaurado.
  crypto::clear_current_for(data_root);

  Ok(LonglifeRestoreResult {
    restored_from: source_relative,
    pre_restore: pre.path,
    files,
    total_bytes,
    encrypted,
    requires_unlock: crypto::is_enabled(data_root),
    journal_repaired: repair.as_ref().map(|report| report.repaired).unwrap_or(0),
    journal_pending: repair.as_ref().map(|report| report.pending).unwrap_or(0),
    journal_stale: repair.as_ref().map(|report| report.stale).unwrap_or(0),
  })
}

/// Lista los archivos de una copia sin leer todos sus bytes.
///
/// Sirve para revisar qué contiene un snapshot antes de restaurarlo.
#[tauri::command]
pub fn longlife_files(
  app: AppHandle,
  device_id: Option<String>,
  date: String,
) -> Result<LonglifeFolder, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Err("Elegí una carpeta bóveda para ver las copias.".to_string());
  };
  let relative = snapshot_relative_checked(device_id.as_deref(), &date)?;
  let manifest = read_manifest(&config.vault_root, &relative)
    .ok_or_else(|| format!("La copia '{relative}' no tiene un manifiesto válido."))?;

  let mut files = Vec::with_capacity(manifest.files.len());
  for file in manifest.files {
    if !is_safe_relative(&file.name) {
      return Err(format!(
        "La copia contiene una ruta no permitida: '{}'.",
        file.name
      ));
    }
    files.push(file);
  }
  files.sort_by(|a, b| a.name.cmp(&b.name));

  Ok(LonglifeFolder {
    absolute_path: absolute_snapshot_path(&config.vault_root, &relative),
    relative_path: relative,
    created_at: Some(manifest.created_at),
    kind: manifest.kind,
    device_id: manifest.device_id.or(device_id),
    device_name: manifest.device_name,
    files,
    total_bytes: manifest.total_bytes,
  })
}

/// Abre en el explorador del sistema la carpeta de una copia o de un
/// dispositivo. En Android no existe un explorador para la bóveda SAF.
#[tauri::command]
pub fn longlife_open_folder(
  app: AppHandle,
  device_id: Option<String>,
  date: Option<String>,
) -> Result<String, String> {
  let Some(config) = vault::load_config(&app)? else {
    return Err("Elegí una carpeta bóveda para abrir las copias.".to_string());
  };

  let relative = match date.as_deref() {
    Some(date) => snapshot_relative_checked(device_id.as_deref(), date)?,
    None => match device_id.as_deref() {
      Some(id) => {
        if !is_safe_device_folder(id) {
          return Err("El identificador del dispositivo no es válido.".to_string());
        }
        device_dir(id)
      }
      None => LONGLIFE_DIR.to_string(),
    },
  };

  #[cfg(target_os = "android")]
  {
    let _ = (&config, &relative);
    Err("Abrir la carpeta solo está disponible en la versión de escritorio.".to_string())
  }

  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_opener::OpenerExt;
    let path = Path::new(&config.vault_root).join(&relative);
    if !path.is_dir() {
      return Err(format!("La carpeta '{}' todavía no existe.", path.display()));
    }
    let path_str = path.to_string_lossy().to_string();
    app
      .opener()
      .open_path(path_str.clone(), None::<&str>)
      .map_err(|e| format!("No se pudo abrir la carpeta: {e}"))?;
    Ok(path_str)
  }
}

#[cfg(not(target_os = "android"))]
fn absolute_snapshot_path(vault_root: &str, relative: &str) -> Option<String> {
  Some(
    Path::new(vault_root)
      .join(relative)
      .to_string_lossy()
      .to_string(),
  )
}

#[cfg(target_os = "android")]
fn absolute_snapshot_path(_vault_root: &str, _relative: &str) -> Option<String> {
  None
}

/// Borra **todas** las copias longlife de **todos** los dispositivos.
/// No toca `omega`.
#[tauri::command]
pub fn longlife_delete(app: AppHandle) -> Result<(), String> {
  let Some(config) = vault::load_config(&app)? else {
    return Ok(());
  };
  let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  storage::remove_dir_all(&config.vault_root, LONGLIFE_DIR)?;
  storage::create_dir_all(&config.vault_root, LONGLIFE_DIR)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::keys;
  use std::path::PathBuf;

  fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir().join(format!("inventario-longlife-{tag}-{nanos}"))
  }

  fn write_legacy_snapshot(
    vault: &str,
    date: &str,
    files: &[(&str, &[u8])],
  ) {
    let relative = snapshot_relative(None, date);
    let mut manifest_files = Vec::new();
    let mut total = 0u64;
    for (name, bytes) in files {
      storage::write_bytes(vault, &format!("{relative}/{name}"), bytes).unwrap();
      manifest_files.push(LonglifeFile {
        name: name.to_string(),
        bytes: bytes.len() as u64,
        sha256: sha256(bytes),
      });
      total += bytes.len() as u64;
    }
    let manifest = build_manifest(
      date,
      None,
      None,
      SnapshotKind::Legacy,
      manifest_files,
      total,
    );
    let json = serde_json::to_string(&manifest).unwrap();
    storage::write_atomic(vault, &manifest_relative(&relative), json.as_bytes())
      .unwrap();
  }

  #[test]
  fn detects_date_directories() {
    assert!(is_date_dir("2026-10-28"));
    assert!(!is_date_dir("2026-1-28"));
    assert!(!is_date_dir("manifest.json"));
    assert!(!is_date_dir("2026-10-28-copia"));
    assert!(is_pre_restore_dir("pre-restore-20261028-203000-123"));
    assert!(!is_pre_restore_dir("pre-restore-"));
  }

  #[test]
  fn snapshot_relative_checked_rejects_traversal() {
    assert_eq!(
      snapshot_relative_checked(Some("device-1"), "2026-10-28").unwrap(),
      "longlife/device-1/2026-10-28"
    );
    assert_eq!(
      snapshot_relative_checked(None, "2026-10-28").unwrap(),
      "longlife/2026-10-28"
    );
    assert!(snapshot_relative_checked(None, "../omega").is_err());
    assert!(snapshot_relative_checked(Some("../omega"), "2026-10-28").is_err());
    assert!(snapshot_relative_checked(Some("device-1"), "manifest.json").is_err());
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
  fn snapshot_copies_omega_and_prunes_to_seven_days_per_device() {
    let base = temp_dir("snapshot");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"uno\n").unwrap();
    storage::write_bytes(&omega_s, "keys/keyring.json", b"{}").unwrap();
    storage::write_bytes(&omega_s, "events/.keep-123", b"").unwrap();
    storage::write_bytes(
      &omega_s,
      "backups/pre-encryption/events/orders.jsonl",
      b"viejo\n",
    )
    .unwrap();

    for day in 1..=7 {
      storage::create_dir_all(
        &vault_s,
        &format!("longlife/dev-a/2026-10-{day:02}"),
      )
      .unwrap();
    }

    let result = run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-08",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();
    assert!(!result.reused);
    assert_eq!(result.files, 2, "no debe copiar backups/");
    assert_eq!(result.path, "longlife/dev-a/2026-10-08");
    assert!(storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-08/events/orders.jsonl"
    )
    .unwrap());
    assert!(storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-08/keys/keyring.json"
    )
    .unwrap());
    assert!(storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-08/manifest.json"
    )
    .unwrap());
    assert!(!storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-08/backups/pre-encryption/events/orders.jsonl"
    )
    .unwrap());
    assert!(!storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-08/events/.keep-123"
    )
    .unwrap());

    // 8 fechas → se conservan las 7 más nuevas (02..08) de este dispositivo.
    let dates: Vec<String> = list_device_snapshots(&vault_s, "dev-a")
      .unwrap()
      .into_iter()
      .filter(|(_, kind)| *kind == SnapshotKind::Daily)
      .map(|(name, _)| name)
      .collect();
    assert_eq!(
      dates,
      (2..=8)
        .map(|day| format!("2026-10-{day:02}"))
        .collect::<Vec<_>>()
    );

    let reused = run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-08",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();
    assert!(reused.reused);
    let forced = run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-08",
      SnapshotKind::Daily,
      true,
    )
    .unwrap();
    assert!(!forced.reused);

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn snapshots_of_two_devices_do_not_overwrite_each_other() {
    let base = temp_dir("two-devices");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"de-a\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"de-b\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-b",
      "Equipo B",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();

    assert_eq!(
      storage::read_string(&vault_s, "longlife/dev-a/2026-10-28/events/orders.jsonl")
        .unwrap()
        .unwrap(),
      "de-a\n"
    );
    assert_eq!(
      storage::read_string(&vault_s, "longlife/dev-b/2026-10-28/events/orders.jsonl")
        .unwrap()
        .unwrap(),
      "de-b\n"
    );

    let dirs = list_snapshot_dirs(&vault_s).unwrap();
    assert_eq!(dirs.len(), 2);
    assert!(dirs
      .iter()
      .any(|dir| dir.device_id.as_deref() == Some("dev-a")));
    assert!(dirs
      .iter()
      .any(|dir| dir.device_id.as_deref() == Some("dev-b")));

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn lists_legacy_and_per_device_snapshots() {
    let base = temp_dir("list-layouts");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"uno\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();
    write_legacy_snapshot(
      &vault_s,
      "2026-10-01",
      &[("events/orders.jsonl", b"viejo\n")],
    );

    let dirs = list_snapshot_dirs(&vault_s).unwrap();
    assert_eq!(dirs.len(), 2);
    let legacy = dirs
      .iter()
      .find(|dir| dir.device_id.is_none())
      .expect("copia legacy");
    assert_eq!(legacy.kind, SnapshotKind::Legacy);
    let current = dirs
      .iter()
      .find(|dir| dir.device_id.as_deref() == Some("dev-a"))
      .expect("copia por dispositivo");
    assert_eq!(current.kind, SnapshotKind::Daily);

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn refresh_does_not_replace_a_non_empty_snapshot_with_empty_data() {
    let base = temp_dir("protect-empty");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"uno\n").unwrap();
    storage::write_bytes(&omega_s, "device_id", b"dev\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();

    // Simula "Vaciar todos los datos": store_clear borra los .jsonl.
    storage::remove_file(&omega_s, "events/orders.jsonl").unwrap();

    let result = run_snapshot_refresh(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
    )
    .unwrap();
    assert!(result.reused);
    assert!(result.protected);
    assert_eq!(result.files, 2);
    assert_eq!(
      storage::read_string(
        &vault_s,
        "longlife/dev-a/2026-10-28/events/orders.jsonl"
      )
      .unwrap()
      .unwrap(),
      "uno\n",
      "la copia previa al vaciado debe conservarse"
    );

    // Un `force` explícito sí puede regenerar la copia vacía.
    let forced = run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      true,
    )
    .unwrap();
    assert!(!forced.protected);
    assert_eq!(forced.files, 1);

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn refresh_updates_today_and_removes_stale_files() {
    let base = temp_dir("refresh");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"uno\n").unwrap();
    let first = run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();
    assert!(!first.reused);
    assert_eq!(first.files, 1);

    // Sin cambios, el refresco no reescribe ni actualiza el manifiesto.
    let created_at = read_manifest(&vault_s, "longlife/dev-a/2026-10-28")
      .unwrap()
      .created_at;
    let reused = run_snapshot_refresh(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
    )
    .unwrap();
    assert!(reused.reused);
    assert_eq!(reused.files, 1);
    assert_eq!(
      read_manifest(&vault_s, "longlife/dev-a/2026-10-28")
        .unwrap()
        .created_at,
      created_at
    );

    // Si falta un archivo dentro del snapshot, el refresco lo vuelve a copiar.
    storage::remove_file(
      &vault_s,
      "longlife/dev-a/2026-10-28/events/orders.jsonl",
    )
    .unwrap();
    let restored = run_snapshot_refresh(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
    )
    .unwrap();
    assert!(!restored.reused);
    assert!(storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-28/events/orders.jsonl"
    )
    .unwrap());

    // Un cambio en omega se refleja en el snapshot del mismo día.
    storage::append_bytes(&omega_s, "events/orders.jsonl", b"dos\n").unwrap();
    storage::write_bytes(&omega_s, "events/customers.jsonl", b"cliente\n").unwrap();
    let refreshed = run_snapshot_refresh(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
    )
    .unwrap();
    assert!(!refreshed.reused);
    assert_eq!(refreshed.files, 2);
    assert_eq!(
      storage::read_string(
        &vault_s,
        "longlife/dev-a/2026-10-28/events/orders.jsonl"
      )
      .unwrap()
      .unwrap(),
      "uno\ndos\n"
    );
    assert_eq!(
      read_manifest(&vault_s, "longlife/dev-a/2026-10-28")
        .unwrap()
        .files
        .len(),
      2
    );

    // Un archivo borrado en omega también desaparece del snapshot.
    storage::remove_file(&omega_s, "events/customers.jsonl").unwrap();
    let cleaned = run_snapshot_refresh(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
    )
    .unwrap();
    assert!(!cleaned.reused);
    assert_eq!(cleaned.files, 1);
    assert!(!storage::exists(
      &vault_s,
      "longlife/dev-a/2026-10-28/events/customers.jsonl"
    )
    .unwrap());

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn restore_replaces_omega_and_keeps_a_pre_restore_snapshot() {
    let base = temp_dir("restore");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let journal_dir = base.join("journal");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    // Llavero válido y desbloqueado: la restauración repara el diario antes de
    // tomar la copia previa.
    let created = keys::create(
      "clave-de-prueba",
      keys::KdfParams::fast().unwrap(),
    )
    .unwrap();
    keys::save(&omega_s, &created.keyring).unwrap();
    crypto::set_current(&omega_s, created.key, created.keyring.kid.clone());

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"A\n").unwrap();
    storage::write_bytes(&omega_s, "settings.json", b"settings-A\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();

    // Estado posterior: evento B, un archivo extra y un writer.json viejo.
    storage::write_bytes(&omega_s, "events/orders.jsonl", b"B\n").unwrap();
    storage::write_bytes(&omega_s, "events/extra.jsonl", b"EXTRA\n").unwrap();
    storage::write_bytes(&omega_s, "settings.json", b"settings-B\n").unwrap();
    storage::write_bytes(&omega_s, "writer.json", b"{}").unwrap();
    std::fs::create_dir_all(&journal_dir).unwrap();
    std::fs::write(journal_dir.join("orders.jsonl"), b"pendiente\n").unwrap();

    let result = restore_snapshot(
      &omega_s,
      &vault_s,
      Some("dev-a"),
      "2026-10-28",
      "dev-b",
      "Equipo B",
      &journal_dir,
    )
    .unwrap();

    assert_eq!(result.restored_from, "longlife/dev-a/2026-10-28");
    assert!(result
      .pre_restore
      .starts_with("longlife/dev-b/pre-restore-"));
    assert!(result.encrypted);
    assert!(result.requires_unlock);
    assert_eq!(
      storage::read_string(&omega_s, "events/orders.jsonl")
        .unwrap()
        .unwrap(),
      "A\n"
    );
    assert_eq!(
      storage::read_string(&omega_s, "settings.json")
        .unwrap()
        .unwrap(),
      "settings-A\n"
    );
    assert!(!storage::exists(&omega_s, "events/extra.jsonl").unwrap());
    assert!(!storage::exists(&omega_s, "writer.json").unwrap());
    assert!(crypto::current_key(&omega_s).is_none());
    assert!(!journal_dir.exists());

    // La copia previa conserva el estado que se reemplazó.
    assert_eq!(
      storage::read_string(
        &vault_s,
        &format!("{}/events/orders.jsonl", result.pre_restore)
      )
      .unwrap()
      .unwrap(),
      "B\n"
    );
    assert_eq!(
      storage::read_string(
        &vault_s,
        &format!("{}/events/extra.jsonl", result.pre_restore)
      )
      .unwrap()
      .unwrap(),
      "EXTRA\n"
    );

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn restore_legacy_snapshot_works_without_device() {
    let base = temp_dir("restore-legacy");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let journal_dir = base.join("journal");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"actual\n").unwrap();
    write_legacy_snapshot(
      &vault_s,
      "2026-10-01",
      &[("events/orders.jsonl", b"viejo\n")],
    );

    let result = restore_snapshot(
      &omega_s,
      &vault_s,
      None,
      "2026-10-01",
      "dev-b",
      "Equipo B",
      &journal_dir,
    )
    .unwrap();

    assert_eq!(result.restored_from, "longlife/2026-10-01");
    assert_eq!(
      storage::read_string(&omega_s, "events/orders.jsonl")
        .unwrap()
        .unwrap(),
      "viejo\n"
    );
    assert_eq!(
      storage::read_string(
        &vault_s,
        &format!("{}/events/orders.jsonl", result.pre_restore)
      )
      .unwrap()
      .unwrap(),
      "actual\n"
    );

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn restore_rejects_a_corrupted_snapshot() {
    let base = temp_dir("restore-corrupt");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let journal_dir = base.join("journal");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"actual\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "2026-10-28",
      SnapshotKind::Daily,
      false,
    )
    .unwrap();
    storage::write_bytes(
      &vault_s,
      "longlife/dev-a/2026-10-28/events/orders.jsonl",
      b"alterado\n",
    )
    .unwrap();

    let err = restore_snapshot(
      &omega_s,
      &vault_s,
      Some("dev-a"),
      "2026-10-28",
      "dev-b",
      "Equipo B",
      &journal_dir,
    )
    .unwrap_err();
    assert!(err.contains("incompleto o alterado"), "mensaje: {err}");
    assert_eq!(
      storage::read_string(&omega_s, "events/orders.jsonl")
        .unwrap()
        .unwrap(),
      "actual\n"
    );

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn restore_rejects_path_traversal_and_missing_manifests() {
    let base = temp_dir("restore-invalid");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let journal_dir = base.join("journal");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    let err = restore_snapshot(
      &omega_s,
      &vault_s,
      Some("../evil"),
      "2026-10-28",
      "dev-b",
      "Equipo B",
      &journal_dir,
    )
    .unwrap_err();
    assert!(err.contains("identificador"), "mensaje: {err}");

    let err = restore_snapshot(
      &omega_s,
      &vault_s,
      Some("dev-a"),
      "../../evil",
      "dev-b",
      "Equipo B",
      &journal_dir,
    )
    .unwrap_err();
    assert!(err.contains("fecha"), "mensaje: {err}");

    let err = restore_snapshot(
      &omega_s,
      &vault_s,
      Some("dev-a"),
      "2026-10-28",
      "dev-b",
      "Equipo B",
      &journal_dir,
    )
    .unwrap_err();
    assert!(err.contains("manifiesto"), "mensaje: {err}");

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn restoring_an_old_pre_restore_copy_does_not_prune_it_before_reading() {
    let base = temp_dir("restore-old-pre");
    let omega = base.join("omega");
    let vault = base.join("vault");
    let journal_dir = base.join("journal");
    let omega_s = omega.to_string_lossy().to_string();
    let vault_s = vault.to_string_lossy().to_string();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"viejo\n").unwrap();
    run_snapshot(
      &omega_s,
      &vault_s,
      "dev-a",
      "Equipo A",
      "pre-restore-20261028-100000-001",
      SnapshotKind::PreRestore,
      true,
    )
    .unwrap();

    storage::write_bytes(&omega_s, "events/orders.jsonl", b"actual\n").unwrap();
    for name in [
      "pre-restore-20261028-110000-001",
      "pre-restore-20261028-120000-001",
    ] {
      run_snapshot(
        &omega_s,
        &vault_s,
        "dev-a",
        "Equipo A",
        name,
        SnapshotKind::PreRestore,
        true,
      )
      .unwrap();
    }

    // Envejecer los manifiestos: así la ventana de gracia de 10 minutos no
    // protege a la fuente y la prueba depende de `protect`.
    for name in [
      "pre-restore-20261028-100000-001",
      "pre-restore-20261028-110000-001",
      "pre-restore-20261028-120000-001",
    ] {
      let relative = format!("longlife/dev-a/{name}/manifest.json");
      let text = storage::read_string(&vault_s, &relative).unwrap().unwrap();
      let mut manifest: LonglifeManifest = serde_json::from_str(&text).unwrap();
      manifest.created_at = "2020-01-01T00:00:00Z".to_string();
      storage::write_bytes(
        &vault_s,
        &relative,
        serde_json::to_string(&manifest).unwrap().as_bytes(),
      )
      .unwrap();
    }

    // Hay 3 copias previas. Restaurar la más vieja crea una cuarta; el prune
    // no debe borrar la fuente antes de que `apply_snapshot` la lea.
    let result = restore_snapshot(
      &omega_s,
      &vault_s,
      Some("dev-a"),
      "pre-restore-20261028-100000-001",
      "dev-a",
      "Equipo A",
      &journal_dir,
    )
    .unwrap();

    assert_eq!(
      result.restored_from,
      "longlife/dev-a/pre-restore-20261028-100000-001"
    );
    assert_eq!(
      storage::read_string(&omega_s, "events/orders.jsonl")
        .unwrap()
        .unwrap(),
      "viejo\n"
    );

    let _ = std::fs::remove_dir_all(&base);
  }

  #[test]
  fn prunes_old_pre_restore_snapshots_per_device() {
    let base = temp_dir("prune-pre");
    let vault = base.join("vault");
    let vault_s = vault.to_string_lossy().to_string();

    for suffix in ["20261028-100000-001", "20261028-110000-001", "20261028-120000-001", "20261028-130000-001"] {
      storage::create_dir_all(
        &vault_s,
        &format!("longlife/dev-a/pre-restore-{suffix}"),
      )
      .unwrap();
    }

    prune_old(&vault_s, "dev-a", &[]).unwrap();
    let names = storage::list_dir(&vault_s, "longlife/dev-a").unwrap();
    assert_eq!(
      names,
      vec![
        "pre-restore-20261028-110000-001",
        "pre-restore-20261028-120000-001",
        "pre-restore-20261028-130000-001",
      ]
    );

    let _ = std::fs::remove_dir_all(&base);
  }
}
