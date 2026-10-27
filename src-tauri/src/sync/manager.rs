use crate::sync::client;
use crate::sync::identity::{cert_der_to_pem, fingerprint_from_der, identity_dir, Identity};
use crate::sync::net::{local_lan_addresses, validate_peer_addr};
use crate::sync::pairing::{
  connect_pairing, now_ms, PendingPairing, PairingRegistry, PAIRING_PORT, PAIRING_TTL_MS,
  SYNC_PORT,
};
use crate::sync::peer::{Peer, PeersStore};
use crate::sync::server::{
  start_pairing_server, start_sync_server, PairingServerHandle, SyncServerHandle,
};
use crate::sync::wire::SyncReport;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::CertificateDer;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex as AsyncMutex;

/* ------------------------------------------------------------------ */
/* Estado compartido del motor de sincronización                      */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize)]
pub struct IdentityInfo {
  pub device_id: String,
  pub name: String,
  pub fingerprint: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncLocalInfo {
  pub identity: Option<IdentityInfo>,
  pub addresses: Vec<String>,
  pub sync_port: u16,
  pub pairing_port: u16,
  pub running: bool,
  pub peer_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncBatchResult {
  pub reports: Vec<SyncReport>,
  pub errors: Vec<String>,
}

pub struct SyncManager {
  app: AppHandle,
  root: String,
  peers_path: PathBuf,
  peers: Arc<Mutex<PeersStore>>,
  identity: Mutex<Option<Identity>>,
  server: Mutex<Option<SyncServerHandle>>,
  pairing_server: Mutex<Option<PairingServerHandle>>,
  pending: Arc<Mutex<PairingRegistry>>,
  sync_lock: AsyncMutex<()>,
}

impl SyncManager {
  pub fn new(app: AppHandle) -> Self {
    let root = Self::resolve_data_root(&app);
    let peers_path = PathBuf::from(&root).join("sync").join("peers.json");
    let peers = PeersStore::load(&peers_path).unwrap_or_else(|_| PeersStore::new());
    Self {
      app,
      root,
      peers_path,
      peers: Arc::new(Mutex::new(peers)),
      identity: Mutex::new(None),
      server: Mutex::new(None),
      pairing_server: Mutex::new(None),
      pending: Arc::new(Mutex::new(PairingRegistry::new())),
      sync_lock: AsyncMutex::new(()),
    }
  }

  /**
   * La UI y el motor de sincronización deben trabajar sobre la misma carpeta.
   *
   * En escritorio conservamos el layout histórico (`~/.local/share/...`), que
   * es el que devuelve el comando `store_default_root`. En Android usamos el
   * almacenamiento privado de la app. Antes de este ajuste el motor usaba
   * `app_data_dir()` en escritorio y la UI `~/.local/share/...`, así que la
   * sincronización leía y escribía archivos distintos.
   */
  fn resolve_data_root(app: &AppHandle) -> String {
    #[cfg(target_os = "android")]
    {
      app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".into())
    }
    #[cfg(not(target_os = "android"))]
    {
      crate::event_store::default_root().unwrap_or_else(|_| {
        app
          .path()
          .app_data_dir()
          .map(|p| p.to_string_lossy().to_string())
          .unwrap_or_else(|_| ".".into())
      })
    }
  }

  /** Persiste la identidad en el almacenamiento privado de la app. */
  pub fn ensure_identity(&self, name: &str) -> Result<Identity, String> {
    let mut guard = self.identity.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut ident) = guard.clone() {
      let trimmed = name.trim();
      if !trimmed.is_empty() && ident.name != trimmed {
        ident.name = trimmed.to_string();
        ident.persist(&identity_dir(&self.root))?;
        *guard = Some(ident.clone());
      }
      return Ok(ident);
    }
    let dir = identity_dir(&self.root);
    let mut ident = match Identity::load(&dir, name) {
      Ok(ident) => ident,
      Err(_) => {
        let ident = Identity::generate(name)?;
        ident.persist(&dir)?;
        ident
      }
    };
    if !name.trim().is_empty() {
      ident.name = name.trim().to_string();
    }
    // Aseguramos que la identidad recién cargada también quede persistida.
    ident.persist(&dir)?;
    *guard = Some(ident.clone());
    Ok(ident)
  }

  /**
   * Obtiene la identidad para una sincronización sin renombrar el dispositivo.
   *
   * `sync_peer` se puede ejecutar antes de abrir Ajustes. En ese caso cargamos
   * la identidad existente (con su nombre persistido) o generamos una con un
   * nombre neutro, pero nunca pisamos el nombre elegido por el usuario.
   */
  fn identity_for_sync(&self) -> Result<Identity, String> {
    let mut guard = self.identity.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(ident) = guard.as_ref() {
      return Ok(ident.clone());
    }
    let dir = identity_dir(&self.root);
    let mut ident = match Identity::load(&dir, "") {
      Ok(ident) => ident,
      Err(_) => Identity::generate("Este equipo")?,
    };
    if ident.name.trim().is_empty() {
      ident.name = "Este equipo".into();
    }
    ident.persist(&dir)?;
    *guard = Some(ident.clone());
    Ok(ident)
  }

  pub fn identity_info(&self) -> Option<IdentityInfo> {
    self
      .identity
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .as_ref()
      .map(|ident| IdentityInfo {
        device_id: ident.device_id.clone(),
        name: ident.name.clone(),
        fingerprint: ident.fingerprint(),
      })
  }

  pub fn is_running(&self) -> bool {
    self
      .server
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .is_some()
  }

  pub fn local_info(&self) -> SyncLocalInfo {
    SyncLocalInfo {
      identity: self.identity_info(),
      addresses: local_lan_addresses(),
      sync_port: SYNC_PORT,
      pairing_port: PAIRING_PORT,
      running: self.is_running(),
      peer_count: self
        .peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .list()
        .len(),
    }
  }

  pub async fn start(&self, name: &str) -> Result<SyncLocalInfo, String> {
    let identity = self.ensure_identity(name)?;
    if self.is_running() {
      return Ok(self.info_with_identity(identity));
    }
    let handle = start_sync_server(
      identity.clone(),
      Arc::clone(&self.peers),
      self.peers_path.clone(),
      self.root.clone(),
      self.app.clone(),
    )
    .await?;
    {
      let mut guard = self.server.lock().unwrap_or_else(|e| e.into_inner());
      if guard.is_some() {
        handle.stop();
      } else {
        *guard = Some(handle);
      }
    }
    let _ = self.app.emit("sync-status", self.local_info());
    Ok(self.info_with_identity(identity))
  }

  fn info_with_identity(&self, identity: Identity) -> SyncLocalInfo {
    let mut info = self.local_info();
    let fingerprint = identity.fingerprint();
    info.identity = Some(IdentityInfo {
      device_id: identity.device_id.clone(),
      name: identity.name.clone(),
      fingerprint,
    });
    info
  }

  pub fn stop(&self) {
    let handle = self
      .server
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(handle) = handle {
      handle.stop();
    }
    let pairing = self
      .pairing_server
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(pairing) = pairing {
      pairing.stop();
    }
    let _ = self.app.emit("sync-status", self.local_info());
  }

  pub fn list_peers(&self) -> Vec<Peer> {
    self
      .peers
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .list()
      .into_iter()
      .cloned()
      .collect()
  }

  /** Abre la ventana de emparejamiento durante 2 minutos. */
  pub async fn start_pairing(&self, name: &str) -> Result<(SyncLocalInfo, u64), String> {
    let identity = self.ensure_identity(name)?;
    let old = self
      .pairing_server
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(old) = old {
      old.stop();
    }
    let handle = start_pairing_server(
      identity.clone(),
      SYNC_PORT,
      Arc::clone(&self.pending),
      PAIRING_TTL_MS,
    )
    .await?;
    let expires_at = handle.expires_at;
    *self
      .pairing_server
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = Some(handle);
    Ok((self.info_with_identity(identity), expires_at))
  }

  pub fn stop_pairing(&self) {
    let old = self
      .pairing_server
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(old) = old {
      old.stop();
    }
  }

  pub fn pending_pairing(&self) -> Option<PendingPairing> {
    let mut reg = self.pending.lock().unwrap_or_else(|e| e.into_inner());
    reg.prune();
    reg.first()
  }

  /** Inicia el emparejamiento contra la IP del otro dispositivo. */
  pub async fn connect_pairing(&self, name: &str, address: &str) -> Result<PendingPairing, String> {
    let identity = self.ensure_identity(name)?;
    let mut addr = validate_peer_addr(address, PAIRING_PORT)?;
    // Si el usuario pegó la dirección de sincronización (14242), usamos el
    // puerto de emparejamiento en la misma IP.
    if addr.port() == SYNC_PORT {
      addr.set_port(PAIRING_PORT);
    }
    let pending = connect_pairing(&identity, addr, SYNC_PORT).await?;
    self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .add(pending.clone());
    Ok(pending)
  }

  pub fn confirm_pairing(&self, device_id: &str) -> Result<Peer, String> {
    let pending = {
      let mut reg = self.pending.lock().unwrap_or_else(|e| e.into_inner());
      reg.prune();
      reg.remove(device_id)
    }
    .ok_or_else(|| "El emparejamiento expiró o ya no está disponible.".to_string())?;

    let cert_der = CertificateDer::from_pem_slice(pending.cert_pem.as_bytes())
      .map_err(|e| format!("Certificado del peer inválido: {e}"))?
      .as_ref()
      .to_vec();
    if fingerprint_from_der(&cert_der) != pending.fingerprint {
      return Err("El certificado del peer no coincide con la huella mostrada.".into());
    }

    let mut peer = Peer::new(
      pending.device_id.clone(),
      pending.name.clone(),
      pending.fingerprint.clone(),
    )
    .with_cert(cert_der_to_pem(&cert_der));
    peer.address = Some(pending.address);
    peer.trusted = true;

    {
      let mut store = self.peers.lock().unwrap_or_else(|e| e.into_inner());
      store.add_or_update(peer.clone());
      store.persist(&self.peers_path)?;
    }
    // Emparejamiento completado: liberamos la ventana/listener temporal.
    self.stop_pairing();
    let _ = self.app.emit("sync-peers-updated", self.list_peers());
    Ok(peer)
  }

  pub fn reject_pairing(&self, device_id: &str) {
    let _ = self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .remove(device_id);
  }

  pub fn set_peer_address(
    &self,
    device_id: &str,
    address: Option<&str>,
  ) -> Result<Peer, String> {
    let normalized = match address {
      Some(text) if !text.trim().is_empty() => {
        Some(validate_peer_addr(text, SYNC_PORT)?.to_string())
      }
      _ => None,
    };
    let mut store = self.peers.lock().unwrap_or_else(|e| e.into_inner());
    let mut peer = store
      .trusted_by_device_id(device_id)
      .cloned()
      .ok_or_else(|| "El dispositivo no está emparejado.".to_string())?;
    peer.address = normalized;
    store.add_or_update(peer.clone());
    store.persist(&self.peers_path)?;
    drop(store);
    let _ = self.app.emit("sync-peers-updated", self.list_peers());
    Ok(peer)
  }

  pub fn remove_peer(&self, device_id: &str) -> Result<(), String> {
    let mut store = self.peers.lock().unwrap_or_else(|e| e.into_inner());
    store.remove(device_id);
    store.persist(&self.peers_path)?;
    drop(store);
    let _ = self.app.emit("sync-peers-updated", self.list_peers());
    Ok(())
  }

  pub async fn sync_peer(
    &self,
    device_id: &str,
    address_override: Option<&str>,
  ) -> Result<SyncReport, String> {
    let identity = self.identity_for_sync()?;
    let peer = {
      let store = self.peers.lock().unwrap_or_else(|e| e.into_inner());
      store
        .trusted_by_device_id(device_id)
        .cloned()
        .ok_or_else(|| "El dispositivo no está emparejado.".to_string())?
    };
    let address_text = address_override
      .map(str::to_string)
      .or_else(|| peer.address.clone())
      .ok_or_else(|| "No hay dirección configurada para este peer.".to_string())?;
    let addr = validate_peer_addr(&address_text, SYNC_PORT)?;

    let _guard = self.sync_lock.lock().await;
    let report = client::sync_peer(&identity, &self.root, &peer, addr).await?;

    {
      let mut store = self.peers.lock().unwrap_or_else(|e| e.into_inner());
      store.mark_seen(device_id, Some(&addr.to_string()));
      store.persist(&self.peers_path)?;
    }
    let _ = self.app.emit("sync-updated", &report);
    Ok(report)
  }

  pub async fn sync_all(&self) -> Result<SyncBatchResult, String> {
    let peers = self.list_peers();
    if peers.is_empty() {
      return Err("No hay dispositivos emparejados.".into());
    }
    let mut reports = Vec::new();
    let mut errors = Vec::new();
    for peer in peers {
      match self.sync_peer(&peer.device_id, None).await {
        Ok(report) => reports.push(report),
        Err(e) => errors.push(format!("{}: {e}", peer.name)),
      }
    }
    Ok(SyncBatchResult { reports, errors })
  }
}
