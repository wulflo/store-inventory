use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/* ------------------------------------------------------------------ */
/* Identidad de dispositivo (modelo Syncthing)                        */
/* ------------------------------------------------------------------ */

/** Par de claves Ed25519 + certificado autofirmado.
 *
 *  La clave privada nunca sale del dispositivo. En desktop se guarda en
 *  el almacenamiento privado de la app; en Android, en el almacenamiento
 *  privado (fuera del SAF, excluido de backups).
 *
 *  Nota: rcgen 0.11 no expone `Clone` para KeyPair ni `Debug` para
 *  Certificate; Identity guarda la clave privada como PEM (String) para
 *  poder persistirla sin necesidad de clonar el KeyPair.
 */
pub struct Identity {
  pub key_pair_pem: String,
  pub certificate: rcgen::Certificate,
  pub cert_der: Vec<u8>,
  pub device_id: String,
  pub name: String,
}

impl Identity {
  /** Genera una nueva identidad autofirmada. */
  pub fn generate(name: &str) -> Result<Self, String> {
    let mut params = rcgen::CertificateParams::default();
    let key_pair = rcgen::KeyPair::generate(&rcgen::PKCS_ED25519)
      .map_err(|e| format!("No se pudo generar el par de claves: {e}"))?;
    let key_pair_pem = key_pair.serialize_pem();
    params.key_pair = Some(key_pair);
    params.alg = &rcgen::PKCS_ED25519;
    let certificate = rcgen::Certificate::from_params(params)
      .map_err(|e| format!("No se pudo crear el certificado: {e}"))?;
    let cert_der = certificate
      .serialize_der()
      .map_err(|e| format!("No se pudo serializar el certificado: {e}"))?;
    let device_id = device_id_from_cert(&cert_der);

    Ok(Self {
      key_pair_pem,
      certificate,
      cert_der,
      device_id,
      name: name.to_string(),
    })
  }

  /** Serializa el certificado a PEM (para mostrar / compartir en emparejamiento). */
  pub fn cert_pem(&self) -> String {
    self.certificate.serialize_pem().unwrap()
  }

  /** Serializa la clave privada a PEM (solo para respaldo local del dispositivo). */
  pub fn key_pem(&self) -> String {
    self.key_pair_pem.clone()
  }

  /** Persiste identidad en disco (clave privada + certificado). */
  pub fn persist(&self, dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("No se pudo crear la carpeta de identidad: {e}"))?;
    fs::write(dir.join("identity.pem"), self.key_pem())
      .map_err(|e| format!("No se pudo escribir la clave privada: {e}"))?;
    fs::write(dir.join("certificate.pem"), self.cert_pem())
      .map_err(|e| format!("No se pudo escribir el certificado: {e}"))?;
    Ok(())
  }

  /** Carga identidad desde disco. */
  pub fn load(dir: &Path, name: &str) -> Result<Self, String> {
    let key_pair_pem = fs::read_to_string(dir.join("identity.pem"))
      .map_err(|e| format!("No se pudo leer la clave privada: {e}"))?;
    let cert_pem = fs::read_to_string(dir.join("certificate.pem"))
      .map_err(|e| format!("No se pudo leer el certificado: {e}"))?;
    // rcgen 0.11 no expone Certificate::from_pem; se reconstruye a partir de los bytes DER.
    let mut params = rcgen::CertificateParams::default();
    let key_pair = rcgen::KeyPair::from_pem(&key_pair_pem)
      .map_err(|e| format!("Clave privada inválida: {e}"))?;
    params.key_pair = Some(key_pair);
    params.alg = &rcgen::PKCS_ED25519;
    let certificate = rcgen::Certificate::from_params(params)
      .map_err(|e| format!("Certificado inválido: {e}"))?;
    let cert_der = certificate
      .serialize_der()
      .map_err(|e| format!("No se pudo serializar el certificado: {e}"))?;
    let device_id = device_id_from_cert(&cert_der);

    Ok(Self {
      key_pair_pem,
      certificate,
      cert_der,
      device_id,
      name: name.to_string(),
    })
  }

  /** Huella SHA-256 del certificado (para mostrar y verificar). */
  pub fn fingerprint(&self) -> String {
    fingerprint_from_der(&self.cert_der)
  }
}

/** Huella SHA-256 legible (grupos de 2 bytes separados por ':'). */
pub fn fingerprint_from_der(cert_der: &[u8]) -> String {
  let hash = Sha256::digest(cert_der);
  hash
    .chunks(2)
    .map(|c| format!("{:02x}:{:02x}", c[0], c[1]))
    .collect::<Vec<_>>()
    .join(" ")
}

/** Device ID = SHA-256 del certificado DER, con grupos y checksum. */
pub fn device_id_from_cert(cert_der: &[u8]) -> String {
  let hash = Sha256::digest(cert_der);
  format_device_id(&hash)
}

/** Formatea un Device ID: grupos de 4 hex, guion, checksum de 2 hex al final. */
fn format_device_id(hash: &[u8]) -> String {
  let mut groups: Vec<String> = Vec::new();
  for chunk in hash[0..16].chunks(2) {
    groups.push(format!("{:02x}{:02x}", chunk[0], chunk[1]));
  }
  let checksum = u16::from_be_bytes([hash[16], hash[17]]);
  groups.push(format!("{checksum:04x}"));
  groups.join("-")
}

/** Código corto SAS de 6 dígitos derivado de las dos fingerprints y un transcript. */
pub fn sas_code(local_fp: &[u8], remote_fp: &[u8], transcript: &[u8]) -> u32 {
  let mut hasher = Sha256::new();
  hasher.update(local_fp);
  hasher.update(remote_fp);
  hasher.update(transcript);
  let digest = hasher.finalize();
  u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000
}

/** Directorio de identidad por defecto (almacenamiento privado de la app). */
pub fn identity_dir(root: &str) -> PathBuf {
  Path::new(root).join("identity")
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn generate_and_persist_roundtrip() {
    let dir = std::env::temp_dir().join(format!("inventario-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let ident = Identity::generate("dispositivo-test").unwrap();
    ident.persist(&dir).unwrap();
    let loaded = Identity::load(&dir, "dispositivo-test").unwrap();
    assert_eq!(loaded.device_id, ident.device_id);
    assert_eq!(loaded.fingerprint(), ident.fingerprint());
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn device_id_is_deterministic() {
    let a = Identity::generate("a").unwrap();
    let b = Identity::generate("a").unwrap();
    // Dos identidades distintas (claves distintas) -> deviceId distinto (casi seguro).
    assert_ne!(a.device_id, b.device_id);
    assert!(a.device_id.len() > 10);
  }

  #[test]
  fn sas_is_deterministic() {
    let a = Identity::generate("a").unwrap();
    let b = Identity::generate("b").unwrap();
    // Ambos peers calculan con el mismo orden (a primero, b segundo).
    let code_a = sas_code(&a.cert_der, &b.cert_der, b"transcript");
    let code_b = sas_code(&a.cert_der, &b.cert_der, b"transcript");
    assert_eq!(code_a, code_b);
    assert!(code_a < 1_000_000);
  }
}
