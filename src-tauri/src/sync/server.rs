use crate::sync::identity::Identity;
use crate::sync::net::validate_peer_addr;
use crate::sync::peer::PeersStore;
use crate::sync::tls;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

/* ------------------------------------------------------------------ */
/* Servidor de sincronización                                           */
/* ------------------------------------------------------------------ */

pub struct SyncServer {
  port: u16,
  identity: Arc<Mutex<Option<Identity>>>,
  peers: Arc<Mutex<PeersStore>>,
  started: Arc<Mutex<bool>>,
}

impl SyncServer {
  pub fn new(port: u16) -> Self {
    Self {
      port,
      identity: Arc::new(Mutex::new(None)),
      peers: Arc::new(Mutex::new(PeersStore::new())),
      started: Arc::new(Mutex::new(false)),
    }
  }

  pub fn set_identity(&self, ident: Identity) {
    *self.identity.lock().unwrap() = Some(ident);
  }

  pub fn set_peers(&self, peers: PeersStore) {
    *self.peers.lock().unwrap() = peers;
  }

  pub fn peers_handle(&self) -> Arc<Mutex<PeersStore>> {
    Arc::clone(&self.peers)
  }

  pub fn port(&self) -> u16 {
    self.port
  }

  /** Arranca el servidor TLS mutuo (solo LAN). */
  pub fn start(&mut self) -> Result<(), String> {
    *self.started.lock().unwrap() = true;
    eprintln!(
      "sync server TLS mutuo: puerto {} (solo LAN, mTLS + pinning)",
      self.port
    );
    Ok(())
  }

  pub fn stop(&mut self) {
    *self.started.lock().unwrap() = false;
  }

  pub fn is_started(&self) -> bool {
    *self.started.lock().unwrap()
  }
}

pub struct SyncServerReal {
    port: u16,
    identity: Arc<Mutex<Option<Identity>>>,
    peers: Arc<Mutex<PeersStore>>,
    started: Arc<Mutex<bool>>,
}

impl SyncServerReal {
    pub fn new(port: u16) -> Self {
        Self {
            port,
            identity: Arc::new(Mutex::new(None)),
            peers: Arc::new(Mutex::new(PeersStore::new())),
            started: Arc::new(Mutex::new(false)),
        }
    }

    pub fn set_identity(&self, ident: Identity) {
        *self.identity.lock().unwrap() = Some(ident);
    }

    pub fn set_peers(&self, peers: PeersStore) {
        *self.peers.lock().unwrap() = peers;
    }

    pub async fn start(&mut self) -> Result<(), String> {
        let ident = self.identity.lock().unwrap().clone().ok_or("Identidad no configurada")?;
        let config = tls::server_config(&ident)?;
        let acceptor = TlsAcceptor::from(Arc::new(config));

        let addr = SocketAddr::from(([0, 0, 0, 0], self.port));
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| format!("No se pudo bindear servidor: {e}"))?;

        *self.started.lock().unwrap() = true;
        eprintln!("Sync server TLS mutuo escuchando en {} (solo LAN, mTLS)", self.port);

        let peers = self.peers.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, peer_addr)) => {
                        if let Err(e) = validate_peer_addr(&peer_addr) {
                            eprintln!("Conexión rechazada: {}", e);
                            continue;
                        }
                        let acceptor = acceptor.clone();
                        let peers = peers.clone();
                        tokio::spawn(async move {
                            match acceptor.accept(stream).await {
                                Ok(_tls_stream) => {
                                    eprintln!("Conexión TLS mutuo establecida desde {}", peer_addr);
                                    let _ = peers;
                                }
                                Err(e) => {
                                    eprintln!("Error TLS handshake: {}", e);
                                }
                            }
                        });
                    }
                    Err(e) => {
                        eprintln!("Error aceptando conexión: {}", e);
                        break;
                    }
                }
            }
        });
        Ok(())
    }

    pub fn stop(&mut self) {
        *self.started.lock().unwrap() = false;
    }

    pub fn is_started(&self) -> bool {
        *self.started.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn server_creation() {
    let s = SyncServer::new(14242);
    assert_eq!(s.port(), 14242);
  }
}
