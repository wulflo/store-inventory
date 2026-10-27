use base64::{engine::general_purpose::STANDARD, Engine};
use chacha20poly1305::{
  aead::{Aead, KeyInit},
  Key, XChaCha20Poly1305, XNonce,
};
use serde_json::Value;
use std::sync::Mutex;
use tauri::State;

/* ------------------------------------------------------------------ */
/* Estado criptográfico (solo en RAM)                                 */
/* ------------------------------------------------------------------ */

/// Llave maestra derivada con Argon2. Vive únicamente en memoria: se pierde
/// al cerrar la aplicación (nunca se escribe en disco).
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
    let mut guard = self.key.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut key) = guard.take() {
      // Mejor esfuerzo: sobrescribir la llave antes de soltarla.
      for byte in key.iter_mut() {
        *byte = 0;
      }
    }
  }

  pub fn has_key(&self) -> bool {
    self.key.lock().unwrap_or_else(|e| e.into_inner()).is_some()
  }

  pub fn get_key(&self) -> Result<[u8; 32], String> {
    self
      .key
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .ok_or_else(|| "Llave no inicializada. Desbloqueá el cifrado con la contraseña maestra.".to_string())
  }
}

/* ------------------------------------------------------------------ */
/* Derivación de llave (Argon2id)                                     */
/* ------------------------------------------------------------------ */

/// Sal fija de la aplicación. La sal no es secreta; con una sal fija, la misma
/// contraseña produce la misma llave en cualquier dispositivo, lo que permite
/// recuperar los datos si se pierde la configuración local.
const APP_SALT: &[u8] = b"inventario-tienda-v1-salt";

/// Deriva una llave de 32 bytes a partir de la contraseña maestra con Argon2id.
pub fn derive_key(password: &str) -> Result<[u8; 32], String> {
  if password.is_empty() {
    return Err("La contraseña no puede estar vacía.".into());
  }
  let mut key = [0u8; 32];
  argon2::Argon2::default()
    .hash_password_into(password.as_bytes(), APP_SALT, &mut key)
    .map_err(|e| format!("Error derivando la llave con Argon2: {e}"))?;
  Ok(key)
}

/* ------------------------------------------------------------------ */
/* Cifrado / descifrado (XChaCha20-Poly1305)                          */
/* ------------------------------------------------------------------ */

/// Cifra un payload JSON y devuelve `(ciphertext_base64, nonce_base64)`.
pub fn encrypt_payload(payload: &Value, key: &[u8; 32]) -> Result<(String, String), String> {
  let cipher = XChaCha20Poly1305::new(Key::from_slice(key));
  let nonce_bytes: [u8; 24] = rand::random();
  let nonce = XNonce::from_slice(&nonce_bytes);
  let plaintext = serde_json::to_vec(payload).map_err(|e| format!("JSON inválido: {e}"))?;
  let ciphertext = cipher
    .encrypt(nonce, plaintext.as_slice())
    .map_err(|e| format!("Error cifrando el payload: {e}"))?;
  Ok((STANDARD.encode(ciphertext), STANDARD.encode(nonce_bytes)))
}

/// Descifra un payload desde Base64 y devuelve el JSON original.
pub fn decrypt_payload(
  ciphertext_b64: &str,
  nonce_b64: &str,
  key: &[u8; 32],
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
  let nonce = XNonce::from_slice(&nonce_bytes);
  let plaintext = cipher
    .decrypt(nonce, ciphertext.as_slice())
    .map_err(|_| "No se pudo descifrar el payload (¿contraseña incorrecta?).".to_string())?;
  serde_json::from_slice(&plaintext).map_err(|e| format!("JSON inválido tras descifrar: {e}"))
}

/// Envuelve un payload cifrado con el formato que se guarda en disco.
pub fn wrap_encrypted(ciphertext_b64: &str, nonce_b64: &str) -> Value {
  serde_json::json!({
    "_encrypted": true,
    "alg": "XChaCha20-Poly1305",
    "data": ciphertext_b64,
    "nonce": nonce_b64
  })
}

/// Extrae `(ciphertext, nonce)` de un payload cifrado, o `None` si es texto plano.
pub fn unwrap_encrypted(payload: &Value) -> Option<(String, String)> {
  let obj = payload.as_object()?;
  if obj.get("_encrypted").and_then(Value::as_bool) != Some(true) {
    return None;
  }
  let data = obj.get("data")?.as_str()?.to_string();
  let nonce = obj.get("nonce")?.as_str()?.to_string();
  Some((data, nonce))
}

/* ------------------------------------------------------------------ */
/* Transformación de líneas de evento                                 */
/* ------------------------------------------------------------------ */

/// Cifra el campo `payload` de una línea JSONL. Los metadatos (`id`, `type`,
/// `metadata`: timestamp, HLC, device_id) quedan en texto plano para poder
/// ordenar, deduplicar y sincronizar sin conocer la contraseña.
pub fn encrypt_event_line(line: &str, key: &[u8; 32]) -> Result<String, String> {
  let mut event: Value =
    serde_json::from_str(line).map_err(|e| format!("El evento no es JSON válido: {e}"))?;

  let Some(payload) = event.get("payload").cloned() else {
    return Err("El evento no tiene campo `payload`.".into());
  };

  // Idempotente: si ya viene cifrado, se deja tal cual.
  if unwrap_encrypted(&payload).is_none() {
    let (ciphertext, nonce) = encrypt_payload(&payload, key)?;
    event["payload"] = wrap_encrypted(&ciphertext, &nonce);
  }

  serde_json::to_string(&event).map_err(|e| format!("No se pudo serializar el evento: {e}"))
}

/// Descifra el campo `payload` de una línea JSONL si está cifrado.
///
/// Si el descifrado falla (contraseña distinta), devuelve el evento con el
/// payload marcado con `_error` en lugar de abortar toda la lectura: así el
/// resto de la base sigue visible y el problema se puede mostrar en la UI.
pub fn decrypt_event_line(line: &str, key: &[u8; 32]) -> Result<String, String> {
  let mut event: Value = match serde_json::from_str(line) {
    Ok(value) => value,
    // Línea corrupta: se conserva tal cual para no perder información.
    Err(_) => return Ok(line.to_string()),
  };

  if let Some(payload) = event.get("payload") {
    if let Some((ciphertext, nonce)) = unwrap_encrypted(payload) {
      match decrypt_payload(&ciphertext, &nonce, key) {
        Ok(plain) => event["payload"] = plain,
        Err(err) => {
          event["payload"] = serde_json::json!({
            "_encrypted": true,
            "_error": err,
            "alg": "XChaCha20-Poly1305",
            "data": ciphertext,
            "nonce": nonce
          });
        }
      }
    }
  }

  serde_json::to_string(&event).map_err(|e| format!("No se pudo serializar el evento: {e}"))
}

/// Descifra todas las líneas de un archivo JSONL.
pub fn decrypt_events_text(text: &str, key: &[u8; 32]) -> Result<String, String> {
  let mut out = String::with_capacity(text.len());
  for line in text.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    out.push_str(&decrypt_event_line(trimmed, key)?);
    out.push('\n');
  }
  Ok(out)
}

/// Agrega un evento cifrado al archivo de dominio (append-only).
pub fn append_event_encrypted(
  root: &str,
  domain: &str,
  event_json: &str,
  key: &[u8; 32],
) -> Result<(), String> {
  let line = encrypt_event_line(event_json, key)?;
  crate::event_store::store_append(root.to_string(), domain.to_string(), vec![line])
}

/// Lee y descifra todas las líneas del archivo de dominio.
pub fn read_events_decrypted(
  root: &str,
  domain: &str,
  key: &[u8; 32],
) -> Result<String, String> {
  let text = crate::event_store::store_read(root.to_string(), domain.to_string())?;
  decrypt_events_text(&text, key)
}

/* ------------------------------------------------------------------ */
/* Comandos Tauri                                                     */
/* ------------------------------------------------------------------ */

/// Deriva la llave desde la contraseña maestra y la deja en memoria.
#[tauri::command]
pub fn crypto_unlock(state: State<'_, CryptoState>, password: String) -> Result<(), String> {
  let key = derive_key(&password)?;
  state.set_key(key);
  Ok(())
}

/// Borra la llave de la memoria (los datos quedan ilegibles hasta desbloquear).
#[tauri::command]
pub fn crypto_lock(state: State<'_, CryptoState>) -> Result<(), String> {
  state.clear_key();
  Ok(())
}

#[tauri::command]
pub fn crypto_status(state: State<'_, CryptoState>) -> Result<bool, String> {
  Ok(state.has_key())
}

/// Utilidad de diagnóstico: cifra un texto y devuelve `ciphertext:nonce`.
#[tauri::command]
pub fn crypto_encrypt_text(state: State<'_, CryptoState>, plaintext: String) -> Result<String, String> {
  let key = state.get_key()?;
  let (ciphertext, nonce) = encrypt_payload(&Value::String(plaintext), &key)?;
  Ok(format!("{ciphertext}:{nonce}"))
}

/// Utilidad de diagnóstico: descifra el formato `ciphertext:nonce`.
#[tauri::command]
pub fn crypto_decrypt_text(state: State<'_, CryptoState>, encrypted: String) -> Result<String, String> {
  let key = state.get_key()?;
  let (ciphertext, nonce) = encrypted
    .split_once(':')
    .ok_or_else(|| "Formato inválido. Se esperaba ciphertext:nonce".to_string())?;
  let value = decrypt_payload(ciphertext, nonce, &key)?;
  value
    .as_str()
    .map(str::to_string)
    .ok_or_else(|| "El valor descifrado no es texto.".to_string())
}

/// Flujo Write: recibe el evento desde TypeScript, cifra su payload y hace
/// append al JSONL del dominio.
#[tauri::command]
pub fn crypto_append_event(
  state: State<'_, CryptoState>,
  root: String,
  domain: String,
  event_json: String,
) -> Result<(), String> {
  let key = state.get_key()?;
  append_event_encrypted(&root, &domain, &event_json, &key)
}

/// Flujo Read: lee el JSONL línea por línea, descifra los payloads cifrados y
/// devuelve los eventos en texto plano.
#[tauri::command]
pub fn crypto_read_events(
  state: State<'_, CryptoState>,
  root: String,
  domain: String,
) -> Result<String, String> {
  let key = state.get_key()?;
  read_events_decrypted(&root, &domain, &key)
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
  use super::*;

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

  fn sample_event() -> String {
    serde_json::json!({
      "id": "0192f3a4-0000-7000-8000-000000000001",
      "type": "Order.Created",
      "payload": { "customer": "Ana Gómez", "total": 12345, "items": 2 },
      "metadata": {
        "hlc": 1793122609026000i64,
        "device_id": "device-test",
        "timestamp": 1793122609026i64,
        "version": 1
      }
    })
    .to_string()
  }

  #[test]
  fn derive_key_produces_32_bytes_and_is_deterministic() {
    let key = derive_key("mi-password-secreta").unwrap();
    assert_eq!(key.len(), 32);
    assert_eq!(key, derive_key("mi-password-secreta").unwrap());
  }

  #[test]
  fn derive_key_rejects_empty_password() {
    assert!(derive_key("").is_err());
  }

  #[test]
  fn derive_key_differs_between_passwords() {
    assert_ne!(derive_key("password1").unwrap(), derive_key("password2").unwrap());
  }

  #[test]
  fn encrypt_decrypt_roundtrip() {
    let key = derive_key("test-key").unwrap();
    let payload = serde_json::json!({ "secret": "data", "amount": 100 });
    let (ciphertext, nonce) = encrypt_payload(&payload, &key).unwrap();
    assert_eq!(decrypt_payload(&ciphertext, &nonce, &key).unwrap(), payload);
  }

  #[test]
  fn decrypt_with_wrong_key_fails() {
    let key1 = derive_key("key1").unwrap();
    let key2 = derive_key("key2").unwrap();
    let payload = serde_json::json!({ "secret": "data" });
    let (ciphertext, nonce) = encrypt_payload(&payload, &key1).unwrap();
    assert!(decrypt_payload(&ciphertext, &nonce, &key2).is_err());
  }

  #[test]
  fn wrap_and_unwrap_encrypted_payload() {
    let wrapped = wrap_encrypted("abc123", "nonce456");
    let (ciphertext, nonce) = unwrap_encrypted(&wrapped).unwrap();
    assert_eq!(ciphertext, "abc123");
    assert_eq!(nonce, "nonce456");
  }

  #[test]
  fn unwrap_plain_payload_returns_none() {
    let plain = serde_json::json!({ "total": 100 });
    assert!(unwrap_encrypted(&plain).is_none());
  }

  #[test]
  fn crypto_state_lock_unlock() {
    let state = CryptoState::new();
    assert!(!state.has_key());
    assert!(state.get_key().is_err());
    state.set_key(derive_key("test").unwrap());
    assert!(state.has_key());
    assert!(state.get_key().is_ok());
    state.clear_key();
    assert!(!state.has_key());
  }

  #[test]
  fn encrypt_event_line_keeps_metadata_in_plaintext() {
    let key = derive_key("test-key").unwrap();
    let line = encrypt_event_line(&sample_event(), &key).unwrap();

    // El contenido sensible no aparece en claro en la línea cifrada.
    assert!(!line.contains("Ana Gómez"));
    assert!(!line.contains("12345"));

    let event: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(event["id"], "0192f3a4-0000-7000-8000-000000000001");
    assert_eq!(event["type"], "Order.Created");
    assert_eq!(event["metadata"]["device_id"], "device-test");
    assert_eq!(event["metadata"]["hlc"], 1793122609026000i64);
    assert_eq!(event["payload"]["_encrypted"], true);
    assert!(event["payload"]["data"].as_str().unwrap().len() > 0);

    // Idempotente: cifrar de nuevo no cambia nada.
    let again = encrypt_event_line(&line, &key).unwrap();
    assert_eq!(serde_json::from_str::<Value>(&again).unwrap(), event);
  }

  #[test]
  fn encrypt_event_line_rejects_invalid_json() {
    let key = derive_key("test-key").unwrap();
    assert!(encrypt_event_line("no-es-json", &key).is_err());
  }

  #[test]
  fn file_roundtrip_encrypts_at_rest_and_decrypts_on_read() {
    let key = derive_key("clave-de-prueba").unwrap();
    let root = temp_root("roundtrip");
    let domain = "orders";

    append_event_encrypted(&root, domain, &sample_event(), &key).unwrap();

    // En disco queda cifrado.
    let raw = std::fs::read_to_string(
      std::path::Path::new(&root).join("events").join("orders.jsonl"),
    )
    .unwrap();
    assert!(raw.contains("\"_encrypted\":true"));
    assert!(!raw.contains("Ana Gómez"));

    // Al leer con la misma llave vuelve el payload original.
    let plain = read_events_decrypted(&root, domain, &key).unwrap();
    let event: Value = serde_json::from_str(plain.trim()).unwrap();
    assert_eq!(event["payload"]["customer"], "Ana Gómez");
    assert_eq!(event["payload"]["total"], 12345);
    assert_eq!(event["id"], "0192f3a4-0000-7000-8000-000000000001");

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn read_with_wrong_key_marks_error_without_losing_metadata() {
    let key = derive_key("clave-correcta").unwrap();
    let wrong = derive_key("clave-incorrecta").unwrap();
    let root = temp_root("wrong-key");
    let domain = "orders";

    append_event_encrypted(&root, domain, &sample_event(), &key).unwrap();

    let plain = read_events_decrypted(&root, domain, &wrong).unwrap();
    let event: Value = serde_json::from_str(plain.trim()).unwrap();
    assert!(event["payload"]["_error"].is_string());
    assert_eq!(event["payload"]["_encrypted"], true);
    // Los metadatos siguen legibles: se puede seguir ordenando y deduplicando.
    assert_eq!(event["id"], "0192f3a4-0000-7000-8000-000000000001");
    assert_eq!(event["metadata"]["device_id"], "device-test");

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn plaintext_events_still_readable_with_key() {
    let key = derive_key("test-key").unwrap();
    let root = temp_root("plaintext");
    let domain = "orders";

    // Evento escrito por el flujo normal (sin cifrado).
    crate::event_store::store_append(root.clone(), domain.to_string(), vec![sample_event()])
      .unwrap();

    let plain = read_events_decrypted(&root, domain, &key).unwrap();
    let event: Value = serde_json::from_str(plain.trim()).unwrap();
    assert_eq!(event["payload"]["customer"], "Ana Gómez");
    assert!(unwrap_encrypted(&event["payload"]).is_none());

    let _ = std::fs::remove_dir_all(&root);
  }

  #[test]
  fn reading_missing_domain_returns_empty_text() {
    let key = derive_key("test-key").unwrap();
    let root = temp_root("missing");
    assert_eq!(read_events_decrypted(&root, "orders", &key).unwrap(), "");
    let _ = std::fs::remove_dir_all(&root);
  }
}
