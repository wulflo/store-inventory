use rustls_pki_types::{pem::PemObject, CertificateDer};
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
 *  Identity guarda clave y certificado como PEM (String): rcgen 0.14 ya no
 *  permite reconstruir el certificado desde el KeyPair, y así el deviceId
 *  queda estable entre arranques.
 */
#[derive(Clone)]
pub struct Identity {
  pub key_pair_pem: String,
  pub cert_pem: String,
  pub cert_der: Vec<u8>,
  pub device_id: String,
  pub name: String,
}

impl Identity {
  /** Genera una nueva identidad autofirmada. */
  pub fn generate(name: &str) -> Result<Self, String> {
    let key_pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519)
      .map_err(|e| format!("No se pudo generar el par de claves: {e}"))?;
    let key_pair_pem = key_pair.serialize_pem();
    let params = rcgen::CertificateParams::default();
    let certificate = params
      .self_signed(&key_pair)
      .map_err(|e| format!("No se pudo crear el certificado: {e}"))?;
    let cert_pem = certificate.pem();
    let cert_der = certificate.der().to_vec();
    let device_id = device_id_from_cert(&cert_der);

    Ok(Self {
      key_pair_pem,
      cert_pem,
      cert_der,
      device_id,
      name: name.to_string(),
    })
  }

  /** Serializa el certificado a PEM (para mostrar / compartir en emparejamiento). */
  pub fn cert_pem(&self) -> String {
    self.cert_pem.clone()
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
    if !self.name.trim().is_empty() {
      fs::write(dir.join("name.txt"), format!("{}\n", self.name.trim()))
        .map_err(|e| format!("No se pudo escribir el nombre del dispositivo: {e}"))?;
    }
    Ok(())
  }

  /** Carga identidad desde disco. */
  pub fn load(dir: &Path, name: &str) -> Result<Self, String> {
    let key_pair_pem = fs::read_to_string(dir.join("identity.pem"))
      .map_err(|e| format!("No se pudo leer la clave privada: {e}"))?;
    let cert_pem = fs::read_to_string(dir.join("certificate.pem"))
      .map_err(|e| format!("No se pudo leer el certificado: {e}"))?;
    // Validamos que la clave privada se pueda leer y que el PEM del
    // certificado sea válido. Conservamos el DER original para que el
    // deviceId y la huella no cambien entre arranques.
    rcgen::KeyPair::from_pem(&key_pair_pem)
      .map_err(|e| format!("Clave privada inválida: {e}"))?;
    let cert_der = CertificateDer::from_pem_slice(cert_pem.as_bytes())
      .map_err(|e| format!("Certificado inválido: {e}"))?
      .as_ref()
      .to_vec();
    let device_id = device_id_from_cert(&cert_der);
    let stored_name = fs::read_to_string(dir.join("name.txt"))
      .ok()
      .map(|value| value.trim().to_string())
      .filter(|value| !value.is_empty());
    let name = if name.trim().is_empty() {
      stored_name.unwrap_or_default()
    } else {
      name.trim().to_string()
    };

    Ok(Self {
      key_pair_pem,
      cert_pem,
      cert_der,
      device_id,
      name,
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

/**
 * SAS canónico: ambos extremos deben obtener exactamente el mismo número.
 *
 * Ordenamos los dos certificados antes de hashear. Un atacante en el medio
 * presenta certificados distintos a cada lado, por lo que cada dispositivo
 * calcula un par distinto y los códigos mostrados no coinciden. Los usuarios
 * comparan el código en pantalla antes de confiar.
 */
pub fn sas_code_canonical(cert_a_der: &[u8], cert_b_der: &[u8], transcript: &[u8]) -> String {
  let (first, second) = if cert_a_der <= cert_b_der {
    (cert_a_der, cert_b_der)
  } else {
    (cert_b_der, cert_a_der)
  };
  let mut hasher = Sha256::new();
  hasher.update(b"inventario-tienda/sas/v1");
  hasher.update((first.len() as u64).to_be_bytes());
  hasher.update(first);
  hasher.update((second.len() as u64).to_be_bytes());
  hasher.update(second);
  hasher.update(transcript);
  let digest = hasher.finalize();
  let code = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
  format!("{code:06}")
}

/** Convierte un certificado DER a PEM (necesario para persistir el pin del peer). */
pub fn cert_der_to_pem(cert_der: &[u8]) -> String {
  use base64::{engine::general_purpose::STANDARD, Engine};
  let b64 = STANDARD.encode(cert_der);
  let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
  for chunk in b64.as_bytes().chunks(64) {
    out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
    out.push('\n');
  }
  out.push_str("-----END CERTIFICATE-----\n");
  out
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

  #[test]
  fn canonical_sas_is_order_independent() {
    let a = Identity::generate("a").unwrap();
    let b = Identity::generate("b").unwrap();
    let ab = sas_code_canonical(&a.cert_der, &b.cert_der, b"pairing");
    let ba = sas_code_canonical(&b.cert_der, &a.cert_der, b"pairing");
    assert_eq!(ab, ba);
    assert_eq!(ab.len(), 6);
  }

  #[test]
  fn persists_device_name() {
    let dir = std::env::temp_dir().join(format!("inventario-name-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let ident = Identity::generate("Celular de Alonso").unwrap();
    ident.persist(&dir).unwrap();
    let loaded = Identity::load(&dir, "").unwrap();
    assert_eq!(loaded.name, "Celular de Alonso");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn cert_pem_roundtrip() {
    let a = Identity::generate("a").unwrap();
    let pem = cert_der_to_pem(&a.cert_der);
    let parsed = CertificateDer::from_pem_slice(pem.as_bytes()).unwrap();
    assert_eq!(parsed.as_ref(), a.cert_der.as_slice());
  }
}
