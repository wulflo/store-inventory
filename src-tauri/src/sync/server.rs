use crate::sync::identity::Identity;
use crate::sync::peer::PeersStore;
use std::sync::{Arc, Mutex};

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

  pub fn start(&mut self) -> Result<(), String> {
    *self.started.lock().unwrap() = true;
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
