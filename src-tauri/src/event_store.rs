use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const EVENTS_SUBDIR: &str = "events";
const DEVICE_ID_FILE: &str = "device_id";

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

fn events_dir(root: &str) -> PathBuf {
  Path::new(root).join(EVENTS_SUBDIR)
}

fn domain_path(root: &str, domain: &str) -> PathBuf {
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

/** Ruta por defecto para los datos de la app. */
#[cfg(not(target_os = "android"))]
pub fn store_default_root() -> Result<String, String> {
  default_root()
}

/** Crea el layout de carpetas (events/<dominio>.jsonl). Idempotente. */
pub fn store_ensure_layout(root: String) -> Result<(), String> {
  let dir = events_dir(&root);
  fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear la carpeta de datos: {e}"))?;
  Ok(())
}

/** Agrega líneas al final de un archivo de dominio (append-only real). */
pub fn store_append(args: AppendArgs) -> Result<(), String> {
  if args.lines.is_empty() {
    return Ok(());
  }
  let path = domain_path(&args.root, &args.domain);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear la carpeta de eventos: {e}"))?;
  }
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("No se pudo abrir el archivo de dominio para escritura: {e}"))?;
  for line in &args.lines {
    if !line.is_empty() {
      writeln!(file, "{line}").map_err(|e| format!("Error escribiendo en el archivo de dominio: {e}"))?;
    }
  }
  file.flush().map_err(|e| format!("Error haciendo flush del archivo de dominio: {e}"))?;
  Ok(())
}

/** Lee todo el contenido de un archivo de dominio. Devuelve cadena vacía si no existe. */
pub fn store_read(args: ReadArgs) -> Result<String, String> {
  let path = domain_path(&args.root, &args.domain);
  match fs::read_to_string(&path) {
    Ok(text) => Ok(text),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
    Err(e) => Err(format!("No se pudo leer el archivo de dominio: {e}")),
  }
}

/** Devuelve los mtimes (ms epoch) de cada archivo de dominio, para detectar cambios externos (Syncthing/Drive). */
pub fn store_mtimes(args: MtimesArgs) -> Result<Value, String> {
  let dir = events_dir(&args.root);
  let domains = [
    "collections", "products", "colors", "variants", "customers", "orders",
    "order_lines", "payments", "production_orders", "production_lines",
    "stock_movements", "expenses", "settings", "device_info",
  ];
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
pub fn store_device_id(args: DeviceIdArgs) -> Result<String, String> {
  let path = device_id_path(&args.root);
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
