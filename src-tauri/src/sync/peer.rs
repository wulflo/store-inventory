use crate::sync::identity::{cert_der_to_pem, device_id_from_cert, fingerprint_from_der};
use crate::sync::pairing::PendingPairing;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::CertificateDer;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/* ------------------------------------------------------------------ */
/* Dispositivos de confianza (peers emparejados)                      */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Peer {
  pub device_id: String,
  pub name: String,
  pub fingerprint: String, // SHA-256 del certificado, legible
  pub trusted: bool,
  pub paired_at: u64,
  pub last_seen: Option<u64>,
  pub address: Option<String>, // "ip:puerto" última dirección conocida
  /// Certificado X.509 del peer en PEM. Se usa para fijar (pin) su identidad
  /// en cada conexión TLS. Los peers creados antes de la fase 2 no lo tienen
  /// y deben volver a emparejarse.
  #[serde(default)]
  pub cert_pem: String,
}

impl Peer {
  pub fn new(device_id: String, name: String, fingerprint: String) -> Self {
    Self {
      device_id,
      name,
      fingerprint,
      trusted: true,
      paired_at: std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0),
      last_seen: None,
      address: None,
      cert_pem: String::new(),
    }
  }

  pub fn with_cert(mut self, cert_pem: String) -> Self {
    self.cert_pem = cert_pem;
    self
  }
}

/**
 * Convierte una solicitud de emparejamiento en un peer de confianza,
 * verificando que el certificado corresponda a la huella mostrada.
 */
pub fn peer_from_pending(pending: &PendingPairing) -> Result<Peer, String> {
  let cert_der = CertificateDer::from_pem_slice(pending.cert_pem.as_bytes())
    .map_err(|e| format!("Certificado del peer inválido: {e}"))?
    .as_ref()
    .to_vec();
  if !fingerprint_from_der(&cert_der).eq_ignore_ascii_case(&pending.fingerprint) {
    return Err("El certificado del peer no coincide con la huella mostrada.".into());
  }
  if device_id_from_cert(&cert_der) != pending.device_id {
    return Err("El identificador del peer no coincide con su certificado.".into());
  }

  let mut peer = Peer::new(
    pending.device_id.clone(),
    pending.name.clone(),
    pending.fingerprint.clone(),
  )
  .with_cert(cert_der_to_pem(&cert_der));
  peer.address = Some(pending.address.clone());
  peer.trusted = true;
  Ok(peer)
}

/* ------------------------------------------------------------------ */
/* Almacenamiento de peers                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeersStore {
  pub peers: BTreeMap<String, Peer>,
}

impl PeersStore {
  pub fn new() -> Self {
    Self {
      peers: BTreeMap::new(),
    }
  }

  pub fn add_or_update(&mut self, peer: Peer) {
    self.peers.insert(peer.device_id.clone(), peer);
  }

  pub fn get(&self, device_id: &str) -> Option<&Peer> {
    self.peers.get(device_id)
  }

  pub fn list(&self) -> Vec<&Peer> {
    self.peers.values().collect()
  }

  /** Devuelve el peer de confianza cuyo certificado tiene esta huella. */
  pub fn trusted_by_fingerprint(&self, fingerprint: &str) -> Option<&Peer> {
    self
      .peers
      .values()
      .find(|p| p.trusted && p.fingerprint.eq_ignore_ascii_case(fingerprint))
  }

  /** Devuelve el peer de confianza con este device id. */
  pub fn trusted_by_device_id(&self, device_id: &str) -> Option<&Peer> {
    self.peers.get(device_id).filter(|p| p.trusted)
  }

  pub fn remove(&mut self, device_id: &str) -> Option<Peer> {
    self.peers.remove(device_id)
  }

  pub fn revoke(&mut self, device_id: &str) -> Option<Peer> {
    if let Some(peer) = self.peers.get_mut(device_id) {
      peer.trusted = false;
      return Some(peer.clone());
    }
    None
  }

  pub fn mark_seen(&mut self, device_id: &str, address: Option<&str>) {
    if let Some(peer) = self.peers.get_mut(device_id) {
      peer.last_seen = Some(
        std::time::SystemTime::now()
          .duration_since(std::time::UNIX_EPOCH)
          .map(|d| d.as_millis() as u64)
          .unwrap_or(0),
      );
      if let Some(addr) = address {
        peer.address = Some(addr.to_string());
      }
    }
  }

  pub fn persist(&self, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
      fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear carpeta de peers: {e}"))?;
    }
    let json = serde_json::to_string_pretty(self)
      .map_err(|e| format!("No se pudo serializar peers: {e}"))?;
    fs::write(path, json).map_err(|e| format!("No se pudo escribir peers: {e}"))
  }

  pub fn load(path: &Path) -> Result<Self, String> {
    if !path.exists() {
      return Ok(Self::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("No se pudo leer peers: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("Peers inválidos: {e}"))
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sync::identity::Identity;
  use std::env::temp_dir;

  fn pending_from(identity: &Identity) -> PendingPairing {
    PendingPairing {
      device_id: identity.device_id.clone(),
      name: identity.name.clone(),
      fingerprint: identity.fingerprint(),
      sas: "123456".into(),
      address: "192.168.1.50:14242".into(),
      cert_pem: cert_der_to_pem(&identity.cert_der),
      created_at: 1,
      expires_at: u64::MAX,
      verified: true,
    }
  }

  #[test]
  fn pending_peer_is_created_only_with_the_matching_certificate() {
    let identity = Identity::generate("Telefono").unwrap();
    let pending = pending_from(&identity);

    let peer = peer_from_pending(&pending).unwrap();
    assert_eq!(peer.device_id, identity.device_id);
    assert_eq!(peer.fingerprint, identity.fingerprint());
    assert_eq!(peer.address.as_deref(), Some("192.168.1.50:14242"));
    assert!(peer.trusted);

    let mut tampered = pending.clone();
    tampered.fingerprint = "00:00:00".into();
    assert!(peer_from_pending(&tampered).is_err());

    let mut wrong_id = pending;
    wrong_id.device_id = "otro-dispositivo".into();
    assert!(peer_from_pending(&wrong_id).is_err());
  }

  #[test]
  fn add_and_revoke_peer() {
    let mut store = PeersStore::new();
    let p = Peer::new("dev-1".into(), "Alice".into(), "fp:1234".into());
    store.add_or_update(p.clone());
    assert_eq!(store.list().len(), 1);
    assert!(store.get("dev-1").is_some());

    let revoked = store.revoke("dev-1").unwrap();
    assert!(!revoked.trusted);
    let still = store.get("dev-1").unwrap();
    assert!(!still.trusted);
  }

  #[test]
  fn persist_and_load_roundtrip() {
    let dir = temp_dir().join(format!("inventario-peers-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    let path = dir.join("peers.json");
    let mut store = PeersStore::new();
    store.add_or_update(Peer::new("dev-1".into(), "Alice".into(), "fp:1".into()));
    store.persist(&path).unwrap();
    let loaded = PeersStore::load(&path).unwrap();
    assert_eq!(loaded.list().len(), 1);
    assert_eq!(loaded.get("dev-1").unwrap().name, "Alice");
    let _ = fs::remove_dir_all(&dir);
  }
}
