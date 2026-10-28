use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::storage;

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
 * El frontend y las migraciones pueden hacer append casi al mismo tiempo. Sin
 * este lock, dos escrituras podrían intercalar bytes y corromper una línea
 * JSONL (especialmente en SAF, donde el append es leer + reescribir).
 */
pub(crate) static EVENTS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/* ------------------------------------------------------------------ */
/* Rutas relativas a la raíz de datos (omega)                         */
/* ------------------------------------------------------------------ */

pub(crate) fn domain_rel(domain: &str) -> String {
  format!("{EVENTS_SUBDIR}/{domain}.jsonl")
}

/* ------------------------------------------------------------------ */
/* Comandos                                                           */
/* ------------------------------------------------------------------ */

/** Crea el layout de carpetas (events/). Idempotente. */
#[tauri::command]
pub fn store_ensure_layout(root: String) -> Result<(), String> {
  storage::create_dir_all(&root, EVENTS_SUBDIR)
    .map_err(|e| format!("No se pudo crear la carpeta de datos: {e}"))?;
  migrate_legacy_jsonl_names(&root)
}

/// Repara archivos creados por versiones anteriores en Android: SAF añadía
/// `.json` a `events/foo.jsonl`, produciendo `foo.jsonl.json` y duplicados
/// `foo.jsonl (1).json`. Junta su contenido en el nombre canónico.
fn migrate_legacy_jsonl_names(root: &str) -> Result<(), String> {
  for name in storage::list_dir(root, EVENTS_SUBDIR)? {
    let Some(base) = name.strip_suffix(".json") else {
      continue;
    };
    let Some(index) = base.find(".jsonl") else {
      continue;
    };
    let canonical = &base[..index + ".jsonl".len()];
    let old_rel = format!("{EVENTS_SUBDIR}/{name}");
    let new_rel = format!("{EVENTS_SUBDIR}/{canonical}");
    let Some(mut bytes) = storage::read_bytes(root, &old_rel)? else {
      continue;
    };
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
      bytes.push(b'\n');
    }
    if !bytes.is_empty() {
      storage::append_bytes(root, &new_rel, &bytes)?;
    }
    storage::remove_file(root, &old_rel)?;
  }
  Ok(())
}

/** Borra todos los archivos de eventos (.jsonl) del store. */
#[tauri::command]
pub fn store_clear(root: String) -> Result<(), String> {
  for name in storage::list_dir(&root, EVENTS_SUBDIR)? {
    if name.ends_with(".jsonl") {
      storage::remove_file(&root, &format!("{EVENTS_SUBDIR}/{name}"))?;
    }
  }
  storage::create_dir_all(&root, EVENTS_SUBDIR)
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

  // El cifrado es obligatorio: sin llavero no se escribe texto plano.
  // Con llavero bloqueado, esto falla con `ENC_LOCKED:`.
  let key = crate::crypto::resolve_key(&root)?;
  let _guard = EVENTS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

  let mut payload = String::new();
  for line in &lines {
    if line.is_empty() {
      continue;
    }
    let out = match &key {
      Some(km) => crate::crypto::encrypt_event_line(line, km)?,
      None => line.clone(),
    };
    payload.push_str(&out);
    payload.push('\n');
  }

  if payload.is_empty() {
    return Ok(());
  }
  storage::append_bytes(&root, &domain_rel(&domain), payload.as_bytes())
}

/** Lee todo el contenido de un archivo de dominio. Devuelve cadena vacía si no existe. */
#[tauri::command]
pub fn store_read(root: String, domain: String) -> Result<String, String> {
  validate_domain(&domain)?;
  // Se resuelve la clave antes de leer: con el cifrado bloqueado no se
  // devuelve ni siquiera el texto cifrado.
  let key = crate::crypto::resolve_key(&root)?;
  let text = storage::read_string(&root, &domain_rel(&domain))?
    .unwrap_or_default();
  match key {
    Some(km) => crate::crypto::decrypt_events_text(&text, &km),
    None => Ok(text),
  }
}

/** Devuelve los mtimes (ms epoch) de cada archivo de dominio. */
#[tauri::command]
pub fn store_mtimes(root: String) -> Result<Value, String> {
  let mut out = BTreeMap::new();
  for domain in ALLOWED_DOMAINS {
    if let Some(ms) = storage::mtime_ms(&root, &domain_rel(domain))? {
      out.insert(domain.to_string(), Value::Number((ms as i64).into()));
    }
  }
  Ok(serde_json::to_value(out).map_err(|e| format!("Error serializando mtimes: {e}"))?)
}

/** Lee o genera el identificador de dispositivo persistido junto a los datos. */
#[tauri::command]
pub fn store_device_id(root: String) -> Result<String, String> {
  if let Some(existing) = storage::read_string(&root, DEVICE_ID_FILE)? {
    let trimmed = existing.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_string());
    }
  }
  let id = uuid_v7();
  storage::write_atomic(&root, DEVICE_ID_FILE, format!("{id}\n").as_bytes())?;
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
