use base64::{Engine, engine::general_purpose::STANDARD};
use chacha20poly1305::{
  aead::{Aead, KeyInit},
  XChaCha20Poly1305, XNonce,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

/* ------------------------------------------------------------------ */
/* Estado criptográfico (solo en RAM)                                 */
/* ------------------------------------------------------------------ */

#[derive(Default)]
pub struct CryptoState {
  key: Mutex<Option<[u8; 32]>>,
}

impl CryptoState {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn set_key(&self, key: [u8; 32]) {
    *self.key.lock().unwrap_or_else(|e| e.into_inner()) = Some(key);
  }

  pub fn clear_key(&self) {
    *self.key.lock().unwrap_or_else(|e| e.into_inner()) = None;
  }

  pub fn has_key(&self) -> bool {
    self.key.lock().unwrap_or_else(|e| e.into_inner()).is_some()
  }

  pub fn get_key(&self) -> Result<[u8; 32], String> {
    self
      .key
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .ok_or_else(|| "Llave no inicializada. Desbloquea primero con la contraseña maestra.".to_string())
  }
}

/* ------------------------------------------------------------------ */
/* Derivación de llave (Argon2)                                       */
/* ------------------------------------------------------------------ */

/// Deriva una llave de 32 bytes a partir de una contraseña maestra usando Argon2id.
pub fn derive_key(password: &str) -> Result<[u8; 32], String> {
  use argon2::{Argon2, PasswordHasher};
  // Salt fijo por aplicación (en producción idealmente por dispositivo, pero
  // para Event Sourcing local es aceptable y simplifica la recuperación).
  let salt = b"inventario-tienda-v1-salt";
  let mut key = [0u8; 32];
  Argon2::default()
    .hash_password_into(password.as_bytes(), salt, &mut key)
    .map_err(|e| format!("Error derivando llave con Argon2: {e}"))?;
  Ok(key)
}

/* ------------------------------------------------------------------ */
/* Cifrado / Descifrado (XChaCha20-Poly1305)                          */
/* ------------------------------------------------------------------ */

/// Cifra un payload JSON y devuelve (ciphertext_base64, nonce_base64).
pub fn encrypt_payload(
  payload: &serde_json::Value,
  key: &[u8; 32],
) -> Result<(String, String), String> {
  let cipher = XChaCha20Poly1305::new(key.into());
  let nonce_bytes: [u8; 24] = rand::random();
  let nonce = XNonce::from_slice(&nonce_bytes);
  let plaintext = serde_json::to_vec(payload).map_err(|e| format!("JSON inválido: {e}"))?;
  let ciphertext = cipher
    .encrypt(nonce, plaintext.as_slice())
    .map_err(|e| format!("Error cifrando payload: {e}"))?;
  Ok((STANDARD.encode(&ciphertext), STANDARD.encode(&nonce_bytes)))
}

/// Descifra un payload desde Base64 y devuelve el JSON original.
pub fn decrypt_payload(
  ciphertext_b64: &str,
  nonce_b64: &str,
  key: &[u8; 32],
) -> Result<serde_json::Value, String> {
  let cipher = XChaCha20Poly1305::new(key.into());
  let ciphertext = STANDARD
    .decode(ciphertext_b64)
    .map_err(|e| format!("Ciphertext Base64 inválido: {e}"))?;
  let nonce_bytes = STANDARD
    .decode(nonce_b64)
    .map_err(|e| format!("Nonce Base64 inválido: {e}"))?;
  if nonce_bytes.len() != 24 {
    return Err(format!(
      "Nonce debe tener 24 bytes, tiene {}",
      nonce_bytes.len()
    ));
  }
  let nonce = XNonce::from_slice(&nonce_bytes);
  let plaintext = cipher
    .decrypt(nonce, ciphertext.as_slice())
    .map_err(|e| format!("Error descifrando (¿llave incorrecta?): {e}"))?;
  serde_json::from_slice(&plaintext).map_err(|e| format!("JSON inválido tras descifrar: {e}"))
}

/// Marca un payload como cifrado: { "_encrypted": true, "data": "...", "nonce": "..." }
pub fn wrap_encrypted(ciphertext_b64: &str, nonce_b64: &str) -> serde_json::Value {
  serde_json::json!({
    "_encrypted": true,
    "data": ciphertext_b64,
    "nonce": nonce_b64
  })
}

/// Extrae ciphertext y nonce de un payload cifrado, o None si no está cifrado.
pub fn unwrap_encrypted(payload: &serde_json::Value) -> Option<(String, String)> {
  let obj = payload.as_object()?;
  if obj.get("_encrypted").and_then(|v| v.as_bool()) != Some(true) {
    return None;
  }
  let data = obj.get("data")?.as_str()?.to_string();
  let nonce = obj.get("nonce")?.as_str()?.to_string();
  Some((data, nonce))
}

/* ------------------------------------------------------------------ */
/* Comandos Tauri                                                     */
/* ------------------------------------------------------------------ */

#[tauri::command]
pub fn crypto_unlock(state: State<'_, CryptoState>, password: String) -> Result<(), String> {
  if password.is_empty() {
    return Err("La contraseña no puede estar vacía.".into());
  }
  let key = derive_key(&password)?;
  state.set_key(key);
  Ok(())
}

#[tauri::command]
pub fn crypto_lock(state: State<'_, CryptoState>) -> Result<(), String> {
  state.clear_key();
  Ok(())
}

#[tauri::command]
pub fn crypto_status(state: State<'_, CryptoState>) -> Result<bool, String> {
  Ok(state.has_key())
}

#[tauri::command]
pub fn crypto_encrypt_text(
  state: State<'_, CryptoState>,
  plaintext: String,
) -> Result<String, String> {
  let key = state.get_key()?;
  let payload = serde_json::Value::String(plaintext);
  let (ct, nonce) = encrypt_payload(&payload, &key)?;
  Ok(format!("{ct}:{nonce}"))
}

#[tauri::command]
pub fn crypto_decrypt_text(
  state: State<'_, CryptoState>,
  encrypted: String,
) -> Result<String, String> {
  let key = state.get_key()?;
  let parts: Vec<&str> = encrypted.splitn(2, ':').collect();
  if parts.len() != 2 {
    return Err("Formato inválido. Esperado ciphertext:nonce".into());
  }
  let value = decrypt_payload(parts[0], parts[1], &key)?;
  value
    .as_str()
    .map(|s| s.to_string())
    .ok_or_else(|| "El valor descifrado no es texto.".into())
}

/* ------------------------------------------------------------------ */
/* Integración con Event Store (cifrado transparente)                 */
/* ------------------------------------------------------------------ */

/// Lee un archivo JSONL, descifra payloads cifrados, devuelve líneas en texto plano.
#[tauri::command]
pub fn crypto_read_events(
  state: State<'_, CryptoState>,
  root: String,
  domain: String,
) -> Result<String, String> {
  let path = std::path::Path::new(&root)
    .join("events")
    .join(format!("{}.jsonl", domain));
  let text = match std::fs::read_to_string(&path) {
    Ok(t) => t,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
    Err(e) => return Err(format!("No se pudo leer el archivo de dominio: {e}")),
  };

  let key = state.get_key()?;
  let mut out = String::new();
  for line in text.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    // Parsear la línea como JSON
    let mut ev: serde_json::Value = match serde_json::from_str(trimmed) {
      Ok(v) => v,
      Err(_) => {
        out.push_str(trimmed);
        out.push('\n');
        continue;
      }
    };

    // Si el payload está cifrado, descifrar
    if let Some(payload) = ev.get("payload") {
      if let Some((ct, nonce)) = unwrap_encrypted(payload) {
        match decrypt_payload(&ct, &nonce, &key) {
          Ok(decrypted) => {
            ev["payload"] = decrypted;
          }
          Err(e) => {
            // No se pudo descifrar: dejar marcado
            ev["payload"] = serde_json::json!({
              "_encrypted": true,
              "_error": e,
              "data": ct,
              "nonce": nonce
            });
          }
        }
      }
    }

    let line_out = serde_json::to_string(&ev).map_err(|e| e.to_string())?;
    out.push_str(&line_out);
    out.push('\n');
  }
  Ok(out)
}

/// Cifra el payload y hace append al archivo JSONL.
#[tauri::command]
pub fn crypto_append_event(
  state: State<'_, CryptoState>,
  root: String,
  domain: String,
  event_json: String,
) -> Result<(), String> {
  let key = state.get_key()?;
  let mut ev: serde_json::Value =
    serde_json::from_str(&event_json).map_err(|e| format!("JSON inválido: {e}"))?;

  // Cifrar el payload si existe
  if let Some(payload) = ev.get("payload").cloned() {
    // No cifrar si ya está cifrado
    if unwrap_encrypted(&payload).is_none() {
      let (ct, nonce) = encrypt_payload(&payload, &key)?;
      ev["payload"] = wrap_encrypted(&ct, &nonce);
    }
  }

  let line = serde_json::to_string(&ev).map_err(|e| e.to_string())?;

  let dir = std::path::Path::new(&root).join("events");
  std::fs::create_dir_all(&dir).map_err(|e| format!("No se pudo crear carpeta: {e}"))?;
  let path = dir.join(format!("{}.jsonl", domain));
  use std::io::Write;
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("No se pudo abrir archivo: {e}"))?;
  writeln!(file, "{}", line).map_err(|e| format!("Error escribiendo: {e}"))?;
  file.flush().map_err(|e| format!("Error flush: {e}"))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn derive_key_produces_32_bytes() {
    let key = derive_key("mi-password-secreta").unwrap();
    assert_eq!(key.len(), 32);
  }

  #[test]
  fn derive_key_deterministic() {
    let k1 = derive_key("test").unwrap();
    let k2 = derive_key("test").unwrap();
    assert_eq!(k1, k2);
  }

  #[test]
  fn derive_key_different_passwords() {
    let k1 = derive_key("password1").unwrap();
    let k2 = derive_key("password2").unwrap();
    assert_ne!(k1, k2);
  }

  #[test]
  fn encrypt_decrypt_roundtrip() {
    let key = derive_key("test-key").unwrap();
    let payload = serde_json::json!({ "secret": "data", "amount": 100 });
    let (ct, nonce) = encrypt_payload(&payload, &key).unwrap();
    let decrypted = decrypt_payload(&ct, &nonce, &key).unwrap();
    assert_eq!(decrypted, payload);
  }

  #[test]
  fn decrypt_wrong_key_fails() {
    let key1 = derive_key("key1").unwrap();
    let key2 = derive_key("key2").unwrap();
    let payload = serde_json::json!({ "secret": "data" });
    let (ct, nonce) = encrypt_payload(&payload, &key1).unwrap();
    assert!(decrypt_payload(&ct, &nonce, &key2).is_err());
  }

  #[test]
  fn wrap_unwrap_encrypted() {
    let wrapped = wrap_encrypted("abc123", "nonce456");
    let (ct, nonce) = unwrap_encrypted(&wrapped).unwrap();
    assert_eq!(ct, "abc123");
    assert_eq!(nonce, "nonce456");
  }

  #[test]
  fn unwrap_non_encrypted_returns_none() {
    let plain = serde_json::json!({ "id": "123", "payload": { "amount": 100 } });
    assert!(unwrap_encrypted(&plain).is_none());
  }

  #[test]
  fn crypto_state_lock_unlock() {
    let state = CryptoState::new();
    assert!(!state.has_key());
    assert!(state.get_key().is_err());
    let key = derive_key("test").unwrap();
    state.set_key(key);
    assert!(state.has_key());
    assert!(state.get_key().is_ok());
    state.clear_key();
    assert!(!state.has_key());
  }
}
