use crate::sync::net::{
  is_lan_ip, local_ipv4_broadcasts, local_ipv4_interfaces,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;
use tokio::sync::watch;

/* ------------------------------------------------------------------ */
/* Descubrimiento automático en LAN (estilo Syncthing)                */
/* ------------------------------------------------------------------ */

pub const DISCOVERY_PORT: u16 = 14244;
/** Grupo multicast dentro de 224.0.0.0/24, como exige la política LAN. */
pub const DISCOVERY_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 42, 99);
pub const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(3);
/** Si no volvemos a oír a un dispositivo en este tiempo, lo ocultamos. */
pub const PEER_TTL_MS: u64 = 12_000;
const PROTOCOL_VERSION: u32 = 1;
const APP_ID: &str = "inventario-tienda";

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/** Anuncio UDP: solo metadatos, nunca datos ni secretos. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryAnnounce {
  pub app: String,
  pub protocol_version: u32,
  pub name: String,
  pub device_id: String,
  pub fingerprint: String,
  /// Puerto del servidor de sincronización normal.
  pub port: u16,
  pub pairing_port: u16,
  /// true mientras la ventana de emparejamiento está abierta.
  pub pairing_active: bool,
  pub sent_at: u64,
}

impl DiscoveryAnnounce {
  pub fn new(
    name: String,
    device_id: String,
    fingerprint: String,
    port: u16,
    pairing_port: u16,
  ) -> Self {
    Self {
      app: APP_ID.into(),
      protocol_version: PROTOCOL_VERSION,
      name,
      device_id,
      fingerprint,
      port,
      pairing_port,
      pairing_active: false,
      sent_at: now_ms(),
    }
  }
}

/** Dispositivo visto en la red local, listo para mostrar en la UI. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPeer {
  pub device_id: String,
  pub name: String,
  pub fingerprint: String,
  /// ip:puerto de sincronización.
  pub address: String,
  pub ip: String,
  pub sync_port: u16,
  pub pairing_port: u16,
  pub pairing_active: bool,
  pub last_seen: u64,
  /// Se completa en el manager comparando con peers.json.
  #[serde(default)]
  pub paired: bool,
}

impl DiscoveredPeer {
  fn from_announce(announce: &DiscoveryAnnounce, ip: IpAddr) -> Self {
    let sync_port = announce.port;
    Self {
      device_id: announce.device_id.clone(),
      name: announce.name.clone(),
      fingerprint: announce.fingerprint.clone(),
      address: SocketAddr::new(ip, sync_port).to_string(),
      ip: ip.to_string(),
      sync_port,
      pairing_port: announce.pairing_port,
      pairing_active: announce.pairing_active,
      last_seen: now_ms(),
      paired: false,
    }
  }
}

pub struct DiscoveryHandle {
  shutdown: watch::Sender<bool>,
  task: tokio::task::JoinHandle<()>,
  announce: Arc<Mutex<DiscoveryAnnounce>>,
  pub port: u16,
}

impl DiscoveryHandle {
  /** Actualiza el estado de emparejamiento sin reiniciar el anuncio. */
  pub fn set_pairing_active(&self, active: bool) {
    if let Ok(mut announce) = self.announce.lock() {
      announce.pairing_active = active;
      announce.sent_at = now_ms();
    }
  }

  pub fn stop(self) {
    let _ = self.shutdown.send(true);
    self.task.abort();
    #[cfg(target_os = "android")]
    {
      crate::android_fs::release_multicast_lock();
    }
  }
}

/**
 * Abre un socket UDP, se une al grupo multicast y responde anuncios.
 *
 * Se envían anuncios por multicast y por broadcast de cada interfaz: algunas
 * redes Wi-Fi (y ciertos routers domésticos) filtran multicast pero dejan
 * pasar broadcast, y viceversa. Así el descubrimiento es más tolerante que
 * depender de una sola técnica.
 */
pub async fn start_discovery(
  announce: DiscoveryAnnounce,
  app: AppHandle,
  discovered: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
) -> Result<DiscoveryHandle, String> {
  #[cfg(target_os = "android")]
  {
    // Android apaga el multicast de la Wi-Fi si no hay un MulticastLock.
    let _ = crate::android_fs::acquire_multicast_lock();
  }

  let socket = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT))
    .await
    .map_err(|e| {
      format!(
        "No se pudo abrir el puerto de descubrimiento UDP {DISCOVERY_PORT}: {e}"
      )
    })?;
  socket
    .set_broadcast(true)
    .map_err(|e| format!("No se pudo habilitar broadcast UDP: {e}"))?;

  let interfaces = local_ipv4_interfaces();
  let mut joined = 0usize;
  for ip in &interfaces {
    if socket.join_multicast_v4(DISCOVERY_GROUP, *ip).is_ok() {
      joined += 1;
    }
  }
  if joined == 0 {
    let _ = socket
      .join_multicast_v4(DISCOVERY_GROUP, Ipv4Addr::UNSPECIFIED);
  }

  let announce = Arc::new(Mutex::new(announce));
  let (shutdown, mut rx) = watch::channel(false);
  let task_announce = Arc::clone(&announce);
  let task = tokio::spawn(async move {
    let mut buf = [0u8; 4096];
    let mut ticker = tokio::time::interval(ANNOUNCE_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let broadcasts = local_ipv4_broadcasts();
    let mut last_snapshot: Option<Vec<(String, u64, bool, bool)>> = None;

    loop {
      tokio::select! {
        _ = rx.changed() => break,
        _ = ticker.tick() => {
          let payload = {
            let mut guard = task_announce.lock().unwrap_or_else(|e| e.into_inner());
            guard.sent_at = now_ms();
            serde_json::to_vec(&*guard).ok()
          };
          if let Some(bytes) = payload {
            let _ = socket
              .send_to(&bytes, (DISCOVERY_GROUP, DISCOVERY_PORT))
              .await;
            let _ = socket
              .send_to(&bytes, (Ipv4Addr::BROADCAST, DISCOVERY_PORT))
              .await;
            for broadcast in &broadcasts {
              let _ = socket.send_to(&bytes, (*broadcast, DISCOVERY_PORT)).await;
            }
          }
        }
        received = socket.recv_from(&mut buf) => {
          match received {
            Ok((len, remote)) => {
              if !is_lan_ip(remote.ip()) {
                continue;
              }
              let Ok(announce) = serde_json::from_slice::<DiscoveryAnnounce>(&buf[..len]) else {
                continue;
              };
              if announce.app != APP_ID
                || announce.protocol_version != PROTOCOL_VERSION
                || announce.device_id.trim().is_empty()
                || announce.fingerprint.trim().is_empty()
                || announce.port == 0
              {
                continue;
              }
              let own_id = task_announce
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .device_id
                .clone();
              if announce.device_id == own_id {
                continue;
              }
              let peer = DiscoveredPeer::from_announce(&announce, remote.ip());
              if let Ok(mut map) = discovered.lock() {
                map.insert(peer.device_id.clone(), peer);
              }
            }
            Err(_) => break,
          }
        }
      }

      let now = now_ms();
      let snapshot = {
        let mut map = discovered.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, peer| now.saturating_sub(peer.last_seen) < PEER_TTL_MS);
        let mut list: Vec<DiscoveredPeer> = map.values().cloned().collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let snapshot: Vec<(String, u64, bool, bool)> = list
          .iter()
          .map(|p| {
            (
              p.device_id.clone(),
              p.last_seen / 3000,
              p.pairing_active,
              p.paired,
            )
          })
          .collect();
        (list, snapshot)
      };

      if last_snapshot.as_ref() != Some(&snapshot.1) {
        last_snapshot = Some(snapshot.1);
        let _ = app.emit("sync-discovery", &snapshot.0);
      }
    }
  });

  Ok(DiscoveryHandle {
    shutdown,
    task,
    announce,
    port: DISCOVERY_PORT,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn announce_serializes() {
    let a = DiscoveryAnnounce {
      app: APP_ID.into(),
      protocol_version: 1,
      name: "Alice".into(),
      device_id: "abc123".into(),
      fingerprint: "fp".into(),
      port: 14242,
      pairing_port: 14243,
      pairing_active: false,
      sent_at: 1,
    };
    let json = serde_json::to_string(&a).unwrap();
    assert!(json.contains("Alice"));
    assert!(json.contains("abc123"));
  }

  #[test]
  fn discovered_peer_address_uses_sync_port() {
    let announce = DiscoveryAnnounce::new(
      "Alice".into(),
      "abc".into(),
      "fp".into(),
      14242,
      14243,
    );
    let peer = DiscoveredPeer::from_announce(&announce, IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)));
    assert_eq!(peer.address, "192.168.1.20:14242");
    assert_eq!(peer.ip, "192.168.1.20");
    assert!(!peer.paired);
  }
}
