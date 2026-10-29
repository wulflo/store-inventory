//! Diario local (write-ahead log) de eventos escritos en la bóveda.
//!
//! Vive en el directorio privado de la app, **fuera** de la bóveda, para que
//! los agentes de sincronización externos no lo puedan reemplazar. Cada entrada
//! guarda el evento ya cifrado tal como se escribió en la bóveda.
//!
//! Si un agente de sincronización pisa un `.jsonl` y borra eventos, la próxima
//! reparación los vuelve a agregar. Es una red de seguridad, no un reemplazo
//! de `longlife`: cubre la ventana entre sincronizaciones.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

use crate::{crypto, event_store, storage};

const JOURNAL_DIR: &str = "journal";
/// Cuánto se conserva una entrada ya confirmada en la bóveda. Pasado ese
/// plazo se descarta para que el diario no crezca sin límite.
const RETAIN_CONFIRMED_MS: u64 = 48 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
  /// Momento en que se escribió la entrada (ms epoch).
  pub at: u64,
  /// `kid` de la clave con la que está cifrado `line`; `None` si es texto plano.
  pub kid: Option<String>,
  /// Evento completo (payload cifrado incluido).
  pub line: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairReport {
  /// Entradas que faltaban en la bóveda y se volvieron a agregar.
  pub repaired: usize,
  /// Entradas que siguen pendientes (no se pudieron re-agregar).
  pub pending: usize,
  /// Entradas cifradas con otra clave: no se re-agregan.
  pub stale: usize,
  /// Entradas revisadas en total.
  pub checked: usize,
  pub journal_path: Option<String>,
  pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalStatus {
  pub path: Option<String>,
  pub entries: usize,
  pub domains: BTreeMap<String, usize>,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// Identificador corto y estable de la bóveda para no mezclar diarios de
/// distintas carpetas. No es secreto: solo evita colisiones.
fn vault_key(root: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(root.as_bytes());
  let hash = format!("{:x}", hasher.finalize());
  hash[..16].to_string()
}

pub fn dir_for_app(app: &AppHandle, root: &str) -> Result<PathBuf, String> {
  let base = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("No se pudo resolver el directorio de la app: {e}"))?;
  Ok(base.join(JOURNAL_DIR).join(vault_key(root)))
}

/// Igual que `dir_for_app` pero usando el `AppHandle` global. Devuelve error
/// si la app todavía no se inicializó (por ejemplo, en tests unitarios).
pub fn dir_for_root(root: &str) -> Result<PathBuf, String> {
  let app = storage::app_handle()
    .ok_or_else(|| "La app todavía no está inicializada.".to_string())?;
  dir_for_app(&app, root)
}

fn domain_file(dir: &Path, domain: &str) -> PathBuf {
  dir.join(format!("{domain}.jsonl"))
}

fn list_domains(dir: &Path) -> Result<Vec<String>, String> {
  if !dir.exists() {
    return Ok(Vec::new());
  }
  let mut out = Vec::new();
  for entry in fs::read_dir(dir)
    .map_err(|e| format!("No se pudo leer el diario local: {e}"))?
  {
    let entry = entry.map_err(|e| format!("No se pudo leer el diario local: {e}"))?;
    let path = entry.path();
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
      continue;
    };
    if let Some(domain) = name.strip_suffix(".jsonl") {
      out.push(domain.to_string());
    }
  }
  out.sort();
  Ok(out)
}

fn read_entries(path: &Path) -> Result<(Vec<JournalEntry>, usize), String> {
  let text = match fs::read_to_string(path) {
    Ok(text) => text,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), 0)),
    Err(e) => return Err(format!("No se pudo leer {}: {e}", path.display())),
  };
  let mut entries = Vec::new();
  let mut malformed = 0usize;
  for line in text.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    match serde_json::from_str::<JournalEntry>(trimmed) {
      Ok(entry) => entries.push(entry),
      Err(_) => malformed += 1,
    }
  }
  Ok((entries, malformed))
}

fn write_entries(path: &Path, entries: &[JournalEntry]) -> Result<(), String> {
  if entries.is_empty() {
    return match fs::remove_file(path) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(format!("No se pudo limpiar {}: {e}", path.display())),
    };
  }
  let mut out = String::new();
  for entry in entries {
    let json = serde_json::to_string(entry)
      .map_err(|e| format!("No se pudo serializar el diario: {e}"))?;
    out.push_str(&json);
    out.push('\n');
  }
  let tmp = path.with_extension("jsonl.tmp");
  fs::write(&tmp, out).map_err(|e| format!("No se pudo escribir {}: {e}", tmp.display()))?;
  fs::rename(&tmp, path).map_err(|e| {
    format!(
      "No se pudo reemplazar {}: {e}",
      path.display()
    )
  })
}

/// Agrega entradas al diario. Se llama **antes** del append a la bóveda.
pub fn append_lines(dir: &Path, domain: &str, lines: &[String]) -> Result<(), String> {
  if lines.is_empty() {
    return Ok(());
  }
  fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear el diario local: {e}"))?;
  let path = domain_file(dir, domain);
  let mut file = OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("No se pudo abrir {}: {e}", path.display()))?;
  let at = now_ms();
  for line in lines {
    let value: Value = serde_json::from_str(line)
      .map_err(|e| format!("El evento no es JSON válido para el diario: {e}"))?;
    let kid = value
      .get("payload")
      .and_then(crypto::unwrap_encrypted)
      .and_then(|enc| enc.kid);
    let entry = JournalEntry {
      at,
      kid,
      line: value,
    };
    let json = serde_json::to_string(&entry)
      .map_err(|e| format!("No se pudo serializar la entrada del diario: {e}"))?;
    writeln!(file, "{json}")
      .map_err(|e| format!("No se pudo escribir en {}: {e}", path.display()))?;
  }
  file
    .flush()
    .map_err(|e| format!("No se pudo sincronizar {}: {e}", path.display()))?;
  // Best effort: en algunos sistemas de archivos móviles `sync_data` no está
  // soportado, pero el flush ya deja el contenido en el buffer del SO.
  let _ = file.sync_data();
  Ok(())
}

/// Borra el diario de una bóveda usando el `AppHandle` global.
///
/// Se llama después de una migración de cifrado exitosa: las líneas viejas
/// ya no son compatibles con la clave nueva y la bóveda fue reescrita y
/// respaldada.
pub fn clear_for_root(root: &str) {
  if let Ok(dir) = dir_for_root(root) {
    let _ = clear(&dir);
  }
}

/// Borra el diario de una bóveda. No toca la bóveda.
pub fn clear(dir: &Path) -> Result<(), String> {
  match fs::remove_dir_all(dir) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("No se pudo limpiar el diario local: {e}")),
  }
}

pub fn status(dir: &Path) -> Result<JournalStatus, String> {
  let mut domains = BTreeMap::new();
  let mut entries = 0usize;
  for domain in list_domains(dir)? {
    let (items, _) = read_entries(&domain_file(dir, &domain))?;
    if !items.is_empty() {
      entries += items.len();
      domains.insert(domain, items.len());
    }
  }
  Ok(JournalStatus {
    path: if dir.exists() {
      Some(dir.to_string_lossy().to_string())
    } else {
      None
    },
    entries,
    domains,
  })
}

/// Compara el diario con la bóveda y vuelve a agregar los eventos que falten.
///
/// No descifra la bóveda: solo compara `id`s. Las entradas cifradas con un
/// `kid` distinto al actual se reportan como `stale` y no se re-agregan (el
/// evento quedaría ilegible). Esas se pueden recuperar desde longlife o el
/// historial de versiones del proveedor de nube.
pub fn repair(root: &str, dir: &Path) -> Result<RepairReport, String> {
  // Atomicidad con `store_clear` y con los appends: el chequeo de ids y el
  // re-append no pueden cruzarse con un vaciado.
  let _guard = event_store::EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  repair_locked(root, dir)
}

/// Igual que `repair`, pero el llamador ya tomó `EVENTS_WRITE_LOCK`.
///
/// Lo usa la restauración para que no se cuele un append entre la reparación
/// del diario, la copia previa y la limpieza del diario.
pub(crate) fn repair_locked(root: &str, dir: &Path) -> Result<RepairReport, String> {
  // Forzar un índice fresco en SAF: el agente pudo reemplazar documentos.
  storage::refresh_index(root)?;

  let current = crypto::resolve_key(root)?;
  let current_kid = current.as_ref().map(|km| km.kid.clone());

  let mut present = event_store::all_event_ids(root)?;
  let now = now_ms();

  let mut report = RepairReport {
    repaired: 0,
    pending: 0,
    stale: 0,
    checked: 0,
    journal_path: if dir.exists() {
      Some(dir.to_string_lossy().to_string())
    } else {
      None
    },
    errors: Vec::new(),
  };

  let mut repaired_ids: BTreeSet<String> = BTreeSet::new();
  for domain in list_domains(dir)? {
    let path = domain_file(dir, &domain);
    let (entries, malformed) = read_entries(&path)?;
    if malformed > 0 {
      report
        .errors
        .push(format!("{domain}: {malformed} entradas ilegibles en el diario"));
    }

    let mut kept: Vec<JournalEntry> = Vec::new();
    for mut entry in entries {
      report.checked += 1;
      let id = entry
        .line
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
      if id.is_empty() {
        report
          .errors
          .push(format!("{domain}: entrada del diario sin `id`"));
        continue;
      }

      if present.contains(&id) || repaired_ids.contains(&id) {
        // Ya está en la bóveda: conservar solo las recientes como red de
        // seguridad; las viejas se pueden descartar.
        if now.saturating_sub(entry.at) < RETAIN_CONFIRMED_MS {
          kept.push(entry);
        }
        continue;
      }

      let stale = match (&entry.kid, &current_kid) {
        (Some(kid), Some(current)) => kid != current,
        (Some(_), None) => true,
        _ => false,
      };
      if stale {
        report.stale += 1;
        if now.saturating_sub(entry.at) < RETAIN_CONFIRMED_MS {
          kept.push(entry);
        }
        continue;
      }

      let line = serde_json::to_string(&entry.line)
        .map_err(|e| format!("No se pudo serializar el evento del diario: {e}"))?;
      match event_store::append_payload_locked(root, &domain, &[line], None) {
        Ok(()) => {
          report.repaired += 1;
          repaired_ids.insert(id);
          present.insert(
            entry
              .line
              .get("id")
              .and_then(Value::as_str)
              .unwrap_or_default()
              .to_string(),
          );
          // Renovar la retención: acaba de ser reparado.
          entry.at = now;
          kept.push(entry);
        }
        Err(err) => {
          report.pending += 1;
          report.errors.push(format!("{domain}/{id}: {err}"));
          kept.push(entry);
        }
      }
    }
    write_entries(&path, &kept)?;
  }

  Ok(report)
}

/* ------------------------------------------------------------------ */
/* Comandos Tauri                                                     */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn journal_repair(app: AppHandle, root: String) -> Result<RepairReport, String> {
  let dir = dir_for_app(&app, &root)?;
  repair(&root, &dir)
}

#[tauri::command]
pub fn journal_status(app: AppHandle, root: String) -> Result<JournalStatus, String> {
  let dir = dir_for_app(&app, &root)?;
  status(&dir)
}

#[tauri::command]
pub fn journal_clear(app: AppHandle, root: String) -> Result<(), String> {
  let dir = dir_for_app(&app, &root)?;
  // Mismo lock que appends y reparación: si no, un repair concurrente podría
  // volver a escribir el diario después de descartarlo.
  let _guard = event_store::EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());
  clear(&dir)
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
  use super::*;
  use crate::keys;

  fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir().join(format!("inventario-journal-{tag}-{nanos}"))
  }

  fn setup_keyring(root: &str) -> String {
    let created = keys::create("contraseña-segura", keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(root, &created.keyring).unwrap();
    crypto::set_current(root, created.key, created.keyring.kid.clone());
    created.keyring.kid
  }

  fn sample_event(id: &str) -> String {
    serde_json::json!({
      "id": id,
      "type": "Customer.Created",
      "payload": { "name": "Ana" },
      "metadata": {
        "hlc": 1,
        "deviceId": "device-test",
        "timestamp": 1,
        "version": 1
      }
    })
    .to_string()
  }

  fn vault_lines(root: &str, domain: &str) -> String {
    storage::read_string(root, &format!("events/{domain}.jsonl"))
      .unwrap()
      .unwrap_or_default()
  }

  #[test]
  fn append_writes_the_journal_with_the_encrypted_line() {
    let root = temp_dir("append");
    let dir = temp_dir("append-journal");
    let root_s = root.to_string_lossy().to_string();
    let kid = setup_keyring(&root_s);

    let line = sample_event("evt-1");
    event_store::append_payload(&root_s, "customers", &[line], Some(&dir)).unwrap();

    let status = status(&dir).unwrap();
    assert_eq!(status.entries, 1);
    let (entries, malformed) = read_entries(&domain_file(&dir, "customers")).unwrap();
    assert_eq!(malformed, 0);
    assert_eq!(entries[0].kid.as_deref(), Some(kid.as_str()));
    assert_eq!(entries[0].line["id"], "evt-1");
    assert!(!vault_lines(&root_s, "customers").contains("Ana"));

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn repair_reappends_an_event_that_disappeared_from_the_vault() {
    let root = temp_dir("repair");
    let dir = temp_dir("repair-journal");
    let root_s = root.to_string_lossy().to_string();
    setup_keyring(&root_s);

    event_store::append_payload(
      &root_s,
      "customers",
      &[sample_event("evt-1")],
      Some(&dir),
    )
    .unwrap();
    // Simular que el agente de sync reemplazó el archivo con una versión vacía.
    storage::write_bytes(&root_s, "events/customers.jsonl", b"").unwrap();
    assert_eq!(vault_lines(&root_s, "customers"), "");

    let report = repair(&root_s, &dir).unwrap();
    assert_eq!(report.repaired, 1);
    assert_eq!(report.pending, 0);
    assert!(vault_lines(&root_s, "customers").contains("evt-1"));

    // La entrada reparada se conserva para una segunda pasada.
    let status = status(&dir).unwrap();
    assert_eq!(status.entries, 1);

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn repair_does_not_reappend_an_event_encrypted_with_another_key() {
    let root = temp_dir("stale");
    let dir = temp_dir("stale-journal");
    let root_s = root.to_string_lossy().to_string();
    setup_keyring(&root_s);
    fs::create_dir_all(&dir).unwrap();

    let entry = JournalEntry {
      at: now_ms(),
      kid: Some("otra-clave".to_string()),
      line: serde_json::from_str(&sample_event("evt-otro")).unwrap(),
    };
    write_entries(&domain_file(&dir, "customers"), &[entry]).unwrap();

    let report = repair(&root_s, &dir).unwrap();
    assert_eq!(report.repaired, 0);
    assert_eq!(report.stale, 1);
    assert_eq!(vault_lines(&root_s, "customers"), "");

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn repair_drops_old_entries_already_present_in_the_vault() {
    let root = temp_dir("old");
    let dir = temp_dir("old-journal");
    let root_s = root.to_string_lossy().to_string();
    setup_keyring(&root_s);
    fs::create_dir_all(&dir).unwrap();

    // Evento ya presente en la bóveda (texto plano: la reparación no necesita
    // descifrarlo para comparar ids).
    storage::write_bytes(
      &root_s,
      "events/customers.jsonl",
      format!("{}\n", sample_event("evt-1")).as_bytes(),
    )
    .unwrap();

    let entry = JournalEntry {
      at: 0,
      kid: None,
      line: serde_json::from_str(&sample_event("evt-1")).unwrap(),
    };
    write_entries(&domain_file(&dir, "customers"), &[entry]).unwrap();

    let report = repair(&root_s, &dir).unwrap();
    assert_eq!(report.checked, 1);
    assert_eq!(report.repaired, 0);
    assert!(!domain_file(&dir, "customers").exists());

    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&dir);
  }
}
