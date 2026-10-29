use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

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
 * El frontend, las migraciones y `store_clear` pueden tocar los mismos
 * archivos casi al mismo tiempo. Sin este lock, dos escrituras podrían
 * intercalar bytes, o un vaciado podría competir con un append y dejar una
 * entrada huérfana en el diario.
 */
pub(crate) static EVENTS_WRITE_LOCK: Mutex<()> = Mutex::new(());

/* ------------------------------------------------------------------ */
/* Rutas relativas a la raíz de datos (omega)                         */
/* ------------------------------------------------------------------ */

pub(crate) fn domain_rel(domain: &str) -> String {
  format!("{EVENTS_SUBDIR}/{domain}.jsonl")
}

/// `true` si `name` pertenece al dominio.
///
/// Además del archivo canónico se aceptan copias que crean los agentes de
/// sincronización:
/// - `orders (1).jsonl`, `orders (2).jsonl` (copias de conflicto)
/// - `orders.conflict-....jsonl`
/// - `orders.<device>.jsonl` (futuro layout por dispositivo)
///
/// Se excluyen los nombres legacy `*.jsonl.json` para no duplicar datos ya
/// migrados.
fn is_domain_file(name: &str, domain: &str) -> bool {
  if !name.ends_with(".jsonl") || name.ends_with(".jsonl.json") {
    return false;
  }
  name == format!("{domain}.jsonl")
    || name.starts_with(&format!("{domain}."))
    || name.starts_with(&format!("{domain} ("))
}

/// Archivos de un dominio, incluidos los de conflicto. Orden determinista.
pub(crate) fn domain_files(root: &str, domain: &str) -> Result<Vec<String>, String> {
  let names = match storage::list_dir(root, EVENTS_SUBDIR) {
    Ok(names) => names,
    // En SAF la carpeta puede no existir todavía; no es un error de lectura.
    Err(_) => return Ok(Vec::new()),
  };
  let mut out: Vec<String> = names
    .into_iter()
    .filter(|name| is_domain_file(name, domain))
    .map(|name| format!("{EVENTS_SUBDIR}/{name}"))
    .collect();
  out.sort();
  Ok(out)
}

/// Todos los `.jsonl` de `events/` (sin los legacy `*.jsonl.json`).
fn all_event_files(root: &str) -> Result<Vec<String>, String> {
  let names = match storage::list_dir(root, EVENTS_SUBDIR) {
    Ok(names) => names,
    Err(_) => return Ok(Vec::new()),
  };
  let mut out: Vec<String> = names
    .into_iter()
    .filter(|name| {
      name.ends_with(".jsonl")
        && !name.ends_with(".jsonl.json")
        && !name.starts_with(".keep-")
    })
    .map(|name| format!("{EVENTS_SUBDIR}/{name}"))
    .collect();
  out.sort();
  Ok(out)
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
pub fn store_clear(app: AppHandle, root: String) -> Result<(), String> {
  // Tomar el lock ANTES de limpiar el diario: si un append concurrente
  // escribiera su entrada entre la limpieza y el borrado, la reparación
  // posterior resucitaría un evento que el usuario quiso vaciar.
  let _guard = EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  // Limpiar el diario antes de borrar: si el borrado falla, la bóveda conserva
  // los datos. Si se limpiara después y fallara, la reparación resucitaría lo
  // que el usuario quiso vaciar.
  if let Ok(dir) = crate::journal::dir_for_app(&app, &root) {
    let _ = crate::journal::clear(&dir);
  }

  for file in storage::list_files_recursive(&root, EVENTS_SUBDIR)? {
    storage::remove_file(&root, &file)?;
  }
  storage::create_dir_all(&root, EVENTS_SUBDIR)
}

/// Agrega líneas al final de un archivo de dominio (append-only real).
#[tauri::command]
pub fn store_append(
  app: AppHandle,
  root: String,
  domain: String,
  lines: Vec<String>,
) -> Result<(), String> {
  let journal_dir = crate::journal::dir_for_app(&app, &root).ok();
  append_payload(&root, &domain, &lines, journal_dir.as_deref())
}

/// Append sin diario, para tests y llamadas internas que no tienen
/// `AppHandle`. No usar desde la app real: perdería la red de seguridad.
#[cfg(test)]
pub(crate) fn store_append_no_journal(
  root: String,
  domain: String,
  lines: Vec<String>,
) -> Result<(), String> {
  append_payload(&root, &domain, &lines, None)
}

/// Append que usa el `AppHandle` global (para llamadas internas de Rust).
pub(crate) fn append_encrypted_line(
  root: &str,
  domain: &str,
  line: &str,
) -> Result<(), String> {
  let journal_dir = crate::journal::dir_for_root(root).ok();
  append_payload(root, domain, &[line.to_string()], journal_dir.as_deref())
}

/// Núcleo del append: valida, cifra si hace falta, escribe el diario (WAL) y
/// recién entonces agrega a la bóveda.
///
/// `journal_dir` es `None` durante una reparación: el evento ya está en el
/// diario y no queremos duplicar la entrada.
pub(crate) fn append_payload(
  root: &str,
  domain: &str,
  lines: &[String],
  journal_dir: Option<&Path>,
) -> Result<(), String> {
  let _guard = EVENTS_WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
  append_payload_locked(root, domain, lines, journal_dir)
}

/// Igual que `append_payload`, pero asume que el llamador ya tomó
/// `EVENTS_WRITE_LOCK`.
///
/// Lo usa la reparación del diario: necesita que el chequeo "¿está en la
/// bóveda?" y el re-append sean atómicos respecto de `store_clear`, para no
/// resucitar eventos que el usuario acaba de vaciar.
pub(crate) fn append_payload_locked(
  root: &str,
  domain: &str,
  lines: &[String],
  journal_dir: Option<&Path>,
) -> Result<(), String> {
  if lines.is_empty() {
    return Ok(());
  }
  validate_domain(domain)?;
  for line in lines {
    if !line.is_empty() {
      validate_event_line(line)?;
    }
  }

  // El cifrado es obligatorio: sin llavero no se escribe texto plano.
  // Con llavero bloqueado, esto falla con `ENC_LOCKED:`.
  let key = crate::crypto::resolve_key(root)?;

  let mut payload = String::new();
  let mut out_lines: Vec<String> = Vec::new();
  for line in lines {
    if line.is_empty() {
      continue;
    }
    // `encrypt_event_line` es idempotente: si la línea ya viene cifrada (por
    // ejemplo desde `crypto_append_event`), la deja intacta.
    let out = match &key {
      Some(km) => crate::crypto::encrypt_event_line(line, km)?,
      None => line.clone(),
    };
    out_lines.push(out.clone());
    payload.push_str(&out);
    payload.push('\n');
  }

  if payload.is_empty() {
    return Ok(());
  }

  // WAL: el diario se escribe antes que la bóveda. Si el append falla o el
  // agente de sync pisa el archivo, la reparación puede volver a agregarlo.
  // Un fallo del diario no bloquea la escritura principal (mejor esfuerzo).
  if let Some(dir) = journal_dir {
    if let Err(err) = crate::journal::append_lines(dir, domain, &out_lines) {
      eprintln!("No se pudo escribir el diario local: {err}");
    }
  }

  let target = domain_rel(domain);
  match storage::append_bytes(root, &target, payload.as_bytes()) {
    Ok(()) => Ok(()),
    Err(first) => {
      // Un agente de sync pudo borrar la carpeta `events/` completa. En SAF
      // `append_bytes` no crea carpetas intermedias; reintentar una vez tras
      // recrear el layout evita dejar el evento pendiente hasta el próximo
      // arranque.
      let _ = storage::refresh_index(root);
      match storage::create_dir_all(root, EVENTS_SUBDIR) {
        Ok(()) => storage::append_bytes(root, &target, payload.as_bytes()),
        Err(_) => Err(first),
      }
    }
  }
}

/** Lee todo el contenido de un dominio, fusionando copias de conflicto. */
#[tauri::command]
pub fn store_read(root: String, domain: String) -> Result<String, String> {
  validate_domain(&domain)?;
  // Se resuelve la clave antes de leer: con el cifrado bloqueado no se
  // devuelve ni siquiera el texto cifrado.
  let key = crate::crypto::resolve_key(&root)?;
  let mut out = String::new();
  for relative in domain_files(&root, &domain)? {
    // El archivo pudo desaparecer entre el listado y la lectura (sync externo).
    let text = match storage::read_string(&root, &relative) {
      Ok(Some(text)) => text,
      _ => continue,
    };
    let text = match &key {
      Some(km) => crate::crypto::decrypt_events_text(&text, &km)?,
      None => text,
    };
    out.push_str(&text);
    if !out.ends_with('\n') {
      out.push('\n');
    }
  }
  Ok(out)
}

/** Devuelve los mtimes (ms epoch) agregados de cada dominio. */
#[tauri::command]
pub fn store_mtimes(root: String) -> Result<Value, String> {
  let mut out = BTreeMap::new();
  for domain in ALLOWED_DOMAINS {
    let mut max: Option<u64> = None;
    for relative in domain_files(&root, domain)? {
      // Un archivo puede desaparecer a mitad del listado (sync externo):
      // ignorarlo, no romper todo el comando.
      if let Ok(Some(ms)) = storage::mtime_ms(&root, &relative) {
        max = Some(max.map_or(ms, |prev| prev.max(ms)));
      }
    }
    if let Some(ms) = max {
      out.insert(domain.to_string(), Value::Number((ms as i64).into()));
    }
  }
  Ok(serde_json::to_value(out).map_err(|e| format!("Error serializando mtimes: {e}"))?)
}

/// Huellas por dominio: suma de tamaños y mtime máximo.
///
/// El frontend las compara para detectar cambios externos. A diferencia de
/// `store_mtimes`, funcionan en SAF (se leen del descriptor del archivo).
#[tauri::command]
pub fn store_fingerprints(
  root: String,
) -> Result<BTreeMap<String, storage::FileFingerprint>, String> {
  // Un solo listado de `events/` y una huella por archivo. Llamar a
  // `domain_files` por dominio haría 14 lecturas de directorio cada 3 s,
  // especialmente costoso en SAF.
  let names = match storage::list_dir(&root, EVENTS_SUBDIR) {
    Ok(names) => names,
    Err(_) => return Ok(BTreeMap::new()),
  };
  let mut out: BTreeMap<String, storage::FileFingerprint> = BTreeMap::new();
  for name in names {
    if !name.ends_with(".jsonl") || name.ends_with(".jsonl.json") || name.starts_with(".keep-") {
      continue;
    }
    let Some(domain) = ALLOWED_DOMAINS
      .iter()
      .copied()
      .find(|domain| is_domain_file(&name, domain))
    else {
      continue;
    };
    let relative = format!("{EVENTS_SUBDIR}/{name}");
    // Si el archivo desapareció o la URI SAF quedó vieja, se omite. El poller
    // lo interpreta como "este dominio cambió/desapareció".
    let Ok(Some(fp)) = storage::fingerprint(&root, &relative) else {
      continue;
    };
    let entry = out
      .entry(domain.to_string())
      .or_insert(storage::FileFingerprint {
        size: 0,
        mtime: None,
      });
    entry.size = entry.size.saturating_add(fp.size);
    if let Some(ms) = fp.mtime {
      entry.mtime = Some(entry.mtime.map_or(ms, |prev| prev.max(ms)));
    }
  }
  Ok(out)
}

/** Devuelve los eventos crudos (payload cifrado si el cifrado está activo). */
#[tauri::command]
pub fn store_export_raw(root: String) -> Result<Value, String> {
  let mut events = Vec::new();
  for relative in all_event_files(&root)? {
    let text = match storage::read_string(&root, &relative) {
      Ok(Some(text)) => text,
      _ => continue,
    };
    for line in text.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      match serde_json::from_str::<Value>(trimmed) {
        Ok(value) => {
          let valid = value.get("id").and_then(Value::as_str).is_some()
            && value.get("type").and_then(Value::as_str).is_some()
            && value
              .get("metadata")
              .and_then(|m| m.get("hlc"))
              .and_then(Value::as_i64)
              .is_some();
          if valid {
            events.push(value);
          }
        }
        // Una línea parcial al final se ignora igual que en la lectura normal.
        Err(_) => continue,
      }
    }
  }
  Ok(Value::Array(events))
}

/// `id` de todos los eventos presentes en la bóveda (sin descifrar).
///
/// Lo usa la reparación del diario para saber qué falta. Incluye copias de
/// conflicto: si el agente dejó los eventos en `orders (1).jsonl`, ya están a
/// salvo y no hay que re-agregarlos.
pub(crate) fn all_event_ids(root: &str) -> Result<BTreeSet<String>, String> {
  let mut ids = BTreeSet::new();
  for relative in all_event_files(root)? {
    let text = match storage::read_string(root, &relative) {
      Ok(Some(text)) => text,
      _ => continue,
    };
    for line in text.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        if let Some(id) = value.get("id").and_then(Value::as_str) {
          ids.insert(id.to_string());
        }
      }
    }
  }
  Ok(ids)
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

pub(crate) fn uuid_v7() -> String {
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

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
  use super::*;
  use crate::keys;

  fn temp_root(tag: &str) -> String {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir()
      .join(format!("inventario-store-{tag}-{nanos}"))
      .to_string_lossy()
      .to_string()
  }

  fn setup_keyring(root: &str) {
    let created = keys::create("contraseña-segura", keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(root, &created.keyring).unwrap();
    crate::crypto::set_current(root, created.key, created.keyring.kid.clone());
  }

  fn sample_event(id: &str) -> String {
    serde_json::json!({
      "id": id,
      "type": "Order.Created",
      "payload": { "total": 100 },
      "metadata": {
        "hlc": 1,
        "deviceId": "device-test",
        "timestamp": 1,
        "version": 1
      }
    })
    .to_string()
  }

  #[test]
  fn domain_files_includes_conflict_copies_but_not_other_domains() {
    let root = temp_root("domain-files");
    storage::create_dir_all(&root, EVENTS_SUBDIR).unwrap();
    for name in [
      "orders.jsonl",
      "orders (1).jsonl",
      "orders.conflict-2026.jsonl",
      "orders.jsonl.json",
      "order_lines.jsonl",
      "products.jsonl",
    ] {
      storage::write_bytes(&root, &format!("events/{name}"), b"").unwrap();
    }

    let files = domain_files(&root, "orders").unwrap();
    assert_eq!(
      files,
      vec![
        "events/orders (1).jsonl".to_string(),
        "events/orders.conflict-2026.jsonl".to_string(),
        "events/orders.jsonl".to_string(),
      ]
    );

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn store_read_merges_the_canonical_file_and_conflict_copies() {
    let root = temp_root("read-merge");
    setup_keyring(&root);
    storage::create_dir_all(&root, EVENTS_SUBDIR).unwrap();
    storage::write_bytes(
      &root,
      "events/orders.jsonl",
      format!("{}\n", sample_event("evt-1")).as_bytes(),
    )
    .unwrap();
    storage::write_bytes(
      &root,
      "events/orders (1).jsonl",
      format!("{}\n", sample_event("evt-2")).as_bytes(),
    )
    .unwrap();

    let text = store_read(root.clone(), "orders".to_string()).unwrap();
    assert!(text.contains("evt-1"));
    assert!(text.contains("evt-2"));

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn fingerprints_aggregate_size_and_mtime_of_conflict_copies() {
    let root = temp_root("fingerprints");
    storage::create_dir_all(&root, EVENTS_SUBDIR).unwrap();
    storage::write_bytes(&root, "events/orders.jsonl", b"1234").unwrap();
    storage::write_bytes(&root, "events/orders (1).jsonl", b"567890").unwrap();

    let stamps = store_fingerprints(root.clone()).unwrap();
    let fp = stamps.get("orders").expect("huella de orders");
    assert_eq!(fp.size, 10);
    assert!(fp.mtime.is_some());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn all_event_ids_reads_conflict_copies() {
    let root = temp_root("ids");
    storage::create_dir_all(&root, EVENTS_SUBDIR).unwrap();
    storage::write_bytes(
      &root,
      "events/orders (1).jsonl",
      format!("{}\n", sample_event("evt-1")).as_bytes(),
    )
    .unwrap();

    let ids = all_event_ids(&root).unwrap();
    assert!(ids.contains("evt-1"));

    let _ = std::fs::remove_dir_all(&root);
  }
}
