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
    }
  }
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
  use std::env::temp_dir;

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
