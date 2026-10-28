//! Llavero de cifrado (keyring).
//!
//! Modelo: una **clave de datos** (DEK) aleatoria de 32 bytes cifra los
//! payloads de los eventos. La contraseña maestra **no** cifra los datos: solo
//! envuelve (wrap) la DEK con una clave derivada con Argon2id.
//!
//! El archivo `keys/keyring.json` contiene:
//! - sal aleatoria y parámetros de Argon2 (no secretos),
//! - uno o más "wraps" de la misma DEK (contraseña y código de recuperación),
//! - `kid`: huella corta de la DEK para detectar claves distintas.
//!
//! Cambiar la contraseña solo re-envuelve la DEK: no se re-cifran los datos.
//! Rotar la clave (revocar un equipo) genera una DEK nueva y re-cifra todo.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
  aead::{Aead, KeyInit, Payload},
  Key, XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::storage;

pub const KEYRING_VERSION: u32 = 1;
pub const MIN_PASSWORD_LEN: usize = 8;
pub const RECOVERY_BYTES: usize = 20;
const KEYRING_AAD_PREFIX: &[u8] = b"inventario-tienda-keyring-v1";
const WRAP_PASSWORD: &str = "password";
const WRAP_RECOVERY: &str = "recovery";

/* ------------------------------------------------------------------ */
/* Parámetros KDF                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KdfParams {
  pub alg: String,
  /// Costo de memoria en KiB.
  pub m_cost: u32,
  pub t_cost: u32,
  pub p_cost: u32,
  /// Sal aleatoria en Base64 (no secreta).
  pub salt: String,
}

impl KdfParams {
  /// Parámetros recomendados: 64 MiB, 3 iteraciones, 1 hilo.
  pub fn recommended() -> Result<Self, String> {
    Self::new(65_536, 3, 1)
  }

  /// Parámetros livianos, solo para tests.
  #[cfg(test)]
  pub fn fast() -> Result<Self, String> {
    Self::new(1_024, 1, 1)
  }

  pub fn new(m_cost: u32, t_cost: u32, p_cost: u32) -> Result<Self, String> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    Ok(Self {
      alg: "argon2id".to_string(),
      m_cost,
      t_cost,
      p_cost,
      salt: URL_SAFE_NO_PAD.encode(salt),
    })
  }

  fn salt_bytes(&self) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
      .decode(&self.salt)
      .map_err(|e| format!("Sal del llavero inválida: {e}"))
  }

  /// Deriva una clave de 32 bytes. Nunca se persiste.
  pub fn derive(&self, secret: &str) -> Result<[u8; 32], String> {
    if secret.is_empty() {
      return Err("La contraseña no puede estar vacía.".to_string());
    }
    let salt = self.salt_bytes()?;
    let params = argon2::Params::new(self.m_cost, self.t_cost, self.p_cost, Some(32))
      .map_err(|e| format!("Parámetros Argon2 inválidos: {e}"))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
      .hash_password_into(secret.as_bytes(), &salt, &mut out)
      .map_err(|e| format!("Error derivando la clave con Argon2: {e}"))?;
    Ok(out)
  }
}

/* ------------------------------------------------------------------ */
/* Estructuras del llavero                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wrap {
  /// `password` o `recovery`.
  pub kind: String,
  pub nonce: String,
  pub data: String,
  pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Keyring {
  pub version: u32,
  /// Huella corta (Base64) del SHA-256 de la DEK.
  pub kid: String,
  pub kdf: KdfParams,
  pub wraps: Vec<Wrap>,
}

pub struct CreatedKeyring {
  pub keyring: Keyring,
  pub key: [u8; 32],
  /// Código de recuperación con guiones, para mostrar una única vez.
  pub recovery_code: String,
}

/* ------------------------------------------------------------------ */
/* Rutas y persistencia                                               */
/* ------------------------------------------------------------------ */

pub const KEYRING_REL: &str = "keys/keyring.json";
pub const STAGED_KEYRING_REL: &str = "keys/keyring.next.json";

#[cfg(test)]
pub fn keyring_path(root: &str) -> PathBuf {
  Path::new(root).join(KEYRING_REL)
}

pub fn staged_path(root: &str) -> PathBuf {
  Path::new(root).join(STAGED_KEYRING_REL)
}

pub fn exists(root: &str) -> bool {
  storage::exists(root, KEYRING_REL).unwrap_or(false)
}

pub fn load(root: &str) -> Result<Option<Keyring>, String> {
  let text = match storage::read_string(root, KEYRING_REL)? {
    Some(text) => text,
    None => return Ok(None),
  };
  parse(&text).map(Some)
}

/// Valida y parsea el JSON de un llavero (propio o importado).
pub fn parse(text: &str) -> Result<Keyring, String> {
  let keyring: Keyring =
    serde_json::from_str(text).map_err(|e| format!("El llavero de cifrado está dañado: {e}"))?;
  if keyring.version != KEYRING_VERSION {
    return Err(format!(
      "Versión de llavero no soportada: {} (se esperaba {}).",
      keyring.version, KEYRING_VERSION
    ));
  }
  if keyring.kid.trim().is_empty() || keyring.wraps.is_empty() {
    return Err("El llavero no tiene clave o envoltorios válidos.".to_string());
  }
  if keyring.kdf.alg != "argon2id" {
    return Err(format!(
      "Algoritmo de derivación no soportado: {}.",
      keyring.kdf.alg
    ));
  }
  // Límites sanos: evitan que un llavero corrupto o malicioso agote la memoria.
  if !(1_024..=262_144).contains(&keyring.kdf.m_cost)
    || !(1..=10).contains(&keyring.kdf.t_cost)
    || !(1..=8).contains(&keyring.kdf.p_cost)
  {
    return Err("Los parámetros de derivación del llavero están fuera de rango.".to_string());
  }
  let salt = keyring.kdf.salt_bytes()?;
  if !(16..=64).contains(&salt.len()) {
    return Err("La sal del llavero tiene un tamaño inválido.".to_string());
  }
  for wrap in &keyring.wraps {
    if wrap.kind != WRAP_PASSWORD && wrap.kind != WRAP_RECOVERY {
      return Err(format!("Tipo de envoltorio desconocido: {}.", wrap.kind));
    }
    if wrap.data.is_empty() || wrap.nonce.is_empty() {
      return Err("El llavero tiene un envoltorio incompleto.".to_string());
    }
  }
  Ok(keyring)
}

/// Guarda el llavero activo. Se usa al crear (activar) el cifrado.
pub fn save(root: &str, keyring: &Keyring) -> Result<(), String> {
  let json = serde_json::to_string_pretty(keyring)
    .map_err(|e| format!("No se pudo serializar el llavero: {e}"))?;
  storage::write_atomic(root, KEYRING_REL, json.as_bytes())
}

/// Elimina el llavero activo (solo para revertir una activación fallida).
pub fn remove(root: &str) -> Result<(), String> {
  storage::remove_file(root, KEYRING_REL)
}

/// Escribe el llavero nuevo **antes** de migrar los eventos.
///
/// Así, si la migración falla por falta de espacio, el llavero activo sigue
/// siendo el viejo y los datos siguen siendo legibles. La activación es un
/// `rename` posterior (`commit_staged`), que no necesita espacio adicional.
pub fn stage(root: &str, keyring: &Keyring) -> Result<(), String> {
  let json = serde_json::to_string_pretty(keyring)
    .map_err(|e| format!("No se pudo serializar el llavero: {e}"))?;
  storage::write_atomic(root, STAGED_KEYRING_REL, json.as_bytes())
}

/// Activa el llavero preparado con `stage` (rename atómico en local).
pub fn commit_staged(root: &str) -> Result<(), String> {
  storage::rename(root, STAGED_KEYRING_REL, KEYRING_REL)
    .map_err(|e| format!("No se pudo activar el llavero nuevo: {e}"))
}

/// Descarta un llavero preparado que no llegó a usarse.
pub fn discard_staged(root: &str) {
  let _ = storage::remove_file(root, STAGED_KEYRING_REL);
}

/* ------------------------------------------------------------------ */
/* Creación, desbloqueo y cambio de contraseña                        */
/* ------------------------------------------------------------------ */

/// Deriva la huella corta de una DEK (11 caracteres Base64 URL-safe).
pub fn kid_for(key: &[u8; 32]) -> String {
  let digest = Sha256::digest(key);
  URL_SAFE_NO_PAD.encode(&digest[..8])
}

pub fn create(password: &str, kdf: KdfParams) -> Result<CreatedKeyring, String> {
  validate_password(password)?;

  let mut key = [0u8; 32];
  rand::thread_rng().fill_bytes(&mut key);
  let kid = kid_for(&key);

  let mut recovery_bytes = [0u8; RECOVERY_BYTES];
  rand::thread_rng().fill_bytes(&mut recovery_bytes);
  let recovery_raw = base32::encode(&recovery_bytes);
  let recovery_code = format_recovery(&recovery_raw);

  let wraps = vec![
    wrap_secret(&key, password, &kid, &kdf, WRAP_PASSWORD)?,
    wrap_secret(&key, &recovery_raw, &kid, &kdf, WRAP_RECOVERY)?,
  ];

  Ok(CreatedKeyring {
    keyring: Keyring {
      version: KEYRING_VERSION,
      kid,
      kdf,
      wraps,
    },
    key,
    recovery_code,
  })
}

/// Desbloquea con contraseña **o** código de recuperación.
pub fn unlock(root: &str, secret: &str) -> Result<([u8; 32], String), String> {
  let keyring = load(root)?.ok_or_else(|| "El cifrado no está activado.".to_string())?;
  let key = unwrap(&keyring, secret)?;
  Ok((key, keyring.kid.clone()))
}

/// Intenta desenvolver la DEK con el secreto provisto (contraseña o código).
///
/// La forma del texto decide qué envoltorio probar: un código de recuperación
/// válido (32 caracteres Base32) usa el wrap `recovery`; cualquier otra cosa
/// usa el wrap `password`. Así el desbloqueo normal hace **una sola** derivación
/// Argon2id en vez de probar todas las combinaciones.
pub fn unwrap(keyring: &Keyring, secret: &str) -> Result<[u8; 32], String> {
  let trimmed = secret.trim();
  if trimmed.is_empty() {
    return Err("Ingresá tu contraseña o código de recuperación.".to_string());
  }

  let is_recovery = looks_like_recovery(trimmed);
  let candidate = if is_recovery {
    normalize_recovery(trimmed)
  } else {
    trimmed.to_string()
  };
  let wanted = if is_recovery { WRAP_RECOVERY } else { WRAP_PASSWORD };

  if let Some(key) = try_wrap_kind(keyring, wanted, &candidate)? {
    return Ok(key);
  }
  // Un password puede "parecer" un código Base32 (p. ej. 32 caracteres
  // hexadecimales). Solo en ese caso ambiguo se prueba el wrap de contraseña.
  if is_recovery {
    if let Some(key) = try_wrap_kind(keyring, WRAP_PASSWORD, trimmed)? {
      return Ok(key);
    }
  }

  Err("Contraseña o código de recuperación incorrecto.".to_string())
}

/// Prueba los wraps de un tipo. Devuelve `None` si no hay ninguno o si el
/// secreto no abre ninguno; error si la clave abierta no coincide con `kid`.
fn try_wrap_kind(
  keyring: &Keyring,
  kind: &str,
  secret: &str,
) -> Result<Option<[u8; 32]>, String> {
  let wraps: Vec<&Wrap> = keyring
    .wraps
    .iter()
    .filter(|wrap| wrap.kind == kind)
    .collect();
  for wrap in wraps {
    if let Ok(key) = unwrap_secret(keyring, wrap, secret) {
      if kid_for(&key) != keyring.kid {
        return Err(
          "El llavero está dañado: la clave recuperada no coincide con su huella.".to_string(),
        );
      }
      return Ok(Some(key));
    }
  }
  Ok(None)
}

/// Cambia la contraseña re-envolviendo la misma DEK. No re-cifra eventos.
///
/// Acepta la contraseña actual o el código de recuperación como `current_secret`,
/// de modo que también sirve para recuperar el acceso y fijar una contraseña nueva.
pub fn change_password(root: &str, current_secret: &str, new_password: &str) -> Result<(), String> {
  validate_password(new_password)?;
  let mut keyring = load(root)?.ok_or_else(|| "El cifrado no está activado.".to_string())?;
  let key = unwrap(&keyring, current_secret)?;

  let new_wrap = wrap_secret(&key, new_password, &keyring.kid, &keyring.kdf, WRAP_PASSWORD)?;
  keyring.wraps.retain(|w| w.kind != WRAP_PASSWORD);
  keyring.wraps.insert(0, new_wrap);
  save(root, &keyring)
}

/// Crea un llavero nuevo (DEK nueva) para rotar la clave.
pub fn create_rotated(password: &str, kdf: KdfParams) -> Result<CreatedKeyring, String> {
  create(password, kdf)
}

/* ------------------------------------------------------------------ */
/* Cifrado de la DEK (wrap)                                           */
/* ------------------------------------------------------------------ */

fn wrap_aad(kind: &str, kid: &str) -> Vec<u8> {
  let mut aad = KEYRING_AAD_PREFIX.to_vec();
  aad.push(b'|');
  aad.extend_from_slice(kind.as_bytes());
  aad.push(b'|');
  aad.extend_from_slice(kid.as_bytes());
  aad
}

fn wrap_secret(
  dek: &[u8; 32],
  secret: &str,
  kid: &str,
  kdf: &KdfParams,
  kind: &str,
) -> Result<Wrap, String> {
  // Misma normalización que `unwrap`: la contraseña se usa sin espacios.
  let secret = if kind == WRAP_PASSWORD {
    secret.trim()
  } else {
    secret
  };
  let mut kek = kdf.derive(secret)?;
  let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek));
  let nonce_bytes: [u8; 24] = rand::random();
  let aad = wrap_aad(kind, kid);
  let result = cipher
    .encrypt(
      XNonce::from_slice(&nonce_bytes),
      Payload {
        msg: dek,
        aad: &aad,
      },
    )
    .map_err(|e| format!("No se pudo envolver la clave de datos: {e}"));
  wipe(&mut kek);
  let ciphertext = result?;

  Ok(Wrap {
    kind: kind.to_string(),
    nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
    data: URL_SAFE_NO_PAD.encode(ciphertext),
    created_at: now_ms(),
  })
}

fn unwrap_secret(keyring: &Keyring, wrap: &Wrap, secret: &str) -> Result<[u8; 32], String> {
  let mut kek = keyring.kdf.derive(secret)?;
  let nonce = URL_SAFE_NO_PAD
    .decode(&wrap.nonce)
    .map_err(|e| format!("Nonce del llavero inválido: {e}"))?;
  if nonce.len() != 24 {
    return Err("Nonce del llavero con longitud inválida.".to_string());
  }
  let data = URL_SAFE_NO_PAD
    .decode(&wrap.data)
    .map_err(|e| format!("Datos del llavero inválidos: {e}"))?;
  let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek));
  let aad = wrap_aad(&wrap.kind, &keyring.kid);
  let result = cipher.decrypt(
    XNonce::from_slice(&nonce),
    Payload {
      msg: &data,
      aad: &aad,
    },
  );
  wipe(&mut kek);
  let plain = result.map_err(|_| "Contraseña o código de recuperación incorrecto.".to_string())?;
  if plain.len() != 32 {
    return Err("La clave de datos recuperada tiene un tamaño inválido.".to_string());
  }
  let mut key = [0u8; 32];
  key.copy_from_slice(&plain);
  Ok(key)
}

/* ------------------------------------------------------------------ */
/* Código de recuperación                                             */
/* ------------------------------------------------------------------ */

/// Formato legible: grupos de 4 caracteres separados por guiones.
pub fn format_recovery(raw: &str) -> String {
  raw
    .as_bytes()
    .chunks(4)
    .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
    .collect::<Vec<_>>()
    .join("-")
}

/// Normaliza lo que escribe el usuario: mayúsculas, sin guiones ni espacios,
/// y corrige caracteres ambiguos (O→0, I/L→1).
pub fn normalize_recovery(input: &str) -> String {
  input
    .chars()
    .filter(|c| c.is_ascii_alphanumeric())
    .map(|c| match c.to_ascii_uppercase() {
      'O' => '0',
      'I' | 'L' => '1',
      other => other,
    })
    .collect()
}

/// `true` si el texto parece un código de recuperación válido (32 chars).
pub fn looks_like_recovery(input: &str) -> bool {
  base32::decode(&normalize_recovery(input))
    .map(|bytes| bytes.len() == RECOVERY_BYTES)
    .unwrap_or(false)
}

mod base32 {
  const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

  pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in bytes {
      buffer = (buffer << 8) | u32::from(*byte);
      bits += 8;
      while bits >= 5 {
        bits -= 5;
        out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
      }
      buffer &= (1u32 << bits) - 1;
    }
    if bits > 0 {
      out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
  }

  pub fn decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for ch in input.chars() {
      let value = value_of(ch)?;
      buffer = (buffer << 5) | value;
      bits += 5;
      if bits >= 8 {
        bits -= 8;
        out.push((buffer >> bits) as u8);
        buffer &= (1u32 << bits) - 1;
      }
    }
    // Los bits sobrantes deben ser menos de 5 y cero (sin relleno).
    if bits >= 5 || buffer != 0 {
      return None;
    }
    Some(out)
  }

  fn value_of(ch: char) -> Option<u32> {
    let upper = ch.to_ascii_uppercase();
    ALPHABET
      .iter()
      .position(|b| *b as char == upper)
      .map(|i| i as u32)
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
      let bytes: Vec<u8> = (0..20).collect();
      let encoded = encode(&bytes);
      assert_eq!(encoded.len(), 32);
      assert_eq!(decode(&encoded).unwrap(), bytes);
    }

    #[test]
    fn rejects_invalid_characters() {
      assert!(decode("ABC$").is_none());
    }
  }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                         */
/* ------------------------------------------------------------------ */

fn validate_password(password: &str) -> Result<(), String> {
  if password.trim().len() < MIN_PASSWORD_LEN {
    return Err(format!(
      "La contraseña debe tener al menos {MIN_PASSWORD_LEN} caracteres."
    ));
  }
  Ok(())
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

fn wipe(bytes: &mut [u8]) {
  for byte in bytes.iter_mut() {
    // Escritura volátil para que el compilador no la optimice.
    unsafe { std::ptr::write_volatile(byte, 0) };
  }
  std::sync::atomic::compiler_fence(Ordering::SeqCst);
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
  use super::*;
  use std::fs;

  fn temp_root(tag: &str) -> String {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir()
      .join(format!("inventario-keys-{tag}-{nanos}"))
      .to_string_lossy()
      .to_string()
  }

  fn created(password: &str) -> CreatedKeyring {
    create(password, KdfParams::fast().unwrap()).unwrap()
  }

  #[test]
  fn create_and_unlock_with_password() {
    let root = temp_root("unlock-pw");
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();

    let (key, kid) = unlock(&root, "contraseña-segura").unwrap();
    assert_eq!(key, c.key);
    assert_eq!(kid, kid_for(&c.key));

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn unlock_with_recovery_code_ignores_dashes_and_case() {
    let root = temp_root("unlock-rec");
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();

    let lowered = c.recovery_code.to_lowercase().replace('-', " ");
    let (key, _) = unlock(&root, &lowered).unwrap();
    assert_eq!(key, c.key);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn wrong_secret_is_rejected() {
    let root = temp_root("wrong");
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();

    let err = unlock(&root, "otra-contraseña").unwrap_err();
    assert!(err.contains("incorrecto"));

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn change_password_keeps_dek_and_old_password_stops_working() {
    let root = temp_root("change");
    let c = created("contraseña-vieja");
    save(&root, &c.keyring).unwrap();

    change_password(&root, "contraseña-vieja", "contraseña-nueva").unwrap();

    assert!(unlock(&root, "contraseña-vieja").is_err());
    let (key, _) = unlock(&root, "contraseña-nueva").unwrap();
    assert_eq!(key, c.key);

    // El código de recuperación original sigue sirviendo.
    let (recovered, _) = unlock(&root, &c.recovery_code).unwrap();
    assert_eq!(recovered, c.key);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn recovery_code_can_reset_password() {
    let root = temp_root("reset");
    let c = created("contraseña-vieja");
    save(&root, &c.keyring).unwrap();

    change_password(&root, &c.recovery_code, "contraseña-nueva").unwrap();
    let (key, _) = unlock(&root, "contraseña-nueva").unwrap();
    assert_eq!(key, c.key);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn short_password_is_rejected() {
    assert!(create("corta", KdfParams::fast().unwrap()).is_err());
    let root = temp_root("short");
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();
    assert!(change_password(&root, "contraseña-segura", "corta").is_err());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn different_creations_produce_different_keys_and_kids() {
    let a = created("misma-contraseña");
    let b = created("misma-contraseña");
    assert_ne!(a.key, b.key);
    assert_ne!(a.keyring.kid, b.keyring.kid);
    assert_ne!(a.keyring.kdf.salt, b.keyring.kdf.salt);
  }

  #[test]
  fn keyring_file_is_valid_json_and_has_two_wraps() {
    let root = temp_root("file");
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();

    let text = fs::read_to_string(keyring_path(&root)).unwrap();
    let parsed: Keyring = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed.wraps.len(), 2);
    assert!(parsed.wraps.iter().any(|w| w.kind == "password"));
    assert!(parsed.wraps.iter().any(|w| w.kind == "recovery"));
    assert!(!text.contains("contraseña-segura"));

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn recovery_code_is_32_chars_in_eight_groups() {
    let c = created("contraseña-segura");
    assert_eq!(c.recovery_code.replace('-', "").len(), 32);
    assert_eq!(c.recovery_code.split('-').count(), 8);
    assert!(looks_like_recovery(&c.recovery_code));
  }

  #[test]
  fn tampered_kid_is_detected() {
    let mut c = created("contraseña-segura");
    c.keyring.kid = "AAAAAAAAAAA".to_string();
    assert!(unwrap(&c.keyring, "contraseña-segura").is_err());
  }

  #[test]
  fn parse_rejects_absurd_kdf_parameters() {
    let mut c = created("contraseña-segura");
    c.keyring.kdf.m_cost = 4_000_000;
    let text = serde_json::to_string(&c.keyring).unwrap();
    assert!(parse(&text).is_err());

    let mut c = created("contraseña-segura");
    c.keyring.kdf.alg = "pbkdf2".to_string();
    let text = serde_json::to_string(&c.keyring).unwrap();
    assert!(parse(&text).is_err());
  }

  #[test]
  fn exists_reports_keyring_presence() {
    let root = temp_root("exists");
    assert!(!exists(&root));
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();
    assert!(exists(&root));
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn staged_keyring_is_not_active_until_commit() {
    let root = temp_root("stage");
    let old = created("contraseña-vieja");
    save(&root, &old.keyring).unwrap();

    let next = created("contraseña-nueva");
    stage(&root, &next.keyring).unwrap();
    assert!(staged_path(&root).exists());

    // Sigue activo el viejo hasta el commit.
    let loaded = load(&root).unwrap().unwrap();
    assert_eq!(loaded.kid, old.keyring.kid);

    commit_staged(&root).unwrap();
    assert!(!staged_path(&root).exists());
    let loaded = load(&root).unwrap().unwrap();
    assert_eq!(loaded.kid, next.keyring.kid);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn discard_staged_leaves_active_keyring_intact() {
    let root = temp_root("discard");
    let old = created("contraseña-vieja");
    save(&root, &old.keyring).unwrap();
    let next = created("contraseña-nueva");
    stage(&root, &next.keyring).unwrap();

    discard_staged(&root);
    assert!(!staged_path(&root).exists());
    assert_eq!(load(&root).unwrap().unwrap().kid, old.keyring.kid);

    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn remove_deletes_the_keyring() {
    let root = temp_root("remove");
    let c = created("contraseña-segura");
    save(&root, &c.keyring).unwrap();
    remove(&root).unwrap();
    assert!(!exists(&root));
    remove(&root).unwrap(); // idempotente
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn password_is_trimmed_consistently() {
    let root = temp_root("trim");
    let c = create("  contraseña-segura  ", KdfParams::fast().unwrap()).unwrap();
    save(&root, &c.keyring).unwrap();
    assert!(unlock(&root, "contraseña-segura").is_ok());
    let _ = fs::remove_dir_all(&root);
  }

  #[test]
  fn password_that_looks_like_a_recovery_code_still_unlocks() {
    // 32 caracteres, todos válidos en Base32: se confunde con un código.
    let password = "0123456789ABCDEF0123456789ABCDEF";
    assert!(looks_like_recovery(password));
    let root = temp_root("ambiguous");
    let c = create(password, KdfParams::fast().unwrap()).unwrap();
    save(&root, &c.keyring).unwrap();
    let (key, _) = unlock(&root, password).unwrap();
    assert_eq!(key, c.key);
    let _ = fs::remove_dir_all(&root);
  }
}
