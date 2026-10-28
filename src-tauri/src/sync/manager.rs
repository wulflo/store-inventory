use crate::sync::client;
use crate::sync::discovery::{
  start_discovery, DiscoveredPeer, DiscoveryAnnounce, DiscoveryHandle,
};
use crate::sync::identity::{cert_der_to_pem, fingerprint_from_der, identity_dir, Identity};
use crate::sync::net::{
  local_lan_addresses, preferred_lan_ipv4, validate_peer_addr,
};
use crate::sync::pairing::{
  connect_pairing, now_ms, PairQrPayload, PendingPairing, PairingRegistry, PAIRING_QR_TTL_MS,
};
use crate::sync::ports::SyncPorts;
use crate::sync::peer::{Peer, PeersStore};
use crate::sync::server::{
  start_pairing_server, start_sync_server, PairingServerHandle, SyncServerHandle,
};
use crate::sync::wire::SyncReport;
use rand::RngCore;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::CertificateDer;
use serde::Serialize;
use std::collections::HashMap;
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
  ports_path: PathBuf,
  ports: Mutex<SyncPorts>,
  peers: Arc<Mutex<PeersStore>>,
  identity: Mutex<Option<Identity>>,
  server: Mutex<Option<SyncServerHandle>>,
  pairing_server: Mutex<Option<PairingServerHandle>>,
  pairing_token: Arc<Mutex<Option<(String, u64)>>>,
  pending: Arc<Mutex<PairingRegistry>>,
  discovery: Mutex<Option<DiscoveryHandle>>,
  discovered: Arc<Mutex<HashMap<String, DiscoveredPeer>>>,
  sync_lock: AsyncMutex<()>,
}

impl SyncManager {
  pub fn new(app: AppHandle) -> Self {
    let root = Self::resolve_data_root(&app);
    let peers_path = PathBuf::from(&root).join("sync").join("peers.json");
    let ports_path = PathBuf::from(&root).join("sync").join("ports.json");
    let ports = SyncPorts::load(&ports_path);
    let peers = PeersStore::load(&peers_path).unwrap_or_else(|_| PeersStore::new());
    Self {
      app,
      root,
      peers_path,
      ports_path,
      ports: Mutex::new(ports),
      peers: Arc::new(Mutex::new(peers)),
      identity: Mutex::new(None),
      server: Mutex::new(None),
      pairing_server: Mutex::new(None),
      pairing_token: Arc::new(Mutex::new(None)),
      pending: Arc::new(Mutex::new(PairingRegistry::new())),
      discovery: Mutex::new(None),
      discovered: Arc::new(Mutex::new(HashMap::new())),
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

  pub fn ports(&self) -> SyncPorts {
    *self.ports.lock().unwrap_or_else(|e| e.into_inner())
  }

  pub fn local_info(&self) -> SyncLocalInfo {
    let ports = self.ports();
    SyncLocalInfo {
      identity: self.identity_info(),
      addresses: local_lan_addresses(),
      sync_port: ports.sync,
      pairing_port: ports.pairing,
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
      let _ = self.ensure_pairing_inbox(&identity).await;
      self.ensure_discovery(&identity).await;
      self.set_discovery_pairing_active(true);
      return Ok(self.info_with_identity(identity));
    }
    let handle = start_sync_server(
      identity.clone(),
      Arc::clone(&self.peers),
      self.peers_path.clone(),
      self.root.clone(),
      self.app.clone(),
      self.ports(),
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
    // Mantenemos abierta una "bandeja" de emparejamiento mientras la
    // sincronización esté activa. Así una solicitud manual de Android no se
    // pierde si el usuario de escritorio no abrió el QR en ese momento.
    let _ = self.ensure_pairing_inbox(&identity).await;
    self.ensure_discovery(&identity).await;
    self.set_discovery_pairing_active(true);
    let _ = self.app.emit("sync-status", self.local_info());
    Ok(self.info_with_identity(identity))
  }

  /**
   * Cambia el puerto de sincronización (y el siguiente para emparejamiento).
   * Si la sincronización está activa, la reinicia con los puertos nuevos.
   */
  pub async fn set_ports(&self, name: &str, base: u16) -> Result<SyncLocalInfo, String> {
    let next = SyncPorts::from_base(base)?;
    if next == self.ports() {
      let identity = self.ensure_identity(name)?;
      return Ok(self.info_with_identity(identity));
    }

    let _guard = self.sync_lock.lock().await;
    let previous = self.ports();
    let was_running = self.is_running();

    if was_running {
      self.stop();
    }
    *self.ports.lock().unwrap_or_else(|e| e.into_inner()) = next;

    if let Err(err) = next.save(&self.ports_path) {
      *self.ports.lock().unwrap_or_else(|e| e.into_inner()) = previous;
      if was_running {
        let _ = self.start(name).await;
      }
      return Err(err);
    }

    if !was_running {
      let identity = self.ensure_identity(name)?;
      return Ok(self.info_with_identity(identity));
    }

    match self.start(name).await {
      Ok(info) => Ok(info),
      Err(err) => {
        // El puerto nuevo no se pudo abrir: restauramos el anterior para no
        // dejar la app sin sincronización por un cambio fallido.
        *self.ports.lock().unwrap_or_else(|e| e.into_inner()) = previous;
        let _ = previous.save(&self.ports_path);
        let restart = self.start(name).await;
        let suffix = match restart {
          Ok(_) => "Se restauraron los puertos anteriores.".to_string(),
          Err(restore_err) => {
            format!("Tampoco se pudo reiniciar con los puertos anteriores: {restore_err}")
          }
        };
        Err(format!("{err} {suffix}"))
      }
    }
  }

  /** Abre el listener de emparejamiento si todavía no está activo. */
  async fn ensure_pairing_inbox(&self, identity: &Identity) -> Result<(), String> {
    if self
      .pairing_server
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .is_some()
    {
      return Ok(());
    }
    match start_pairing_server(
      identity.clone(),
      self.ports(),
      Arc::clone(&self.pending),
      Arc::clone(&self.pairing_token),
      self.app.clone(),
    )
    .await
    {
      Ok(handle) => {
        *self
          .pairing_server
          .lock()
          .unwrap_or_else(|e| e.into_inner()) = Some(handle);
        Ok(())
      }
      Err(err) => {
        // La sincronización por IP sigue funcionando aunque el puerto de
        // emparejamiento esté ocupado.
        println!("[sync] bandeja de emparejamiento deshabilitada: {err}");
        Err(err)
      }
    }
  }

  fn set_discovery_pairing_active(&self, active: bool) {
    if let Some(discovery) = self
      .discovery
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .as_ref()
    {
      discovery.set_pairing_active(active);
    }
  }

  /** Arranca (una sola vez) el anuncio/escucha UDP de descubrimiento. */
  async fn ensure_discovery(&self, identity: &Identity) {
    let already_running = self
      .discovery
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .is_some();
    if already_running {
      return;
    }
    let ports = self.ports();
    let announce = DiscoveryAnnounce::new(
      identity.name.clone(),
      identity.device_id.clone(),
      identity.fingerprint(),
      ports.sync,
      ports.pairing,
    );
    match start_discovery(
      announce,
      self.app.clone(),
      Arc::clone(&self.discovered),
    )
    .await
    {
      Ok(handle) => {
        *self
          .discovery
          .lock()
          .unwrap_or_else(|e| e.into_inner()) = Some(handle);
      }
      Err(err) => {
        // La sincronización por IP sigue funcionando aunque falle el anuncio.
        println!("[sync] descubrimiento deshabilitado: {err}");
      }
    }
  }

  /** Lista de dispositivos vistos en la LAN, marcando los ya emparejados. */
  pub fn list_discovered(&self) -> Vec<DiscoveredPeer> {
    let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
    let mut list: Vec<DiscoveredPeer> = self
      .discovered
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .values()
      .cloned()
      .map(|mut peer| {
        peer.paired = peers
          .trusted_by_device_id(&peer.device_id)
          .is_some()
          || peers.trusted_by_fingerprint(&peer.fingerprint).is_some();
        peer
      })
      .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
  }

  /** Dirección conocida por descubrimiento (si el dispositivo está en la LAN). */
  fn discovered_address(&self, device_id: &str) -> Option<String> {
    self
      .discovered
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .get(device_id)
      .map(|peer| peer.address.clone())
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
    *self
      .pairing_token
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = None;
    self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .clear();
    let discovery = self
      .discovery
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .take();
    if let Some(discovery) = discovery {
      discovery.stop();
    }
    self
      .discovered
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .clear();
    let _ = self.app.emit("sync-discovery", Vec::<DiscoveredPeer>::new());
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

  fn new_pairing_token() -> String {
    let mut bytes = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
  }

  /** Abre una ventana de QR y devuelve el token de un solo uso. */
  pub async fn start_pairing(&self, name: &str) -> Result<(SyncLocalInfo, u64, String), String> {
    let identity = self.ensure_identity(name)?;
    self.ensure_pairing_inbox(&identity).await?;
    {
      let mut reg = self.pending.lock().unwrap_or_else(|e| e.into_inner());
      reg.clear();
    }
    let token = Self::new_pairing_token();
    let expires_at = now_ms() + PAIRING_QR_TTL_MS;
    *self
      .pairing_token
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = Some((token.clone(), expires_at));
    self.set_discovery_pairing_active(true);
    Ok((self.info_with_identity(identity), expires_at, token))
  }

  /** Construye el contenido del QR con la IP LAN preferida. */
  pub fn pairing_qr(&self, info: &SyncLocalInfo, token: &str) -> Result<String, String> {
    let identity = info
      .identity
      .as_ref()
      .ok_or_else(|| "Todavía no hay identidad de dispositivo.".to_string())?;
    let ip = preferred_lan_ipv4()
      .map(|ip| ip.to_string())
      .or_else(|| {
        info
          .addresses
          .iter()
          .find(|address| address.parse::<std::net::Ipv4Addr>().is_ok())
          .cloned()
      })
      .ok_or_else(|| {
        "No se encontró una IP LAN. Conectate a la misma red Wi-Fi que el otro dispositivo."
          .to_string()
      })?;
    let payload = PairQrPayload {
      v: 1,
      app: "inventario-tienda".into(),
      addr: format!("{ip}:{}", info.pairing_port),
      fp: identity.fingerprint.clone(),
      id: identity.device_id.clone(),
      name: identity.name.clone(),
      token: token.to_string(),
    };
    payload.encode()
  }

  /**
   * Cierra la ventana del QR, pero deja la bandeja de emparejamiento activa
   * para que sigan llegando solicitudes manuales.
   */
  pub fn stop_pairing(&self) {
    *self
      .pairing_token
      .lock()
      .unwrap_or_else(|e| e.into_inner()) = None;
    self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .clear();
    self.set_discovery_pairing_active(true);
  }

  pub fn pending_pairing(&self) -> Option<PendingPairing> {
    let verified = {
      let mut reg = self.pending.lock().unwrap_or_else(|e| e.into_inner());
      reg.prune();
      reg.first().filter(|pending| pending.verified)
    };
    if let Some(pending) = verified {
      // El peer demostró leer el QR: no hace falta que el usuario vuelva a
      // confirmar el SAS en este lado.
      match self.confirm_pairing(&pending.device_id) {
        Ok(peer) => {
          let _ = self.app.emit("sync-pairing-completed", &peer);
          return None;
        }
        Err(err) => {
          println!("[sync] no se pudo confirmar el emparejamiento QR: {err}");
        }
      }
    }
    let mut reg = self.pending.lock().unwrap_or_else(|e| e.into_inner());
    reg.prune();
    reg.first()
  }

  /** Inicia el emparejamiento contra la IP del otro dispositivo (SAS manual). */
  pub async fn connect_pairing(&self, name: &str, address: &str) -> Result<PendingPairing, String> {
    let identity = self.ensure_identity(name)?;
    let ports = self.ports();
    let mut addr = validate_peer_addr(address, ports.pairing)?;
    // Si el usuario pegó la dirección de sincronización, usamos el puerto de
    // emparejamiento en la misma IP.
    if addr.port() == ports.sync {
      addr.set_port(ports.pairing);
    }
    let pending = connect_pairing(&identity, addr, ports.sync, None).await?;
    self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .add(pending.clone());
    Ok(pending)
  }

  /**
   * Empareja escaneando un QR: valida la huella del QR contra el certificado
   * real del peer, envía el token y confirma automáticamente en este lado.
   */
  pub async fn connect_pairing_qr(&self, name: &str, payload: &str) -> Result<Peer, String> {
    let qr = PairQrPayload::decode(payload)?;
    let identity = self.ensure_identity(name)?;
    let ports = self.ports();
    let mut addr = validate_peer_addr(&qr.addr, ports.pairing)?;
    if addr.port() == ports.sync {
      addr.set_port(ports.pairing);
    }
    let pending = match connect_pairing(&identity, addr, ports.sync, Some(&qr.token)).await {
      Ok(pending) => pending,
      Err(first_error) => {
        // Si la IP del QR no responde (por ejemplo, el QR se generó con otra
        // interfaz de red), reintentamos con la dirección vista por discovery.
        let fallback = self
          .discovered
          .lock()
          .unwrap_or_else(|e| e.into_inner())
          .get(&qr.id)
          .map(|peer| format!("{}:{}", peer.ip, peer.pairing_port));
        match fallback {
          Some(address) => {
            let mut alt = validate_peer_addr(&address, ports.pairing)?;
            if alt.port() == ports.sync {
              alt.set_port(ports.pairing);
            }
            connect_pairing(&identity, alt, ports.sync, Some(&qr.token))
              .await
              .map_err(|e| format!("{first_error}. Reintento por LAN: {e}"))?
          }
          None => return Err(first_error),
        }
      }
    };
    if !pending.fingerprint.eq_ignore_ascii_case(&qr.fp) || pending.device_id != qr.id {
      return Err(
        "El dispositivo que respondió no coincide con el QR. No se emparejó por seguridad."
          .into(),
      );
    }
    self
      .pending
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .add(pending.clone());
    self.confirm_pairing(&pending.device_id)
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
    // Emparejamiento completado: cerramos la ventana del QR, pero la bandeja
    // de emparejamiento sigue escuchando para futuras solicitudes.
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
        Some(validate_peer_addr(text, self.ports().sync)?.to_string())
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
    let mut candidates: Vec<String> = Vec::new();
    for candidate in [
      address_override.map(str::to_string),
      peer.address.clone(),
      self.discovered_address(device_id),
    ]
    .into_iter()
    .flatten()
    {
      if !candidate.trim().is_empty() && !candidates.contains(&candidate) {
        candidates.push(candidate);
      }
    }
    if candidates.is_empty() {
      return Err(
        "No hay dirección configurada para este peer. Abrí Ajustes y esperá a que aparezca en la red."
          .into(),
      );
    }

    let _guard = self.sync_lock.lock().await;
    let sync_port = self.ports().sync;
    let mut last_error = String::from("No se pudo conectar con el dispositivo.");
    let mut report: Option<SyncReport> = None;
    let mut used_address = String::new();
    for address_text in candidates {
      let addr = match validate_peer_addr(&address_text, sync_port) {
        Ok(addr) => addr,
        Err(err) => {
          last_error = err;
          continue;
        }
      };
      match client::sync_peer(&identity, &self.root, &peer, addr).await {
        Ok(value) => {
          used_address = addr.to_string();
          report = Some(value);
          break;
        }
        Err(err) => {
          last_error = err;
        }
      }
    }
    let report = report.ok_or(last_error)?;

    {
      let mut store = self.peers.lock().unwrap_or_else(|e| e.into_inner());
      store.mark_seen(device_id, Some(&used_address));
      store.persist(&self.peers_path)?;
    }
    let _ = self.app.emit("sync-updated", &report);
    Ok(report)
  }

  pub async fn sync_all(&self) -> Result<SyncBatchResult, String> {
    let peers = self.list_peers();
    if peers.is_empty() {
      // Sin peers no es un error: el auto-sync simplemente no tiene nada que hacer.
      return Ok(SyncBatchResult {
        reports: Vec::new(),
        errors: Vec::new(),
      });
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

  /**
   * Busca dispositivos con la ventana de emparejamiento abierta escaneando su
   * puerto TCP en la misma subred /24. Es el plan B cuando el firewall bloquea
   * UDP/multicast y el descubrimiento automático no ve al otro dispositivo.
   */
  pub async fn scan_lan(&self) -> Result<Vec<String>, String> {
    use std::net::{Ipv4Addr, SocketAddr};
    use std::time::Duration;
    use tokio::net::TcpStream;
    use tokio::task::JoinSet;

    let mut targets: Vec<Ipv4Addr> = Vec::new();
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
      for iface in interfaces {
        if iface.is_loopback() {
          continue;
        }
        if let if_addrs::IfAddr::V4(v4) = iface.addr {
          if !v4.ip.is_private() {
            continue;
          }
          let base = u32::from(v4.ip) & 0xFFFF_FF00;
          for host in 1..=254u32 {
            let ip = Ipv4Addr::from(base | host);
            if ip == v4.ip {
              continue;
            }
            if !targets.contains(&ip) {
              targets.push(ip);
            }
          }
        }
      }
    }
    if targets.is_empty() {
      return Err(
        "No se encontró una red IPv4 local. Conectate a la misma Wi-Fi que el otro dispositivo."
          .into(),
      );
    }

    let pairing_port = self.ports().pairing;
    let mut tasks = JoinSet::new();
    for ip in targets {
      tasks.spawn(async move {
        let addr = SocketAddr::from((ip, pairing_port));
        match tokio::time::timeout(Duration::from_millis(220), TcpStream::connect(addr)).await {
          Ok(Ok(_)) => Some(ip.to_string()),
          _ => None,
        }
      });
    }

    let mut found = Vec::new();
    while let Some(result) = tasks.join_next().await {
      if let Ok(Some(ip)) = result {
        found.push(ip);
      }
    }
    found.sort();
    Ok(found)
  }
}
