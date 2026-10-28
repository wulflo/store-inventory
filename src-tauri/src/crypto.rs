//! Cifrado de payloads a nivel de evento.
//!
//! La clave de datos (DEK) vive en `keys/keyring.json` envuelta por la
//! contraseña maestra y por un código de recuperación (ver `keys.rs`). En
//! memoria solo se guarda la DEK desbloqueada.
//!
//! Los metadatos (`id`, `type`, `metadata`) quedan en texto plano para poder
//! ordenar, deduplicar, validar y sincronizar sin la clave. El `payload` se
//! cifra con XChaCha20-Poly1305 y se autentica con AAD = `id | type`, de modo
//! que un ciphertext no se puede mover a otro evento.

use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
  aead::{Aead, KeyInit, Payload},
  Key, XChaCha20Poly1305, XNonce,
};
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::{keys, storage};

/* ------------------------------------------------------------------ */
/* Clave en memoria                                                    */
/* ------------------------------------------------------------------ */

#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct KeyMaterial {
  pub key: [u8; 32],
  pub kid: String,
}

impl std::fmt::Debug for KeyMaterial {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.debug_struct("KeyMaterial")
      .field("key", &"[REDACTED]")
      .field("kid", &self.kid)
      .finish()
  }
}

/// Error reconocible por el frontend para pedir el desbloqueo.
pub const LOCKED_PREFIX: &str = "ENC_LOCKED:";
/// Error reconocible por el frontend cuando todavía no hay llavero.
pub const NOT_SETUP_PREFIX: &str = "ENC_NOT_SETUP:";
const LOCKED_DETAIL: &str =
  " Los datos están cifrados. Desbloqueá con tu contraseña maestra para continuar.";
const NOT_SETUP_DETAIL: &str =
  " Todavía no configuraste el cifrado. Creá una contraseña maestra para empezar.";

fn locked_error() -> String {
  format!("{LOCKED_PREFIX}{LOCKED_DETAIL}")
}

fn not_setup_error() -> String {
  format!("{NOT_SETUP_PREFIX}{NOT_SETUP_DETAIL}")
}

static CURRENT: Mutex<std::collections::BTreeMap<String, KeyMaterial>> =
  Mutex::new(std::collections::BTreeMap::new());

/// Normaliza la raíz para usar como clave del mapa en memoria.
fn root_id(root: &str) -> String {
  root.trim_end_matches(['/', '\\']).to_string()
}

pub fn current_key(root: &str) -> Option<KeyMaterial> {
  CURRENT
    .lock()
    .unwrap_or_else(|e| e.into_inner())
    .get(&root_id(root))
    .cloned()
}

pub fn set_current(root: &str, key: [u8; 32], kid: String) {
  let mut guard = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
  guard.insert(root_id(root), KeyMaterial { key, kid });
}

/// Borra todas las claves de la memoria (los datos quedan ilegibles).
pub fn clear_current() {
  let mut guard = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
  let keys = std::mem::take(&mut *guard);
  for (_, mut km) in keys {
    for byte in km.key.iter_mut() {
      unsafe { std::ptr::write_volatile(byte, 0) };
    }
  }
}

/// Borra la clave de una raíz concreta.
pub fn clear_current_for(root: &str) {
  let mut guard = CURRENT.lock().unwrap_or_else(|e| e.into_inner());
  if let Some(mut km) = guard.remove(&root_id(root)) {
    for byte in km.key.iter_mut() {
      unsafe { std::ptr::write_volatile(byte, 0) };
    }
  }
}

pub fn is_unlocked() -> bool {
  !CURRENT
    .lock()
    .unwrap_or_else(|e| e.into_inner())
    .is_empty()
}

/// `true` si existe un llavero (el cifrado está activado).
pub fn is_enabled(root: &str) -> bool {
  keys::exists(root)
}

/// Resuelve la clave para leer/escribir.
///
/// - Sin llavero → error `ENC_NOT_SETUP:` (el cifrado es obligatorio).
/// - Con llavero y desbloqueado → `Ok(Some(key))`.
/// - Con llavero y bloqueado → error `ENC_LOCKED:`.
pub fn resolve_key(root: &str) -> Result<Option<KeyMaterial>, String> {
  if !is_enabled(root) {
    return Err(not_setup_error());
  }
  current_key(root).map(Some).ok_or_else(|| locked_error())
}

/* ------------------------------------------------------------------ */
/* Primitivas de cifrado                                              */
/* ------------------------------------------------------------------ */

fn event_aad(id: &str, event_type: &str) -> Vec<u8> {
  format!("inventario-event-v2|{id}|{event_type}").into_bytes()
}

pub fn encrypt_payload(
  payload: &Value,
  key: &[u8; 32],
  aad: &[u8],
) -> Result<(String, String), String> {
  let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
  let nonce_bytes: [u8; 24] = rand::random();
  let plaintext = serde_json::to_vec(payload).map_err(|e| format!("JSON inválido: {e}"))?;
  let ciphertext = cipher
    .encrypt(
      XNonce::from_slice(&nonce_bytes),
      Payload {
        msg: &plaintext,
        aad,
      },
    )
    .map_err(|e| format!("Error cifrando el payload: {e}"))?;
  Ok((STANDARD.encode(ciphertext), STANDARD.encode(nonce_bytes)))
}

pub fn decrypt_payload(
  ciphertext_b64: &str,
  nonce_b64: &str,
  key: &[u8; 32],
  aad: &[u8],
) -> Result<Value, String> {
  let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
  let ciphertext = STANDARD
    .decode(ciphertext_b64)
    .map_err(|e| format!("Ciphertext Base64 inválido: {e}"))?;
  let nonce_bytes = STANDARD
    .decode(nonce_b64)
    .map_err(|e| format!("Nonce Base64 inválido: {e}"))?;
  if nonce_bytes.len() != 24 {
    return Err(format!(
      "El nonce debe tener 24 bytes, tiene {}",
      nonce_bytes.len()
    ));
  }
  let plaintext = cipher
    .decrypt(
      XNonce::from_slice(&nonce_bytes),
      Payload {
        msg: &ciphertext,
        aad,
      },
    )
    .map_err(|_| "No se pudo descifrar el payload (¿clave distinta o datos alterados?).".to_string())?;
  serde_json::from_slice(&plaintext).map_err(|e| format!("JSON inválido tras descifrar: {e}"))
}

/// Descifrado de payloads de la versión 0.1.x (sin AAD ni `kid`).
fn decrypt_payload_legacy(
  ciphertext_b64: &str,
  nonce_b64: &str,
  key: &[u8; 32],
) -> Result<Value, String> {
  decrypt_payload(ciphertext_b64, nonce_b64, key, b"")
}

/* ------------------------------------------------------------------ */
/* Formato del payload cifrado                                        */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct EncryptedPayload {
  pub data: String,
  pub nonce: String,
  pub kid: Option<String>,
}

pub fn wrap_encrypted(ciphertext_b64: &str, nonce_b64: &str, kid: &str) -> Value {
  serde_json::json!({
    "_encrypted": true,
    "v": 2,
    "alg": "XChaCha20-Poly1305",
    "kid": kid,
    "data": ciphertext_b64,
    "nonce": nonce_b64
  })
}

pub fn unwrap_encrypted(payload: &Value) -> Option<EncryptedPayload> {
  let obj = payload.as_object()?;
  if obj.get("_encrypted").and_then(Value::as_bool) != Some(true) {
    return None;
  }
  Some(EncryptedPayload {
    data: obj.get("data")?.as_str()?.to_string(),
    nonce: obj.get("nonce")?.as_str()?.to_string(),
    kid: obj.get("kid").and_then(Value::as_str).map(str::to_string),
  })
}

/* ------------------------------------------------------------------ */
/* Transformación de líneas de evento                                 */
/* ------------------------------------------------------------------ */

/// Cifra el campo `payload` de una línea JSONL. Idempotente.
pub fn encrypt_event_line(line: &str, km: &KeyMaterial) -> Result<String, String> {
  let mut event: Value =
    serde_json::from_str(line).map_err(|e| format!("El evento no es JSON válido: {e}"))?;

  let Some(payload) = event.get("payload").cloned() else {
    return Err("El evento no tiene campo `payload`.".to_string());
  };
  if unwrap_encrypted(&payload).is_some() {
    return Ok(line.to_string());
  }

  let id = event
    .get("id")
    .and_then(Value::as_str)
    .ok_or_else(|| "El evento no tiene `id`.".to_string())?;
  let event_type = event
    .get("type")
    .and_then(Value::as_str)
    .ok_or_else(|| "El evento no tiene `type`.".to_string())?;

  event["payload"] = encrypt_event_value(id, event_type, &payload, km)?;
  serde_json::to_string(&event).map_err(|e| format!("No se pudo serializar el evento: {e}"))
}

/// Cifra un payload ya parseado. Idempotente. Se usa también al importar eventos.
pub fn encrypt_event_value(
  id: &str,
  event_type: &str,
  payload: &Value,
  km: &KeyMaterial,
) -> Result<Value, String> {
  if unwrap_encrypted(payload).is_some() {
    return Ok(payload.clone());
  }
  let aad = event_aad(id, event_type);
  let (ciphertext, nonce) = encrypt_payload(payload, &km.key, &aad)?;
  Ok(wrap_encrypted(&ciphertext, &nonce, &km.kid))
}

/// Verifica que un payload recibido sea legible con esta clave.
///
/// - Texto plano → se cifrará al guardar.
/// - Cifrado con el mismo `kid` → se guarda tal cual.
/// - Cifrado con otra clave → error (no se guarda basura ilegible).
#[cfg(test)]
pub fn ensure_compatible_payload(payload: &Value, km: &KeyMaterial) -> Result<(), String> {
  if let Some(enc) = unwrap_encrypted(payload) {
    match enc.kid {
      Some(kid) if kid == km.kid => {}
      Some(kid) => {
        return Err(format!(
          "El evento viene cifrado con otra clave (kid {kid}). \
           Este equipo usa kid {}. Para sincronizar, ambos deben compartir el llavero \
           (Ajustes > Cifrado > Importar llavero o Adoptar llavero). Activarlo por separado \
           con la misma contraseña no alcanza: cada activación crea una clave distinta.",
          km.kid
        ));
      }
      None => {
        return Err(
          "El evento viene cifrado con el formato viejo (0.1.x, sin huella de clave) y no se \
           puede leer con este llavero. Actualizá el otro equipo a esta versión y compartí el \
           llavero antes de volver a sincronizar."
            .to_string(),
        );
      }
    }
  }
  Ok(())
}

/// Descifra el campo `payload` de una línea JSONL si está cifrado.
///
/// Si falla el descifrado, devuelve el evento con `_error` en el payload en
/// lugar de abortar toda la lectura: el resto de la base sigue visible y el
/// problema se puede mostrar en la UI.
pub fn decrypt_event_line(line: &str, km: &KeyMaterial) -> Result<String, String> {
  let mut event: Value = match serde_json::from_str(line) {
    Ok(value) => value,
    // Línea corrupta: se conserva tal cual para no perder información.
    Err(_) => return Ok(line.to_string()),
  };

  let Some(enc) = event.get("payload").and_then(unwrap_encrypted) else {
    return Ok(line.to_string());
  };

  let id = event.get("id").and_then(Value::as_str).unwrap_or_default();
  let event_type = event.get("type").and_then(Value::as_str).unwrap_or_default();

  if let Some(kid) = &enc.kid {
    if kid != &km.kid {
      event["payload"] = serde_json::json!({
        "_encrypted": true,
        "_error": format!(
          "Este evento fue cifrado con otra clave (kid {kid}). No pertenece a este equipo."
        ),
        "kid": kid,
        "alg": "XChaCha20-Poly1305",
        "data": enc.data,
        "nonce": enc.nonce
      });
      return serde_json::to_string(&event)
        .map_err(|e| format!("No se pudo serializar el evento: {e}"));
    }
  }

  let aad = event_aad(id, event_type);
  let decrypted = decrypt_payload(&enc.data, &enc.nonce, &km.key, &aad).or_else(|err| {
    if enc.kid.is_none() {
      decrypt_payload_legacy(&enc.data, &enc.nonce, &km.key)
    } else {
      Err(err)
    }
  });

  match decrypted {
    Ok(plain) => event["payload"] = plain,
    Err(err) => {
      event["payload"] = serde_json::json!({
        "_encrypted": true,
        "_error": err,
        "kid": enc.kid,
        "alg": "XChaCha20-Poly1305",
        "data": enc.data,
        "nonce": enc.nonce
      });
    }
  }

  serde_json::to_string(&event).map_err(|e| format!("No se pudo serializar el evento: {e}"))
}

/// Como `decrypt_event_line`, pero falla en vez de marcar `_error`.
/// Se usa en migraciones/verificaciones, donde un error debe abortar.
fn decrypt_event_line_strict(line: &str, km: &KeyMaterial) -> Result<String, String> {
  let decrypted = decrypt_event_line(line, km)?;
  let event: Value = serde_json::from_str(&decrypted)
    .map_err(|e| format!("Evento inválido tras descifrar: {e}"))?;
  if event
    .get("payload")
    .and_then(|p| p.get("_error"))
    .is_some()
  {
    let detail = event["payload"]["_error"].as_str().unwrap_or("error desconocido");
    return Err(format!("No se pudo descifrar un evento: {detail}"));
  }
  Ok(decrypted)
}

/// Descifra todas las líneas de un archivo JSONL.
pub fn decrypt_events_text(text: &str, km: &KeyMaterial) -> Result<String, String> {
  let mut out = String::with_capacity(text.len());
  for line in text.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    out.push_str(&decrypt_event_line(trimmed, km)?);
    out.push('\n');
  }
  Ok(out)
}

/// Agrega un evento cifrado al archivo de dominio (append-only).
pub fn append_event_encrypted(
  root: &str,
  domain: &str,
  event_json: &str,
  km: &KeyMaterial,
) -> Result<(), String> {
  let line = encrypt_event_line(event_json, km)?;
  crate::event_store::store_append(root.to_string(), domain.to_string(), vec![line])
}

/// Lee y descifra todas las líneas del archivo de dominio con la clave actual.
pub fn read_events_decrypted(root: &str, domain: &str) -> Result<String, String> {
  let text = crate::event_store::store_read(root.to_string(), domain.to_string())?;
  match resolve_key(root)? {
    Some(km) => decrypt_events_text(&text, &km),
    None => Ok(text),
  }
}

/* ------------------------------------------------------------------ */
/* Migración de archivos (activar / rotar)                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct MigrationReport {
  pub files: usize,
  pub events: usize,
  pub backup_dir: String,
}

fn jsonl_files(root: &str) -> Result<Vec<String>, String> {
  let mut files: Vec<String> = storage::list_dir(root, "events")?
    .into_iter()
    .filter(|name| name.ends_with(".jsonl"))
    .map(|name| format!("events/{name}"))
    .collect();
  files.sort();
  Ok(files)
}

fn file_name(relative: &str) -> &str {
  relative.rsplit('/').next().unwrap_or(relative)
}

/// Copia los archivos de eventos antes de una operación destructiva.
/// Devuelve una ruta relativa a la raíz de datos (`backups/.../events`).
fn backup_events(root: &str) -> Result<String, String> {
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis())
    .unwrap_or(0);
  let backup_dir = format!("backups/pre-encryption-{stamp}/events");
  for src in jsonl_files(root)? {
    let bytes = storage::read_bytes(root, &src)?
      .ok_or_else(|| format!("No se encontró '{src}' al respaldar."))?;
    storage::write_bytes(
      root,
      &format!("{backup_dir}/{}", file_name(&src)),
      &bytes,
    )
    .map_err(|e| format!("No se pudo respaldar {src} antes de cifrar: {e}"))?;
  }
  Ok(backup_dir)
}

/// `true` si la línea es un evento cifrado con el `kid` indicado.
fn line_encrypted_with(line: &str, kid: &str) -> bool {
  serde_json::from_str::<Value>(line)
    .ok()
    .and_then(|event| event.get("payload").and_then(unwrap_encrypted))
    .and_then(|enc| enc.kid)
    .map(|k| k == kid)
    .unwrap_or(false)
}

/// Restaura los eventos desde un respaldo creado por `backup_events`.
///
/// Se usa para revertir una migración que falló a mitad de camino. Cada archivo
/// se escribe de forma atómica en local, para no dejar un `.jsonl` truncado.
fn restore_events(root: &str, backup_dir: &str) -> Result<usize, String> {
  let mut restored = 0usize;
  for name in storage::list_dir(root, backup_dir)? {
    if !name.ends_with(".jsonl") {
      continue;
    }
    let bytes = storage::read_bytes(root, &format!("{backup_dir}/{name}"))?
      .ok_or_else(|| format!("No se encontró el respaldo de '{name}'."))?;
    storage::write_atomic(root, &format!("events/{name}"), &bytes)
      .map_err(|e| format!("No se pudo restaurar '{name}': {e}"))?;
    restored += 1;
  }
  Ok(restored)
}

/// Re-cifra todos los archivos desde `from` (o texto plano si es `None`) hacia `to`.
fn migrate_files(
  root: &str,
  from: Option<&KeyMaterial>,
  to: &KeyMaterial,
) -> Result<(usize, usize), String> {
  let mut total_events = 0usize;
  let mut files = 0usize;
  for relative in jsonl_files(root)? {
    let text = storage::read_string(root, &relative)?
      .ok_or_else(|| format!("No se encontró '{relative}'."))?;
    let mut out = String::with_capacity(text.len() + 256);
    let mut count = 0usize;
    for line in text.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      // En una adopción de llavero puede haber eventos que ya llegaron con la
      // clave nueva: se dejan intactos en vez de intentar descifrarlos con la
      // vieja.
      let already_target = line_encrypted_with(trimmed, &to.kid);
      let plain = if already_target {
        trimmed.to_string()
      } else {
        match from {
          Some(km) => decrypt_event_line_strict(trimmed, km)?,
          None => trimmed.to_string(),
        }
      };
      if already_target {
        out.push_str(&plain);
      } else {
        out.push_str(&encrypt_event_line(&plain, to)?);
      }
      out.push('\n');
      count += 1;
    }
    if count > 0 {
      storage::write_atomic(root, &relative, out.as_bytes())?;
      total_events += count;
      files += 1;
    }
  }
  Ok((files, total_events))
}

/// Verifica que todos los archivos se descifren con la clave nueva.
fn verify_files(root: &str, km: &KeyMaterial) -> Result<usize, String> {
  let mut total = 0usize;
  for relative in jsonl_files(root)? {
    let text = storage::read_string(root, &relative)?
      .ok_or_else(|| format!("No se encontró '{relative}'."))?;
    for line in text.lines() {
      let trimmed = line.trim();
      if trimmed.is_empty() {
        continue;
      }
      decrypt_event_line_strict(trimmed, km)?;
      total += 1;
    }
  }
  Ok(total)
}

/* ------------------------------------------------------------------ */
/* Comandos Tauri                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Serialize)]
pub struct BootState {
  pub enabled: bool,
  pub unlocked: bool,
  pub kid: Option<String>,
}

#[tauri::command]
pub fn crypto_boot_state(root: String) -> Result<BootState, String> {
  let keyring = keys::load(&root)?;
  let km = current_key(&root);
  Ok(BootState {
    enabled: keyring.is_some(),
    unlocked: km.is_some(),
    kid: km
      .map(|k| k.kid.clone())
      .or_else(|| keyring.map(|k| k.kid)),
  })
}

#[derive(Debug, Serialize)]
pub struct EnableResult {
  pub recovery_code: String,
  pub kid: String,
  #[serde(flatten)]
  pub report: MigrationReport,
}

/// Activa el cifrado: crea el llavero, respalda los eventos y los cifra.
#[tauri::command]
pub fn crypto_enable(root: String, password: String) -> Result<EnableResult, String> {
  if keys::exists(&root) {
    return Err("El cifrado ya está activado en este equipo.".to_string());
  }

  let created = keys::create(&password, keys::KdfParams::recommended()?)?;
  let km = KeyMaterial {
    key: created.key,
    kid: created.keyring.kid.clone(),
  };

  let (backup_dir, files, events) = {
    // El lock cubre respaldo + llavero + migración: así el respaldo no pierde
    // un evento agregado en el medio y la reversión es exacta.
    let _guard = crate::event_store::EVENTS_WRITE_LOCK
      .lock()
      .unwrap_or_else(|e| e.into_inner());

    let backup_dir = backup_events(&root)?;

    // El llavero se guarda ANTES de tocar los datos: si la migración se corta,
    // la clave ya existe y los datos siguen siendo recuperables.
    keys::save(&root, &created.keyring)?;
    set_current(&root, km.key, km.kid.clone());

    match migrate_files(&root, None, &km) {
      Ok((files, events)) => {
        // Verificar dentro del lock: si se agrega un evento justo después,
        // el conteo seguiría siendo coherente.
        let verified = verify_files(&root, &km).map_err(|e| {
          format!(
            "El cifrado se activó pero la verificación falló: {e} El respaldo previo está en {backup_dir}."
          )
        })?;
        if verified != events {
          return Err(format!(
            "La verificación falló: se cifraron {events} eventos pero se leyeron {verified}. \
             El respaldo está en {backup_dir}."
          ));
        }
        (backup_dir, files, events)
      }
      Err(e) => {
        // Revertir a texto plano: restaurar desde el respaldo y recién entonces
        // quitar el llavero. Si la restauración falla, el llavero queda para que
        // los archivos ya cifrados sigan siendo legibles.
        return match restore_events(&root, &backup_dir) {
          Ok(restored) => {
            let _ = keys::remove(&root);
            clear_current_for(&root);
            Err(format!(
              "No se pudo activar el cifrado: {e} Se restauraron {restored} archivos y el \
               cifrado no quedó activado. El respaldo previo está en {backup_dir}."
            ))
          }
          Err(re) => Err(format!(
            "No se pudo activar el cifrado: {e} Además falló la restauración automática: {re}. \
             El cifrado quedó activado y el respaldo previo está en {backup_dir}. \
             Reiniciá la app y desbloqueá con tu contraseña."
          )),
        };
      }
    }
  };

  Ok(EnableResult {
    recovery_code: created.recovery_code,
    kid: km.kid.clone(),
    report: MigrationReport {
      files,
      events,
      backup_dir,
    },
  })
}

/// Desbloquea con contraseña maestra o código de recuperación.
#[tauri::command]
pub fn crypto_unlock(root: String, secret: String) -> Result<(), String> {
  let (key, kid) = keys::unlock(&root, &secret)?;
  set_current(&root, key, kid);
  Ok(())
}

/// Borra la clave de memoria. Los datos quedan ilegibles hasta desbloquear.
#[tauri::command]
pub fn crypto_lock() -> Result<(), String> {
  clear_current();
  Ok(())
}

/// `true` si hay una clave desbloqueada en memoria.
#[tauri::command]
pub fn crypto_status() -> Result<bool, String> {
  Ok(is_unlocked())
}

/// Cambia la contraseña re-envolviendo la misma DEK (sin re-cifrar eventos).
#[tauri::command]
pub fn crypto_change_password(
  root: String,
  current_secret: String,
  new_password: String,
) -> Result<(), String> {
  keys::change_password(&root, &current_secret, &new_password)?;
  let (key, kid) = keys::unlock(&root, &new_password)?;
  set_current(&root, key, kid);
  Ok(())
}

#[derive(Debug, Serialize)]
pub struct RotateResult {
  pub recovery_code: String,
  pub kid: String,
  #[serde(flatten)]
  pub report: MigrationReport,
}

/// Genera una DEK nueva, re-cifra todos los eventos y reemplaza el llavero.
/// Es la operación recomendada al revocar un equipo.
#[tauri::command]
pub fn crypto_rotate(
  root: String,
  current_secret: String,
  new_password: String,
) -> Result<RotateResult, String> {
  let (old_key, old_kid) = keys::unlock(&root, &current_secret)?;
  let old = KeyMaterial {
    key: old_key,
    kid: old_kid,
  };
  let fresh = keys::create_rotated(&new_password, keys::KdfParams::recommended()?)?;
  let new_km = KeyMaterial {
    key: fresh.key,
    kid: fresh.keyring.kid.clone(),
  };
  let (backup_dir, files, events) = {
    // Lock desde el respaldo hasta el commit: un append concurrente no puede
    // quedar fuera del respaldo y perderse en una reversión.
    let _guard = crate::event_store::EVENTS_WRITE_LOCK
      .lock()
      .unwrap_or_else(|e| e.into_inner());

    let backup_dir = backup_events(&root)?;
    // El llavero nuevo se escribe ANTES de migrar: si falta espacio, falla acá y
    // los datos quedan intactos. Activarlo después es solo un rename.
    keys::stage(&root, &fresh.keyring)?;

    match migrate_files(&root, Some(&old), &new_km) {
      Ok((files, events)) => match keys::commit_staged(&root) {
        Ok(()) => {
          set_current(&root, new_km.key, new_km.kid.clone());
          // Verificar bajo el mismo lock para que un append concurrente no
          // invalide el conteo.
          let verified = verify_files(&root, &new_km).map_err(|e| {
            format!(
              "La clave se rotó pero la verificación falló: {e} El respaldo previo está en {backup_dir}."
            )
          })?;
          if verified != events {
            return Err(format!(
              "La rotación quedó incompleta: se re-cifraron {events} eventos pero se leyeron {verified}. \
               El respaldo está en {backup_dir}."
            ));
          }
          (backup_dir, files, events)
        }
        Err(e) => {
          return match restore_events(&root, &backup_dir) {
            Ok(restored) => {
              keys::discard_staged(&root);
              Err(format!(
                "No se pudo activar el llavero nuevo: {e} Se restauraron {restored} archivos con la \
                 clave anterior. El respaldo previo está en {backup_dir}."
              ))
            }
            Err(re) => Err(format!(
              "No se pudo activar el llavero nuevo: {e} y la restauración automática falló: {re}. \
               El llavero nuevo quedó en {:?}. El respaldo previo está en {backup_dir}.",
              keys::staged_path(&root)
            )),
          };
        }
      },
      Err(e) => {
        keys::discard_staged(&root);
        return match restore_events(&root, &backup_dir) {
          Ok(restored) => Err(format!(
            "No se pudo rotar la clave: {e} Se restauraron {restored} archivos con la clave \
             anterior. El respaldo previo está en {backup_dir}."
          )),
          Err(re) => Err(format!(
            "No se pudo rotar la clave: {e} Además falló la restauración automática: {re}. \
             El respaldo previo está en {backup_dir}."
          )),
        };
      }
    }
  };

  Ok(RotateResult {
    recovery_code: fresh.recovery_code,
    kid: new_km.kid.clone(),
    report: MigrationReport {
      files,
      events,
      backup_dir,
    },
  })
}

/// Los comandos de diagnóstico solo existen en builds de desarrollo. En una
/// release no queremos exponer un oráculo de cifrado/descifrado por IPC.
fn ensure_diagnostics_enabled() -> Result<(), String> {
  if cfg!(debug_assertions) {
    Ok(())
  } else {
    Err("Los comandos de diagnóstico criptográfico están deshabilitados en producción.".to_string())
  }
}

/// Diagnóstico: cifra un texto con la clave actual y devuelve `ciphertext:nonce`.
#[tauri::command]
pub fn crypto_encrypt_text(root: String, plaintext: String) -> Result<String, String> {
  ensure_diagnostics_enabled()?;
  let km = current_key(&root).ok_or_else(|| locked_error())?;
  let (ciphertext, nonce) = encrypt_payload(&Value::String(plaintext), &km.key, b"")?;
  Ok(format!("{ciphertext}:{nonce}"))
}

/// Diagnóstico: descifra el formato `ciphertext:nonce`.
#[tauri::command]
pub fn crypto_decrypt_text(root: String, encrypted: String) -> Result<String, String> {
  ensure_diagnostics_enabled()?;
  let km = current_key(&root).ok_or_else(|| locked_error())?;
  let (ciphertext, nonce) = encrypted
    .split_once(':')
    .ok_or_else(|| "Formato inválido. Se esperaba ciphertext:nonce".to_string())?;
  let value = decrypt_payload(ciphertext, nonce, &km.key, b"")?;
  value
    .as_str()
    .map(str::to_string)
    .ok_or_else(|| "El valor descifrado no es texto.".to_string())
}

/// Flujo Write de diagnóstico: cifra y hace append al JSONL del dominio.
#[tauri::command]
pub fn crypto_append_event(root: String, domain: String, event_json: String) -> Result<(), String> {
  ensure_diagnostics_enabled()?;
  let km = resolve_key(&root)?.ok_or_else(|| {
    "El cifrado no está activado. Activá el cifrado en Ajustes.".to_string()
  })?;
  append_event_encrypted(&root, &domain, &event_json, &km)
}

/// Flujo Read de diagnóstico: lee y descifra el JSONL del dominio.
#[tauri::command]
pub fn crypto_read_events(root: String, domain: String) -> Result<String, String> {
  ensure_diagnostics_enabled()?;
  read_events_decrypted(&root, &domain)
}

/// Devuelve el llavero (ya envuelto; no contiene la contraseña) para llevarlo
/// a otro equipo. Sin él, la misma contraseña en otro equipo crearía una DEK
/// distinta y los datos no se podrían descifrar por `kid` incompatible.
#[tauri::command]
pub fn crypto_keyring_json(root: String) -> Result<String, String> {
  let keyring = keys::load(&root)?.ok_or_else(|| {
    "El cifrado no está activado en este equipo; no hay llavero para exportar.".to_string()
  })?;
  serde_json::to_string_pretty(&keyring)
    .map_err(|e| format!("No se pudo serializar el llavero: {e}"))
}

/// Importa el llavero de otro equipo (o de un respaldo) y lo desbloquea.
/// Solo se permite cuando este equipo todavía no tiene cifrado activado.
///
/// Si el equipo ya tenía eventos en texto plano (por ejemplo, una copia
/// restaurada a mano), los cifra con la clave importada, con respaldo previo.
#[tauri::command]
pub fn crypto_import_keyring(
  root: String,
  keyring_json: String,
  secret: String,
) -> Result<MigrationReport, String> {
  if keys::exists(&root) {
    return Err(
      "Este equipo ya tiene el cifrado activado. Para usar la clave de otro equipo hay que adoptar su llavero (Ajustes > Cifrado > Adoptar llavero)."
        .to_string(),
    );
  }
  let keyring = keys::parse(&keyring_json)?;
  // Verifica el secreto antes de guardar: evita dejar un llavero inutilizable.
  let key = keys::unwrap(&keyring, &secret)?;
  let km = KeyMaterial {
    key,
    kid: keyring.kid.clone(),
  };

  let (backup_dir, files, events) = {
    // Lock desde la comprobación hasta la verificación de la migración.
    let _guard = crate::event_store::EVENTS_WRITE_LOCK
      .lock()
      .unwrap_or_else(|e| e.into_inner());

    if jsonl_files(&root)?.is_empty() {
      keys::save(&root, &keyring)?;
      set_current(&root, km.key, km.kid.clone());
      return Ok(MigrationReport {
        files: 0,
        events: 0,
        backup_dir: String::new(),
      });
    }

    let backup_dir = backup_events(&root)?;
    keys::save(&root, &keyring)?;
    set_current(&root, km.key, km.kid.clone());

    match migrate_files(&root, None, &km) {
      Ok((files, events)) => {
        let verified = verify_files(&root, &km).map_err(|e| {
          format!(
            "El llavero se importó pero la verificación falló: {e} El respaldo previo está en {backup_dir}."
          )
        })?;
        if verified != events {
          return Err(format!(
            "La importación quedó incompleta: se cifraron {events} eventos pero se leyeron {verified}. \
             El respaldo está en {backup_dir}."
          ));
        }
        (backup_dir, files, events)
      }
      Err(e) => {
        return match restore_events(&root, &backup_dir) {
          Ok(restored) => {
            let _ = keys::remove(&root);
            clear_current_for(&root);
            Err(format!(
              "No se pudo importar el llavero: {e} Se restauraron {restored} archivos y el cifrado \
               no quedó activado. El respaldo previo está en {backup_dir}."
            ))
          }
          Err(re) => Err(format!(
            "No se pudo importar el llavero: {e} Además falló la restauración automática: {re}. \
             El cifrado quedó activado y el respaldo previo está en {backup_dir}. \
             Reiniciá la app y desbloqueá con la contraseña importada."
          )),
        };
      }
    }
  };

  Ok(MigrationReport {
    files,
    events,
    backup_dir,
  })
}

/// Adopta el llavero de otro equipo en un equipo que ya tenía cifrado.
///
/// Es el paso que deben hacer los equipos legítimos después de una rotación:
/// descifra los eventos locales con la clave vieja, guarda el llavero nuevo y
/// los vuelve a cifrar con la clave nueva. Los eventos que ya llegaron con la
/// clave nueva se dejan intactos.
#[tauri::command]
pub fn crypto_adopt_keyring(
  root: String,
  keyring_json: String,
  current_secret: String,
  new_secret: String,
) -> Result<MigrationReport, String> {
  let (old_key, old_kid) = keys::unlock(&root, &current_secret)?;
  let old = KeyMaterial {
    key: old_key,
    kid: old_kid,
  };
  let new_keyring = keys::parse(&keyring_json)?;
  if new_keyring.kid == old.kid {
    return Err("El llavero elegido es la misma clave que ya usa este equipo.".to_string());
  }
  let new_key = keys::unwrap(&new_keyring, &new_secret)?;
  let new_km = KeyMaterial {
    key: new_key,
    kid: new_keyring.kid.clone(),
  };

  let (backup_dir, files, events) = {
    // Igual que en la rotación: lock desde el respaldo hasta el commit.
    let _guard = crate::event_store::EVENTS_WRITE_LOCK
      .lock()
      .unwrap_or_else(|e| e.into_inner());

    let backup_dir = backup_events(&root)?;
    // Llavero nuevo preparado antes de migrar.
    keys::stage(&root, &new_keyring)?;

    match migrate_files(&root, Some(&old), &new_km) {
      Ok((files, events)) => match keys::commit_staged(&root) {
        Ok(()) => {
          set_current(&root, new_km.key, new_km.kid.clone());
          let verified = verify_files(&root, &new_km).map_err(|e| {
            format!(
              "El llavero se adoptó pero la verificación falló: {e} El respaldo previo está en {backup_dir}."
            )
          })?;
          if verified != events {
            return Err(format!(
              "La adopción quedó incompleta: se procesaron {events} eventos pero se leyeron {verified}. \
               El respaldo está en {backup_dir}."
            ));
          }
          (backup_dir, files, events)
        }
        Err(e) => {
          return match restore_events(&root, &backup_dir) {
            Ok(restored) => {
              keys::discard_staged(&root);
              Err(format!(
                "No se pudo activar el llavero adoptado: {e} Se restauraron {restored} archivos con \
                 la clave anterior. El respaldo previo está en {backup_dir}."
              ))
            }
            Err(re) => Err(format!(
              "No se pudo activar el llavero adoptado: {e} y la restauración automática falló: {re}. \
               El llavero nuevo quedó en {:?}. El respaldo previo está en {backup_dir}.",
              keys::staged_path(&root)
            )),
          };
        }
      },
      Err(e) => {
        keys::discard_staged(&root);
        return match restore_events(&root, &backup_dir) {
          Ok(restored) => Err(format!(
            "No se pudo adoptar el llavero: {e} Se restauraron {restored} archivos con la clave \
             anterior. El respaldo previo está en {backup_dir}."
          )),
          Err(re) => Err(format!(
            "No se pudo adoptar el llavero: {e} Además falló la restauración automática: {re}. \
             El respaldo previo está en {backup_dir}."
          )),
        };
      }
    }
  };

  Ok(MigrationReport {
    files,
    events,
    backup_dir,
  })
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;
  use std::path::Path;

  fn temp_root(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir()
      .join(format!("inventario-crypto-{tag}-{nanos}"))
      .to_string_lossy()
      .to_string()
  }

  fn km(password: &str, root: &str) -> KeyMaterial {
    let created = keys::create(password, keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(root, &created.keyring).unwrap();
    KeyMaterial {
      key: created.key,
      kid: created.keyring.kid,
    }
  }

  fn sample_event(id: &str, event_type: &str) -> String {
    serde_json::json!({
      "id": id,
      "type": event_type,
      "payload": { "customer": "Ana Gómez", "total": 12345, "items": 2 },
      "metadata": {
        "hlc": 1793122609026000i64,
        "deviceId": "device-test",
        "timestamp": 1793122609026i64,
        "version": 1
      }
    })
    .to_string()
  }

  /// Escribe texto plano directamente, simulando datos de una versión previa.
  fn write_plain_event(root: &str, domain: &str, event: &str) {
    let dir = Path::new(root).join("events");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(format!("{domain}.jsonl")), format!("{event}\n")).unwrap();
  }

  #[test]
  fn encrypt_decrypt_roundtrip_with_aad() {
    let key = [7u8; 32];
    let payload = serde_json::json!({ "secret": "data", "amount": 100 });
    let aad = event_aad("id-1", "Order.Created");
    let (ciphertext, nonce) = encrypt_payload(&payload, &key, &aad).unwrap();
    assert_eq!(
      decrypt_payload(&ciphertext, &nonce, &key, &aad).unwrap(),
      payload
    );
  }

  #[test]
  fn aad_binds_payload_to_event_identity() {
    let key = [7u8; 32];
    let payload = serde_json::json!({ "secret": "data" });
    let (ciphertext, nonce) =
      encrypt_payload(&payload, &key, &event_aad("id-1", "Order.Created")).unwrap();
    // Mover el ciphertext a otro id debe fallar la autenticación.
    assert!(decrypt_payload(
      &ciphertext,
      &nonce,
      &key,
      &event_aad("id-2", "Order.Created")
    )
    .is_err());
  }

  #[test]
  fn decrypt_with_wrong_key_fails() {
    let payload = serde_json::json!({ "secret": "data" });
    let (ciphertext, nonce) = encrypt_payload(&payload, &[1u8; 32], b"aad").unwrap();
    assert!(decrypt_payload(&ciphertext, &nonce, &[2u8; 32], b"aad").is_err());
  }

  #[test]
  fn wrap_and_unwrap_encrypted_payload() {
    let wrapped = wrap_encrypted("abc123", "nonce456", "kid-1");
    let enc = unwrap_encrypted(&wrapped).unwrap();
    assert_eq!(enc.data, "abc123");
    assert_eq!(enc.nonce, "nonce456");
    assert_eq!(enc.kid.as_deref(), Some("kid-1"));
  }

  #[test]
  fn unwrap_plain_payload_returns_none() {
    assert!(unwrap_encrypted(&serde_json::json!({ "total": 100 })).is_none());
  }

  #[test]
  fn legacy_encrypted_payload_is_rejected_for_a_v2_keyring() {
    let km = KeyMaterial {
      key: [1u8; 32],
      kid: "kid-v2".to_string(),
    };
    // Formato 0.1.x: `_encrypted` sin `kid`.
    let payload = serde_json::json!({
      "_encrypted": true,
      "alg": "XChaCha20-Poly1305",
      "data": "abc",
      "nonce": "def"
    });
    let err = ensure_compatible_payload(&payload, &km).unwrap_err();
    assert!(err.contains("formato viejo"), "mensaje inesperado: {err}");

    // Un payload v2 con la misma clave sí se acepta.
    let same = wrap_encrypted("abc", "def", &km.kid);
    assert!(ensure_compatible_payload(&same, &km).is_ok());
  }

  #[test]
  fn encrypt_event_line_keeps_metadata_in_plaintext() {
    let root = temp_root("metadata");
    let key = km("clave-de-prueba", &root);
    let line =
      encrypt_event_line(&sample_event("evt-1", "Order.Created"), &key).unwrap();

    assert!(!line.contains("Ana Gómez"));
    assert!(!line.contains("12345"));

    let event: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(event["id"], "evt-1");
    assert_eq!(event["type"], "Order.Created");
    assert_eq!(event["metadata"]["deviceId"], "device-test");
    assert_eq!(event["metadata"]["hlc"], 1793122609026000i64);
    assert_eq!(event["payload"]["_encrypted"], true);
    assert_eq!(event["payload"]["kid"], key.kid);

    // Idempotente.
    let again = encrypt_event_line(&line, &key).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&again).unwrap(), event);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn encrypt_event_line_rejects_invalid_json() {
    let root = temp_root("bad-json");
    let key = km("clave-de-prueba", &root);
    assert!(encrypt_event_line("no-es-json", &key).is_err());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn file_roundtrip_encrypts_at_rest_and_decrypts_on_read() {
    let root = temp_root("roundtrip");
    let km = km("clave-de-prueba", &root);
    set_current(&root, km.key, km.kid.clone());
    let domain = "orders";
    let id = "0192f3a4-0000-7000-8000-000000000001";

    append_event_encrypted(&root, domain, &sample_event(id, "Order.Created"), &km).unwrap();

    let raw = std::fs::read_to_string(
      Path::new(&root).join("events").join("orders.jsonl"),
    )
    .unwrap();
    assert!(raw.contains("\"_encrypted\":true"));
    assert!(!raw.contains("Ana Gómez"));

    let plain = read_events_decrypted(&root, domain).unwrap();
    let event: Value = serde_json::from_str(plain.trim()).unwrap();
    assert_eq!(event["payload"]["customer"], "Ana Gómez");
    assert_eq!(event["payload"]["total"], 12345);
    assert_eq!(event["id"], id);

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn read_with_wrong_key_marks_error_without_losing_metadata() {
    let root = temp_root("wrong-key");
    let good = km("clave-correcta", &root);
    let bad = KeyMaterial {
      key: [9u8; 32],
      kid: keys::kid_for(&[9u8; 32]),
    };
    let domain = "orders";
    set_current(&root, good.key, good.kid.clone());
    append_event_encrypted(&root, domain, &sample_event("evt-1", "Order.Created"), &good)
      .unwrap();

    let plain = decrypt_events_text(
      &std::fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap(),
      &bad,
    )
    .unwrap();
    let event: Value = serde_json::from_str(plain.trim()).unwrap();
    assert!(event["payload"]["_error"].is_string());
    assert_eq!(event["payload"]["_encrypted"], true);
    assert_eq!(event["id"], "evt-1");

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn encrypted_event_cannot_be_moved_to_another_id() {
    let root = temp_root("tamper");
    let km = km("clave-de-prueba", &root);
    let line = encrypt_event_line(&sample_event("evt-1", "Order.Created"), &km).unwrap();
    let mut event: Value = serde_json::from_str(&line).unwrap();
    event["id"] = Value::String("evt-2".to_string());

    let decrypted = decrypt_event_line(&event.to_string(), &km).unwrap();
    let out: Value = serde_json::from_str(&decrypted).unwrap();
    assert!(out["payload"]["_error"].is_string());

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn plaintext_events_still_readable_with_key() {
    let root = temp_root("plaintext");
    let km = km("clave-de-prueba", &root);
    set_current(&root, km.key, km.kid.clone());
    let domain = "orders";

    write_plain_event(&root, domain, &sample_event("evt-1", "Order.Created"));

    let plain = read_events_decrypted(&root, domain).unwrap();
    let event: Value = serde_json::from_str(plain.trim()).unwrap();
    assert_eq!(event["payload"]["customer"], "Ana Gómez");
    assert!(unwrap_encrypted(&event["payload"]).is_none());

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn reading_missing_domain_returns_empty_text() {
    let root = temp_root("missing");
    let _ = km("clave-de-prueba", &root);
    set_current(&root, [7u8; 32], "kid".to_string());
    assert_eq!(read_events_decrypted(&root, "orders").unwrap(), "");
    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn reading_without_keyring_fails_with_not_setup() {
    let root = temp_root("not-setup");
    let err = read_events_decrypted(&root, "orders").unwrap_err();
    assert!(err.starts_with(NOT_SETUP_PREFIX), "mensaje inesperado: {err}");
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn enable_migrates_existing_plaintext_events() {
    let root = temp_root("enable");
    let domain = "orders";
    write_plain_event(&root, domain, &sample_event("evt-1", "Order.Created"));

    let result = crypto_enable(root.clone(), "contraseña-segura".to_string()).unwrap();
    assert_eq!(result.report.events, 1);
    assert!(Path::new(&root)
      .join(&result.report.backup_dir)
      .join("orders.jsonl")
      .exists());
    assert_eq!(result.kid, keys::kid_for(&current_key(&root).unwrap().key));

    // En disco ya no hay texto plano.
    let raw =
      std::fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap();
    assert!(!raw.contains("Ana Gómez"));

    // Y se puede leer con la clave en RAM.
    let plain = read_events_decrypted(&root, domain).unwrap();
    assert!(plain.contains("Ana Gómez"));

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn restore_events_reverts_to_the_backup_copy() {
    let root = temp_root("restore");
    let domain = "orders";
    write_plain_event(&root, domain, &sample_event("evt-1", "Order.Created"));
    let backup_dir = backup_events(&root).unwrap();

    // Simular una migración parcial: el archivo quedó a medias.
    fs::write(
      Path::new(&root).join("events/orders.jsonl"),
      "{\"roto\":true}\n",
    )
    .unwrap();

    let restored = restore_events(&root, &backup_dir).unwrap();
    assert_eq!(restored, 1);
    let text = fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap();
    assert!(text.contains("Ana Gómez"));

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn store_read_and_append_are_transparent_when_enabled() {
    let root = temp_root("transparent");
    crypto_enable(root.clone(), "contraseña-segura".to_string()).unwrap();
    let domain = "orders";
    let id = "evt-transparent";

    crate::event_store::store_append(
      root.clone(),
      domain.to_string(),
      vec![sample_event(id, "Order.Created")],
    )
    .unwrap();

    let raw =
      std::fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap();
    assert!(!raw.contains("Ana Gómez"));

    let plain = crate::event_store::store_read(root.clone(), domain.to_string()).unwrap();
    assert!(plain.contains("Ana Gómez"));
    assert!(plain.contains(id));

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn locked_reads_and_writes_fail_with_recognizable_error() {
    let root = temp_root("locked");
    crypto_enable(root.clone(), "contraseña-segura".to_string()).unwrap();
    clear_current_for(&root);

    let read_err = crate::event_store::store_read(root.clone(), "orders".to_string())
      .unwrap_err();
    assert!(read_err.starts_with(LOCKED_PREFIX));

    let write_err = crate::event_store::store_append(
      root.clone(),
      "orders".to_string(),
      vec![sample_event("evt-1", "Order.Created")],
    )
    .unwrap_err();
    assert!(write_err.starts_with(LOCKED_PREFIX));

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn unlock_restores_reads_after_lock() {
    let root = temp_root("unlock");
    let created =
      keys::create("contraseña-segura", keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(&root, &created.keyring).unwrap();
    set_current(&root, created.key, created.keyring.kid.clone());
    let domain = "orders";
    crate::event_store::store_append(
      root.clone(),
      domain.to_string(),
      vec![sample_event("evt-1", "Order.Created")],
    )
    .unwrap();
    clear_current_for(&root);

    crypto_unlock(root.clone(), "contraseña-segura".to_string()).unwrap();
    let plain = crate::event_store::store_read(root.clone(), domain.to_string()).unwrap();
    assert!(plain.contains("Ana Gómez"));

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn rotate_reencrypts_with_new_key_and_invalidates_old() {
    let root = temp_root("rotate");
    let created =
      keys::create("contraseña-vieja", keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(&root, &created.keyring).unwrap();
    set_current(&root, created.key, created.keyring.kid.clone());
    let domain = "orders";
    crate::event_store::store_append(
      root.clone(),
      domain.to_string(),
      vec![sample_event("evt-1", "Order.Created")],
    )
    .unwrap();

    let old_key = created.key;
    let result = crypto_rotate(
      root.clone(),
      "contraseña-vieja".to_string(),
      "contraseña-nueva".to_string(),
    )
    .unwrap();
    assert_ne!(result.kid, keys::kid_for(&old_key));
    assert_eq!(result.report.events, 1);

    // La contraseña vieja ya no abre el llavero.
    assert!(keys::unlock(&root, "contraseña-vieja").is_err());
    let (new_key, _) = keys::unlock(&root, "contraseña-nueva").unwrap();
    assert_ne!(new_key, old_key);

    // Los datos se leen con la clave nueva.
    let plain = crate::event_store::store_read(root.clone(), domain.to_string()).unwrap();
    assert!(plain.contains("Ana Gómez"));

    // Y el código de recuperación nuevo también abre.
    let (recovered, _) = keys::unlock(&root, &result.recovery_code).unwrap();
    assert_eq!(recovered, new_key);

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn change_password_does_not_require_reencryption() {
    let root = temp_root("change-pw");
    crypto_enable(root.clone(), "contraseña-vieja".to_string()).unwrap();
    let raw_before =
      std::fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap_or_default();

    crypto_change_password(
      root.clone(),
      "contraseña-vieja".to_string(),
      "contraseña-nueva".to_string(),
    )
    .unwrap();

    let raw_after =
      std::fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap_or_default();
    assert_eq!(raw_before, raw_after);
    assert!(keys::unlock(&root, "contraseña-vieja").is_err());
    assert!(keys::unlock(&root, "contraseña-nueva").is_ok());

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn boot_state_reports_enabled_and_locked() {
    let root = temp_root("boot");
    let state = crypto_boot_state(root.clone()).unwrap();
    assert!(!state.enabled);
    assert!(!state.unlocked);

    crypto_enable(root.clone(), "contraseña-segura".to_string()).unwrap();
    let state = crypto_boot_state(root.clone()).unwrap();
    assert!(state.enabled);
    assert!(state.unlocked);
    assert!(state.kid.is_some());

    clear_current_for(&root);
    let state = crypto_boot_state(root.clone()).unwrap();
    assert!(state.enabled);
    assert!(!state.unlocked);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn import_keyring_shares_the_same_dek_between_devices() {
    let root_a = temp_root("import-a");
    let root_b = temp_root("import-b");
    let created =
      keys::create("contraseña-segura", keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(&root_a, &created.keyring).unwrap();
    set_current(&root_a, created.key, created.keyring.kid.clone());
    append_event_encrypted(
      &root_a,
      "orders",
      &sample_event("evt-1", "Order.Created"),
      &KeyMaterial {
        key: created.key,
        kid: created.keyring.kid.clone(),
      },
    )
    .unwrap();

    // "Otro equipo": importa el llavero y recibe el archivo cifrado tal cual.
    fs::create_dir_all(&root_b).unwrap();
    let keyring_json = serde_json::to_string_pretty(&created.keyring).unwrap();
    crypto_import_keyring(
      root_b.clone(),
      keyring_json.clone(),
      "contraseña-segura".to_string(),
    )
    .unwrap();

    fs::create_dir_all(Path::new(&root_b).join("events")).unwrap();
    fs::copy(
      Path::new(&root_a).join("events/orders.jsonl"),
      Path::new(&root_b).join("events/orders.jsonl"),
    )
    .unwrap();

    let plain = read_events_decrypted(&root_b, "orders").unwrap();
    assert!(plain.contains("Ana Gómez"));

    // Un secreto incorrecto no permite importar.
    let root_c = temp_root("import-c");
    fs::create_dir_all(&root_c).unwrap();
    assert!(crypto_import_keyring(
      root_c.clone(),
      keyring_json,
      "incorrecta".to_string(),
    )
    .is_err());
    assert!(!keys::exists(&root_c));

    clear_current_for(&root_a);
    clear_current_for(&root_b);
    let _ = fs::remove_dir_all(&root_a);
    let _ = fs::remove_dir_all(&root_b);
    let _ = fs::remove_dir_all(&root_c);
  }

  #[test]
  fn import_keyring_encrypts_preexisting_plaintext_events() {
    let root = temp_root("import-plain");
    let domain = "orders";
    write_plain_event(&root, domain, &sample_event("evt-1", "Order.Created"));

    let created =
      keys::create("contraseña-segura", keys::KdfParams::fast().unwrap()).unwrap();
    let report = crypto_import_keyring(
      root.clone(),
      serde_json::to_string_pretty(&created.keyring).unwrap(),
      "contraseña-segura".to_string(),
    )
    .unwrap();
    assert_eq!(report.events, 1);
    assert!(Path::new(&root)
      .join(&report.backup_dir)
      .join("orders.jsonl")
      .exists());

    let raw = fs::read_to_string(Path::new(&root).join("events/orders.jsonl")).unwrap();
    assert!(!raw.contains("Ana Gómez"));
    assert!(read_events_decrypted(&root, domain)
      .unwrap()
      .contains("Ana Gómez"));

    clear_current_for(&root);
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn adopt_keyring_reencrypts_after_rotation() {
    // Equipo A: crea la clave original y un evento.
    let root_a = temp_root("adopt-a");
    let created =
      keys::create("contraseña-vieja", keys::KdfParams::fast().unwrap()).unwrap();
    keys::save(&root_a, &created.keyring).unwrap();
    set_current(&root_a, created.key, created.keyring.kid.clone());
    let domain = "orders";
    crate::event_store::store_append(
      root_a.clone(),
      domain.to_string(),
      vec![sample_event("evt-1", "Order.Created")],
    )
    .unwrap();

    // Equipo B arranca con el llavero ORIGINAL y el mismo evento cifrado.
    let root_b = temp_root("adopt-b");
    fs::create_dir_all(&root_b).unwrap();
    crypto_import_keyring(
      root_b.clone(),
      serde_json::to_string_pretty(&created.keyring).unwrap(),
      "contraseña-vieja".to_string(),
    )
    .unwrap();
    fs::create_dir_all(Path::new(&root_b).join("events")).unwrap();
    fs::copy(
      Path::new(&root_a).join("events/orders.jsonl"),
      Path::new(&root_b).join("events/orders.jsonl"),
    )
    .unwrap();

    // A rota la clave y exporta el llavero nuevo.
    let rotated = crypto_rotate(
      root_a.clone(),
      "contraseña-vieja".to_string(),
      "contraseña-nueva".to_string(),
    )
    .unwrap();
    let new_ring = serde_json::to_string_pretty(&keys::load(&root_a).unwrap().unwrap())
      .unwrap();

    // B adopta el llavero nuevo: sus eventos viejos se re-cifran con la clave nueva.
    let report = crypto_adopt_keyring(
      root_b.clone(),
      new_ring,
      "contraseña-vieja".to_string(),
      "contraseña-nueva".to_string(),
    )
    .unwrap();
    assert_eq!(report.events, 1);

    let plain = read_events_decrypted(&root_b, domain).unwrap();
    assert!(plain.contains("Ana Gómez"));

    let state_a = crypto_boot_state(root_a.clone()).unwrap();
    let state_b = crypto_boot_state(root_b.clone()).unwrap();
    assert_eq!(state_a.kid, state_b.kid);
    assert_eq!(state_a.kid.as_deref(), Some(rotated.kid.as_str()));

    // B puede escribir con la clave nueva y A lo lee (mismo llavero).
    crate::event_store::store_append(
      root_b.clone(),
      domain.to_string(),
      vec![sample_event("evt-2", "Order.Created")],
    )
    .unwrap();
    fs::copy(
      Path::new(&root_b).join("events/orders.jsonl"),
      Path::new(&root_a).join("events/orders.jsonl"),
    )
    .unwrap();
    let plain_a = read_events_decrypted(&root_a, domain).unwrap();
    assert!(plain_a.contains("evt-2"));

    clear_current_for(&root_a);
    clear_current_for(&root_b);
    let _ = fs::remove_dir_all(&root_a);
    let _ = fs::remove_dir_all(&root_b);
  }

  #[test]
  #[ignore = "auditoría manual sobre una copia de datos reales (INVENTARIO_REAL_ROOT)"]
  fn audit_real_data_copy_if_configured() {
    let Ok(root) = std::env::var("INVENTARIO_REAL_ROOT") else {
      return;
    };
    if root.trim().is_empty() {
      return;
    }
    let before: usize = jsonl_files(&root)
      .unwrap()
      .iter()
      .map(|p| {
        fs::read_to_string(p)
          .unwrap()
          .lines()
          .filter(|l| !l.trim().is_empty())
          .count()
      })
      .sum();
    assert!(before > 0, "la copia de auditoría no tiene eventos");

    let password = "auditoria-cifrado-2026";
    let result = crypto_enable(root.clone(), password.to_string()).unwrap();
    assert_eq!(result.report.events, before);
    assert!(Path::new(&root).join(&result.report.backup_dir).exists());

    // Ninguna línea debe quedar con payload en texto plano.
    for path in jsonl_files(&root).unwrap() {
      for line in fs::read_to_string(&path).unwrap().lines() {
        let line = line.trim();
        if line.is_empty() {
          continue;
        }
        let event: Value = serde_json::from_str(line).unwrap();
        assert_eq!(event["payload"]["_encrypted"], true, "{path:?}");
        assert_eq!(event["payload"]["kid"], result.kid);
      }
    }

    // Bloquear y volver a abrir con la contraseña.
    clear_current_for(&root);
    crypto_unlock(root.clone(), password.to_string()).unwrap();
    let mut decrypted = 0usize;
    for domain in [
      "collections", "products", "colors", "variants", "customers", "orders",
      "order_lines", "payments", "production_orders", "production_lines",
      "stock_movements", "expenses", "settings", "device_info",
    ] {
      let text = crate::event_store::store_read(root.clone(), domain.to_string()).unwrap();
      assert!(!text.contains("\"_error\""), "error al descifrar {domain}");
      decrypted += text.lines().filter(|l| !l.trim().is_empty()).count();
    }
    assert_eq!(decrypted, before);

    clear_current_for(&root);
  }

  #[test]
  fn legacy_ciphertext_without_kid_still_decrypts() {
    let root = temp_root("legacy");
    let km = km("clave-de-prueba", &root);
    let payload = serde_json::json!({ "customer": "Ana Gómez" });
    let (ciphertext, nonce) = encrypt_payload(&payload, &km.key, b"").unwrap();
    let line = serde_json::json!({
      "id": "evt-legacy",
      "type": "Order.Created",
      "payload": wrap_encrypted(&ciphertext, &nonce, ""),
      "metadata": { "hlc": 1, "deviceId": "d", "timestamp": 1, "version": 1 }
    })
    .to_string();
    // Simula el formato viejo: sin `kid`.
    let mut old: Value = serde_json::from_str(&line).unwrap();
    old["payload"].as_object_mut().unwrap().remove("kid");

    let decrypted = decrypt_event_line(&old.to_string(), &km).unwrap();
    let out: Value = serde_json::from_str(&decrypted).unwrap();
    assert_eq!(out["payload"]["customer"], "Ana Gómez");
    assert!(out["payload"]["_error"].is_null());

    let _ = fs::remove_dir_all(&root);
  }
}
