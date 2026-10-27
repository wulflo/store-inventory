use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ */
/* Descubrimiento LAN (ESQUELETO)                                     */
/* ------------------------------------------------------------------ */
/* Nota: el descubrimiento UDP multicast propio requiere implementación */
/* completa. Aquí se deja un esqueleto compilable que no abre sockets   */
/* reales.                                                              */
/* ------------------------------------------------------------------ */

/** Anuncio que se enviaría por multicast (solo metadatos, nunca datos). */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryAnnounce {
  pub name: String,
  pub device_id_hash: String,
  pub port: u16,
  pub protocol_version: u32,
}

/** Descubridor: anuncia y escucha anuncios en LAN (esqueleto). */
pub struct Discovery {
  name: String,
  device_id_hash: String,
  port: u16,
  started: bool,
}

impl Discovery {
  pub fn new(name: String, device_id_hash: String, port: u16) -> Self {
    Self {
      name,
      device_id_hash,
      port,
      started: false,
    }
  }

  /** Arranca (esqueleto: no abre socket UDP real). */
  pub async fn start(&mut self) -> Result<(), String> {
    self.started = true;
    eprintln!(
      "discovery esqueleto: {} en puerto {} (UDP multicast pendiente)",
      self.name, self.port
    );
    Ok(())
  }

  pub async fn stop(&mut self) {
    self.started = false;
  }

  pub fn announce(&self) -> DiscoveryAnnounce {
    DiscoveryAnnounce {
      name: self.name.clone(),
      device_id_hash: self.device_id_hash.clone(),
      port: self.port,
      protocol_version: 1,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn announce_serializes() {
    let a = DiscoveryAnnounce {
      name: "Alice".into(),
      device_id_hash: "abc123".into(),
      port: 14242,
      protocol_version: 1,
    };
    let json = serde_json::to_string(&a).unwrap();
    assert!(json.contains("Alice"));
    assert!(json.contains("abc123"));
  }

  #[test]
  fn discovery_start_stop() {
    let mut d = Discovery::new("test".into(), "hash".into(), 14242);
    assert!(!d.announce().name.is_empty());
  }
}
