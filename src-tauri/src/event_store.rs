use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const EVENTS_SUBDIR: &str = "events";
const DEVICE_ID_FILE: &str = "device_id";

/// Dominios válidos. Evita que un `domain` con `../` escape de `events/`.
pub(crate) const ALLOWED_DOMAINS: &[&str] = &[
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

fn validate_domain(domain: &str) -> Result<(), String> {
  if ALLOWED_DOMAINS.contains(&domain) {
    Ok(())
  } else {
    Err(format!("Dominio de eventos no válido: {domain}"))
  }
}

fn validate_event_line(line: &str) -> Result<(), String> {
  if line.contains('\n') || line.contains('\r') {
    return Err("La línea de evento no puede contener saltos de línea.".to_string());
  }
  serde_json::from_str::<Value>(line)
    .map(|_| ())
    .map_err(|e| format!("La línea de evento no es un JSON válido: {e}"))
}

/**
 * Serializa las escrituras de eventos dentro del proceso.
 *
 * El frontend y el motor de sincronización pueden hacer append casi al mismo
 * tiempo. Sin este lock, dos `writeln!` podrían intercalar bytes y corromper
 * una línea JSONL.
 */
pub(crate) static EVENTS_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Serialize, Deserialize)]
pub struct AppendArgs {
  pub root: String,
  pub domain: String,
  pub lines: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReadArgs {
  pub root: String,
  pub domain: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MtimesArgs {
  pub root: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeviceIdArgs {
  pub root: String,
}

/* ------------------------------------------------------------------ */
/* Rutas                                                              */
/* ------------------------------------------------------------------ */

pub(crate) fn events_dir(root: &str) -> PathBuf {
  Path::new(root).join(EVENTS_SUBDIR)
}

pub(crate) fn domain_path(root: &str, domain: &str) -> PathBuf {
  events_dir(root).join(format!("{}.jsonl", domain))
}

fn device_id_path(root: &str) -> PathBuf {
  Path::new(root).join(DEVICE_ID_FILE)
}

/* ------------------------------------------------------------------ */
/* Directorio por defecto                                             */
/* ------------------------------------------------------------------ */

/** Carpeta por defecto para los datos de la app.
 *
 *  Escritorio (Linux/macOS/Windows): <home>/.local/share/inventario-tienda
 *  Android: se resolverá con el almacenamiento privado de la app cuando
 *  se implemente el backend SAF (pendiente, fase 3).
 */
#[cfg(not(target_os = "android"))]
pub fn default_root() -> Result<String, String> {
  let home = std::env::home_dir()
    .ok_or_else(|| "No se pudo determinar el directorio personal".to_string())?;
  let root = home.join(".local/share/inventario-tienda");
  Ok(root.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ */
/* Comandos                                                           */
/* ------------------------------------------------------------------ */

/** Crea el layout de carpetas (events/<dominio>.jsonl). Idempotente. */
#[tauri::command]
pub fn store_ensure_layout(root: String) -> Result<(), String> {
  let dir = events_dir(&root);
  fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta de datos: {e}"))?;
  Ok(())
}

/** Borra todos los archivos de eventos (.jsonl) del store. */
#[tauri::command]
pub fn store_clear(root: String) -> Result<(), String> {
  let dir = events_dir(&root);
  if dir.exists() {
    for entry in fs::read_dir(&dir).map_err(|e| format!("No se pudo leer la carpeta de datos: {e}"))? {
      let entry = entry.map_err(|e| e.to_string())?;
      let path = entry.path();
      if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
        let _ = fs::remove_file(&path);
      }
    }
  }
  fs::create_dir_all(&dir).map_err(|e| format!("No se pudo recrear la carpeta de datos: {e}"))?;
  Ok(())
}

/** Agrega líneas al final de un archivo de dominio (append-only real). */
#[tauri::command]
pub fn store_append(root: String, domain: String, lines: Vec<String>) -> Result<(), String> {
  if lines.is_empty() {
    return Ok(());
  }
  validate_domain(&domain)?;
  for line in &lines {
    if !line.is_empty() {
      validate_event_line(line)?;
    }
  }
  let path = domain_path(&root, &domain);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear la carpeta de eventos: {e}"))?;
  }
  // Con el cifrado activado, el payload se cifra de forma transparente.
  // Si el llavero existe pero está bloqueado, esto falla con `ENC_LOCKED:`.
  let key = crate::crypto::resolve_key(&root)?;
  let _guard = EVENTS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("No se pudo abrir el archivo de dominio para escritura: {e}"))?;
  for line in &lines {
    if !line.is_empty() {
      let out = match &key {
        Some(km) => crate::crypto::encrypt_event_line(line, km)?,
        None => line.clone(),
      };
      writeln!(file, "{out}").map_err(|e| format!("Error escribiendo en el archivo de dominio: {e}"))?;
    }
  }
  file.flush().map_err(|e| format!("Error haciendo flush del archivo de dominio: {e}"))?;
  Ok(())
}

/** Lee todo el contenido de un archivo de dominio. Devuelve cadena vacía si no existe. */
#[tauri::command]
pub fn store_read(root: String, domain: String) -> Result<String, String> {
  validate_domain(&domain)?;
  // Se resuelve la clave antes de leer: con el cifrado activado y bloqueado
  // no se devuelve ni siquiera el texto cifrado.
  let key = crate::crypto::resolve_key(&root)?;
  let path = domain_path(&root, &domain);
  let text = match fs::read_to_string(&path) {
    Ok(text) => text,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
    Err(e) => return Err(format!("No se pudo leer el archivo de dominio: {e}")),
  };
  match key {
    Some(km) => crate::crypto::decrypt_events_text(&text, &km),
    None => Ok(text),
  }
}

/** Devuelve los mtimes (ms epoch) de cada archivo de dominio, para detectar cambios externos (Syncthing/Drive). */
#[tauri::command]
pub fn store_mtimes(root: String) -> Result<Value, String> {
  let dir = events_dir(&root);
  let domains = ALLOWED_DOMAINS;
  let mut out = BTreeMap::new();
  for domain in domains {
    let path = dir.join(format!("{domain}.jsonl"));
    if let Ok(meta) = fs::metadata(&path) {
      if let Ok(mtime) = meta.modified() {
        if let Ok(ms) = mtime.duration_since(UNIX_EPOCH) {
          out.insert(domain.to_string(), Value::Number((ms.as_millis() as i64).into()));
        }
      }
    }
  }
  Ok(serde_json::to_value(out).map_err(|e| format!("Error serializando mtimes: {e}"))?)
}

/** Lee o genera el identificador de dispositivo persistido junto a los datos. */
#[tauri::command]
pub fn store_device_id(root: String) -> Result<String, String> {
  let path = device_id_path(&root);
  if let Ok(existing) = fs::read_to_string(&path) {
    let trimmed = existing.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_string());
    }
  }
  let id = uuid_v7();
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear la carpeta de datos: {e}"))?;
  }
  fs::write(&path, format!("{id}\n")).map_err(|e| format!("No se pudo persistir el device_id: {e}"))?;
  Ok(id)
}

/* ------------------------------------------------------------------ */
/* UUID v7 (RFC 9562) — mismo layout que la implementación JS         */
/* ------------------------------------------------------------------ */

fn uuid_v7() -> String {
  use std::sync::atomic::{AtomicU64, Ordering};
  static COUNTER: AtomicU64 = AtomicU64::new(0);
  let ts = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  let mut seed = ts.wrapping_add(COUNTER.fetch_add(1, Ordering::Relaxed));
  let mut bytes = [0u8; 16];
  for i in 0..16 {
    seed = seed
      .wrapping_mul(6364136223846793005)
      .wrapping_add(1442695040888963407);
    bytes[i] = (seed >> 32) as u8;
  }
  bytes[6] = 0x70 | (bytes[6] & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8] & 0x3f); // variant 10
  let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
  format!(
    "{}-{}-{}-{}-{}",
    &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]
  )
}
