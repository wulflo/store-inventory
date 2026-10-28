//! Identidad de instalación y aviso de "un solo escritor".
//!
//! El `device_id` ya no vive dentro de la bóveda: se guarda en el directorio
//! privado de la app. Así, si la carpeta se copia a otro equipo, ese equipo
//! usa un identificador distinto y los eventos nuevos no se mezclan como si
//! fueran del mismo dispositivo.
//!
//! Además se escribe `omega/writer.json` con un latido. Si otro equipo abrió
//! la bóveda hace pocos minutos, la app avisa. No es un lock distribuido
//! perfecto (los agentes de sincronización pueden tardar en copiar el
//! archivo), pero refuerza la regla de no escribir desde dos equipos a la vez.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

use crate::{event_store, storage};

const WRITER_FILE: &str = "writer.json";
const INSTALLATION_FILE: &str = "installation_id";
/// Ventana para considerar que otro equipo sigue usando la bóveda.
const CONFLICT_WINDOW_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriterStatus {
  pub conflict: bool,
  pub previous_device_id: Option<String>,
  pub previous_device_name: Option<String>,
  pub current_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriterFile {
  device_id: String,
  device_name: String,
  seen_at: u64,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn app_data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("No se pudo resolver el directorio de la app: {e}"))?;
  fs::create_dir_all(&dir)
    .map_err(|e| format!("No se pudo crear el directorio de la app: {e}"))?;
  Ok(dir.join(name))
}

/// Identificador estable de esta instalación (no viaja con la bóveda).
#[tauri::command]
pub fn installation_device_id(app: AppHandle) -> Result<String, String> {
  let path = app_data_file(&app, INSTALLATION_FILE)?;
  if let Ok(text) = fs::read_to_string(&path) {
    let trimmed = text.trim();
    if !trimmed.is_empty() {
      return Ok(trimmed.to_string());
    }
  }
  let id = event_store::uuid_v7();
  fs::write(&path, format!("{id}\n"))
    .map_err(|e| format!("No se pudo guardar el identificador de instalación: {e}"))?;
  Ok(id)
}

fn read_writer(root: &str) -> Option<WriterFile> {
  storage::read_string(root, WRITER_FILE)
    .ok()
    .flatten()
    .and_then(|text| serde_json::from_str(&text).ok())
}

fn is_conflict(previous: Option<&WriterFile>, device_id: &str, now: u64) -> bool {
  previous
    .map(|p| p.device_id != device_id && now.saturating_sub(p.seen_at) < CONFLICT_WINDOW_MS)
    .unwrap_or(false)
}

/// Marca que esta instalación está usando la bóveda y avisa si otra la usó
/// hace pocos minutos. Se llama al arrancar y cada 5 minutos.
#[tauri::command]
pub fn writer_touch(
  root: String,
  device_id: String,
  device_name: String,
) -> Result<WriterStatus, String> {
  let now = now_ms();
  let previous = read_writer(&root);
  let conflict = is_conflict(previous.as_ref(), &device_id, now);

  let current = WriterFile {
    device_id: device_id.clone(),
    device_name,
    seen_at: now,
  };
  let json = serde_json::to_string_pretty(&current)
    .map_err(|e| format!("No se pudo serializar el estado del escritor: {e}"))?;
  storage::write_atomic(&root, WRITER_FILE, json.as_bytes())?;

  Ok(WriterStatus {
    conflict,
    previous_device_id: previous.as_ref().map(|p| p.device_id.clone()),
    previous_device_name: previous.as_ref().map(|p| p.device_name.clone()),
    current_device_id: device_id,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn writer(device_id: &str, seen_at: u64) -> WriterFile {
    WriterFile {
      device_id: device_id.to_string(),
      device_name: "Equipo".to_string(),
      seen_at,
    }
  }

  #[test]
  fn detects_a_recent_writer_on_another_device() {
    let previous = writer("otro", 10_000);
    assert!(is_conflict(Some(&previous), "este", 10_000 + 60_000));
  }

  #[test]
  fn ignores_the_same_device_or_a_stale_writer() {
    let same = writer("este", 10_000);
    assert!(!is_conflict(Some(&same), "este", 10_000 + 60_000));

    let stale = writer("otro", 10_000);
    assert!(!is_conflict(
      Some(&stale),
      "este",
      10_000 + CONFLICT_WINDOW_MS + 1
    ));
    assert!(!is_conflict(None, "este", 10_000));
  }
}
