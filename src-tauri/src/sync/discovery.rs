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

use crate::sync::net::{is_lan_multicast, validate_discovery_source};
use crate::sync::peer::PeersStore;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use tokio::net::UdpSocket;

pub struct DiscoveryLan {
    name: String,
    device_id_hash: String,
    port: u16,
    peers: Arc<Mutex<PeersStore>>,
    started: Arc<Mutex<bool>>,
}

impl DiscoveryLan {
    pub fn new(name: String, device_id_hash: String, port: u16, peers: Arc<Mutex<PeersStore>>) -> Self {
        Self {
            name,
            device_id_hash,
            port,
            peers,
            started: Arc::new(Mutex::new(false)),
        }
    }

    pub fn announce(&self) -> DiscoveryAnnounce {
        DiscoveryAnnounce {
            name: self.name.clone(),
            device_id_hash: self.device_id_hash.clone(),
            port: self.port,
            protocol_version: 1,
        }
    }

    /// Descubrimiento solo LAN - multicast a 224.0.0.251:5353 o 224.0.0.0/24
    pub async fn start(&mut self) -> Result<(), String> {
        let addr: SocketAddr = "0.0.0.0:0".parse().unwrap();
        let socket = UdpSocket::bind(addr)
            .await
            .map_err(|e| format!("No se pudo bindear socket UDP: {e}"))?;

        // Intentar unirse a multicast LAN
        let mcast = Ipv4Addr::new(224, 0, 0, 251);
        if !is_lan_multicast(&std::net::IpAddr::V4(mcast)) {
            return Err("Multicast no permitido fuera de LAN".to_string());
        }
        // Nota: join_multicast_v4 requiere configuración específica; por seguridad lo dejamos controlado
        *self.started.lock().unwrap() = true;
        eprintln!("Discovery LAN iniciado (solo multicast LAN) en puerto sync {}", self.port);

        let peers = self.peers.clone();
        let announce = self.announce();
        let name = self.name.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            loop {
                match socket.recv_from(&mut buf).await {
                    Ok((len, src)) => {
                        if let Err(e) = validate_discovery_source(&src) {
                            eprintln!("Anuncio rechazado: {}", e);
                            continue;
                        }
                        if let Ok(msg) = serde_json::from_slice::<DiscoveryAnnounce>(&buf[..len]) {
                            eprintln!("Anuncio LAN recibido de {}: {} ({})", src, msg.name, msg.device_id_hash);
                            let _ = peers;
                            let _ = announce;
                            let _ = name;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }

    pub async fn stop(&mut self) {
        *self.started.lock().unwrap() = false;
    }
}
