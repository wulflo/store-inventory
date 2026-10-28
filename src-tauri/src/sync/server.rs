use crate::sync::framing::{read_frame_async, FrameType};
use crate::sync::identity::{device_id_from_cert, fingerprint_from_der, Identity};
use crate::sync::net::is_lan_ip;
use crate::sync::pairing::{now_ms, PairingRegistry};
use crate::sync::ports::SyncPorts;
use crate::sync::peer::PeersStore;
use crate::sync::protocol::{batch_events, diff_summaries, validate_incoming_event, SyncSummary};
use crate::sync::store::{append_missing, load_all, summaries_for};
use crate::sync::tls;
use crate::sync::wire::{
  read_json, send_error, write_json, EventsPayload, IdListPayload, SyncHello, SyncReport,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio_rustls::TlsAcceptor;

/* ------------------------------------------------------------------ */
/* Servidor de sincronización                                         */
/* ------------------------------------------------------------------ */

const FUTURE_TOLERANCE_MS: u64 = 24 * 60 * 60 * 1000;
const CONNECTION_TIMEOUT: Duration = Duration::from_secs(300);

pub struct SyncServerHandle {
  shutdown: watch::Sender<bool>,
  task: tokio::task::JoinHandle<()>,
  pub port: u16,
}

impl SyncServerHandle {
  pub fn stop(self) {
    let _ = self.shutdown.send(true);
    self.task.abort();
  }
}

/**
 * Escucha conexiones entrantes en `ports.sync` y atiende a cada peer
 * emparejado en su propia tarea.
 */
pub async fn start_sync_server(
  identity: Identity,
  peers: Arc<Mutex<PeersStore>>,
  peers_path: PathBuf,
  root: String,
  app: AppHandle,
  ports: SyncPorts,
) -> Result<SyncServerHandle, String> {
  let listener = TcpListener::bind(("0.0.0.0", ports.sync))
    .await
    .map_err(|e| {
      format!(
        "No se pudo abrir el puerto {}: {e}. ¿Ya hay otra instancia u otra app usándolo?",
        ports.sync
      )
    })?;
  let config = tls::server_config(&identity, Arc::clone(&peers))?;
  let acceptor = TlsAcceptor::from(Arc::new(config));
  let (shutdown, mut rx) = watch::channel(false);

  let task = tokio::spawn(async move {
    use std::collections::HashMap;
    use std::time::{Duration, Instant};
    let mut rate_limit: HashMap<std::net::IpAddr, (u32, Instant)> = HashMap::new();
    let rate_limit_window = Duration::from_secs(60);
    let rate_limit_max = 20u32;

    loop {
      tokio::select! {
        _ = rx.changed() => break,
        accepted = listener.accept() => {
          match accepted {
            Ok((tcp, remote)) => {
              let ip = remote.ip();
              if !is_lan_ip(ip) {
                println!("[sync] RECHAZO: IP no LAN intentó conectar: {}", ip);
                continue;
              }
              // Rate limiting por IP
              let now = Instant::now();
              let entry = rate_limit.entry(ip).or_insert((0, now));
              if now.duration_since(entry.1) > rate_limit_window {
                *entry = (1, now);
              } else {
                entry.0 += 1;
                if entry.0 > rate_limit_max {
                  println!("[sync] RECHAZO rate-limit: {} superó {} conexiones/min", ip, rate_limit_max);
                  continue;
                }
              }
              let acceptor = acceptor.clone();
              let peers = Arc::clone(&peers);
              let peers_path = peers_path.clone();
              let root = root.clone();
              let app = app.clone();
              let identity = identity.clone();
              tokio::spawn(async move {
                let _ = tokio::time::timeout(
                  CONNECTION_TIMEOUT,
                  handle_connection(tcp, acceptor, identity, peers, peers_path, root, app),
                )
                .await;
              });
            }
            Err(_) => break,
          }
        }
      }
    }
  });

  Ok(SyncServerHandle {
    shutdown,
    task,
    port: ports.sync,
  })
}

async fn handle_connection(
  tcp: TcpStream,
  acceptor: TlsAcceptor,
  identity: Identity,
  peers: Arc<Mutex<PeersStore>>,
  peers_path: PathBuf,
  root: String,
  app: AppHandle,
) {
  let mut stream = match acceptor.accept(tcp).await {
    Ok(stream) => stream,
    Err(_) => return, // Certificado no emparejado o handshake inválido.
  };

  let peer_der = match stream
    .get_ref()
    .1
    .peer_certificates()
    .and_then(|certs| certs.first())
    .map(|c| c.as_ref().to_vec())
  {
    Some(der) => der,
    None => {
      send_error(&mut stream, "Falta el certificado del cliente.").await;
      return;
    }
  };

  match serve_authenticated(
    &mut stream,
    &identity,
    &peer_der,
    peers,
    &peers_path,
    &root,
  )
  .await
  {
    Ok(report) => {
      let _ = app.emit("sync-updated", &report);
    }
    Err(e) => send_error(&mut stream, e).await,
  }
}

async fn serve_authenticated(
  stream: &mut tokio_rustls::server::TlsStream<TcpStream>,
  identity: &Identity,
  peer_der: &[u8],
  peers: Arc<Mutex<PeersStore>>,
  peers_path: &PathBuf,
  root: &str,
) -> Result<SyncReport, String> {
  let fingerprint = fingerprint_from_der(peer_der);
  let expected_device = device_id_from_cert(peer_der);

  let (kind, hello): (FrameType, SyncHello) = read_json(stream).await?;
  if kind != FrameType::Handshake {
    return Err("Se esperaba el saludo del cliente.".into());
  }
  if hello.device_id != expected_device
    || !hello.fingerprint.eq_ignore_ascii_case(&fingerprint)
    || hello.protocol_version != 1
  {
    return Err("La identidad del cliente no coincide con su certificado.".into());
  }
  let (peer_name, peer_id) = {
    let store = peers.lock().unwrap_or_else(|e| e.into_inner());
    match store.trusted_by_fingerprint(&fingerprint) {
      Some(peer) => (peer.name.clone(), peer.device_id.clone()),
      None => {
        println!("[sync] RECHAZO pinning: fingerprint {} no está en peers confiables", fingerprint);
        return Err("El cliente no está emparejado.".into());
      }
    }
  };

  write_json(
    stream,
    FrameType::Handshake,
    &SyncHello {
      device_id: identity.device_id.clone(),
      name: identity.name.clone(),
      fingerprint: identity.fingerprint(),
      protocol_version: 1,
    },
  )
  .await?;

  let (kind, client_summary): (FrameType, SyncSummary) = read_json(stream).await?;
  if kind != FrameType::Summary {
    return Err("Se esperaba el resumen del cliente.".into());
  }
  if client_summary.protocol_version != 1 {
    return Err("Versión de protocolo incompatible.".into());
  }

  let local_all = load_all(root)?;
  let local_summary = SyncSummary::new(summaries_for(&local_all));
  write_json(stream, FrameType::Summary, &local_summary).await?;

  let diff = diff_summaries(&client_summary.summaries, &local_summary.summaries);
  let now = now_ms();
  let mut received = 0usize;
  let mut sent = 0usize;
  let mut domains = std::collections::BTreeSet::new();

  // Enviar lista de IDs que YA tenemos por dominio
  let mut domains_to_consider: Vec<String> = local_all.keys().cloned().collect();
  for d in diff.keys() {
    if !domains_to_consider.contains(d) {
      domains_to_consider.push(d.clone());
    }
  }
  domains_to_consider.sort();

  for domain in &domains_to_consider {
    let events = local_all.get(domain).cloned().unwrap_or_default();
    let ids: Vec<String> = events.iter().map(|e| e.id.clone()).collect();
    if !ids.is_empty() {
      write_json(
        stream,
        FrameType::IdList,
        &IdListPayload {
          domain: domain.clone(),
          ids,
        },
      )
      .await?;
    }
  }

  let mut sent_bye = false;
  loop {
    let frame = match tokio::time::timeout(std::time::Duration::from_secs(2), read_frame_async(stream)).await {
      Ok(Ok(f)) => f,
      Ok(Err(e)) => return Err(format!("Error leyendo del cliente: {e}")),
      Err(_) => {
        if !sent_bye {
          let _ = write_json(stream, FrameType::Bye, &serde_json::json!({})).await;
          sent_bye = true;
        }
        break;
      }
    };
    match frame.r#type {
      FrameType::IdList => {
        let list: IdListPayload = serde_json::from_slice(&frame.payload)
          .map_err(|e| format!("IdList inválido: {e}"))?;
        if list.domain.is_empty() {
          continue;
        }
        let client_ids: std::collections::BTreeSet<String> = list.ids.into_iter().collect();
        let local_events = local_all.get(&list.domain).cloned().unwrap_or_default();
        let mut to_send: Vec<crate::sync::store_types::DomainEvent> = Vec::new();
        for ev in local_events {
          if !client_ids.contains(&ev.id) {
            to_send.push(ev);
          }
        }
        if !to_send.is_empty() {
          for batch in batch_events(&list.domain, &to_send) {
            write_json(
              stream,
              FrameType::Events,
              &EventsPayload {
                domain: batch.domain.clone(),
                events: batch.events.clone(),
              },
            )
            .await?;
            sent += batch.events.len();
            domains.insert(batch.domain.clone());
          }
        }
      }
      FrameType::Events => {
        let payload: EventsPayload = serde_json::from_slice(&frame.payload)
          .map_err(|e| format!("Lote de eventos inválido: {e}"))?;
        if payload.events.len() > crate::sync::framing::MAX_BATCH_EVENTS {
          send_error(stream, "Demasiados eventos en un lote").await;
          return Err("El cliente envió demasiados eventos en un lote.".into());
        }
        for ev in &payload.events {
          if let Err(msg) = validate_incoming_event(ev, now, FUTURE_TOLERANCE_MS) {
            send_error(stream, &msg).await;
            return Err(msg);
          }
          if ev.domain() != payload.domain {
            let msg = format!(
              "El cliente envió un evento del dominio {} en el lote {}",
              ev.domain(),
              payload.domain
            );
            send_error(stream, &msg).await;
            return Err(msg);
          }
        }
        let added = append_missing(root, &payload.domain, &payload.events)?;
        if added > 0 {
          received += added;
          domains.insert(payload.domain.clone());
        }
      }
      FrameType::Bye => {
        if !sent_bye {
          let _ = write_json(stream, FrameType::Bye, &serde_json::json!({})).await;
          sent_bye = true;
        }
        break;
      }
      FrameType::KeepAlive | FrameType::BatchAck => {}
      FrameType::Error => {
        let msg = serde_json::from_slice::<crate::sync::wire::ErrorPayload>(&frame.payload)
          .map(|e| e.message)
          .unwrap_or_else(|_| "Error remoto desconocido".into());
        return Err(msg);
      }
      FrameType::Handshake | FrameType::Summary => {
        send_error(stream, "Frame inesperado durante la sincronización").await;
        return Err("Frame inesperado durante la sincronización.".into());
      }
    }
  }
  let _ = write_json(stream, FrameType::Bye, &serde_json::json!({})).await;

  // Actualizamos last_seen del peer y persistimos (best-effort).
  {
    let mut store = peers.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut peer) = store.remove(&peer_id) {
      peer.last_seen = Some(now);
      peer.trusted = true;
      store.add_or_update(peer);
    }
    let _ = store.persist(peers_path);
  }

  Ok(SyncReport {
    peer_id,
    peer_name,
    sent,
    received,
    domains: domains.into_iter().collect(),
    at: now,
  })
}

/* ------------------------------------------------------------------ */
/* Servidor temporal de emparejamiento                               */
/* ------------------------------------------------------------------ */

pub struct PairingServerHandle {
  shutdown: watch::Sender<bool>,
  task: tokio::task::JoinHandle<()>,
}

impl PairingServerHandle {
  pub fn stop(self) {
    let _ = self.shutdown.send(true);
    self.task.abort();
  }
}

pub async fn start_pairing_server(
  identity: Identity,
  ports: SyncPorts,
  registry: Arc<Mutex<PairingRegistry>>,
  pairing_token: Arc<Mutex<Option<(String, u64)>>>,
  app: AppHandle,
) -> Result<PairingServerHandle, String> {
  let listener = TcpListener::bind(("0.0.0.0", ports.pairing))
    .await
    .map_err(|e| {
      format!(
        "No se pudo abrir el puerto de emparejamiento {}: {e}",
        ports.pairing
      )
    })?;
  let config = Arc::new(tls::pairing_server_config(&identity)?);
  let (shutdown, mut rx) = watch::channel(false);

  let task = tokio::spawn(async move {
    loop {
      tokio::select! {
        _ = rx.changed() => break,
        accepted = listener.accept() => {
          match accepted {
            Ok((tcp, remote)) => {
              if !is_lan_ip(remote.ip()) { continue; }
              let config = Arc::clone(&config);
              let registry = Arc::clone(&registry);
              let identity = identity.clone();
              let pairing_token = Arc::clone(&pairing_token);
              let app = app.clone();
              tokio::spawn(async move {
                // Solo aceptamos el token del QR mientras siga vigente. Si no
                // hay token (o expiró), la solicitud queda pendiente de que el
                // usuario compare el SAS y confirme.
                let expected = {
                  let guard = pairing_token.lock().unwrap_or_else(|e| e.into_inner());
                  guard
                    .as_ref()
                    .filter(|(_, expires)| now_ms() < *expires)
                    .map(|(token, _)| token.clone())
                };
                if let Ok(pending) = crate::sync::pairing::accept_pairing(
                  &identity,
                  tcp,
                  ports.sync,
                  config,
                  expected.as_deref(),
                ).await {
                  registry.lock().unwrap_or_else(|e| e.into_inner()).add(pending.clone());
                  // Avisamos a la UI aunque el usuario no esté en Ajustes.
                  let _ = app.emit("sync-pairing-request", &pending);
                }
              });
            }
            Err(_) => break,
          }
        }
      }
    }
  });

  Ok(PairingServerHandle {
    shutdown,
    task,
  })
}

#[cfg(test)]
mod sync_tests {
  use super::*;
  use crate::sync::identity::cert_der_to_pem;
  use crate::sync::peer::Peer;
  use crate::sync::store::{append_missing, load_all};
  use crate::sync::store_types::{DomainEvent, EventMetadata};
  use std::sync::atomic::{AtomicU64, Ordering};

  static NEXT_ID: AtomicU64 = AtomicU64::new(0);

  fn temp_root(label: &str) -> String {
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
      "inventario-sync-{label}-{}-{id}",
      std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir.to_string_lossy().to_string()
  }

  fn event(id: &str, device: &str, hlc: u64) -> DomainEvent {
    DomainEvent {
      id: id.into(),
      type_: "Order.Created".into(),
      payload: serde_json::json!({ "orderId": id }),
      metadata: EventMetadata {
        hlc,
        device_id: device.into(),
        timestamp: hlc,
        version: 1,
      },
    }
  }

  #[tokio::test]
  async fn exchanges_events_over_pinned_mtls() {
    let server_identity = Identity::generate("Servidor").unwrap();
    let client_identity = Identity::generate("Cliente").unwrap();
    let root_server = temp_root("server");
    let root_client = temp_root("client");

    let client_peer = Peer::new(
      client_identity.device_id.clone(),
      "Cliente".into(),
      client_identity.fingerprint(),
    )
    .with_cert(cert_der_to_pem(&client_identity.cert_der));
    let mut server_peers = PeersStore::new();
    server_peers.add_or_update(client_peer);
    let server_peers = Arc::new(Mutex::new(server_peers));
    let peers_path = PathBuf::from(&root_server).join("peers.json");

    let client_server_peer = Peer::new(
      server_identity.device_id.clone(),
      "Servidor".into(),
      server_identity.fingerprint(),
    )
    .with_cert(cert_der_to_pem(&server_identity.cert_der));

    let server_config = Arc::new(
      tls::server_config(&server_identity, Arc::clone(&server_peers)).unwrap(),
    );
    let acceptor = TlsAcceptor::from(server_config);
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn({
      let root = root_server.clone();
      let peers = Arc::clone(&server_peers);
      let identity = server_identity.clone();
      async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut stream = acceptor.accept(tcp).await.unwrap();
        let peer_der = stream
          .get_ref()
          .1
          .peer_certificates()
          .unwrap()
          .first()
          .unwrap()
          .as_ref()
          .to_vec();
        serve_authenticated(&mut stream, &identity, &peer_der, peers, &peers_path, &root)
          .await
          .unwrap()
      }
    });

    append_missing(
      &root_server,
      "orders",
      &[event("server-order", &server_identity.device_id, 10)],
    )
    .unwrap();
    append_missing(
      &root_client,
      "orders",
      &[event("client-order", &client_identity.device_id, 20)],
    )
    .unwrap();

    let report = crate::sync::client::sync_peer(
      &client_identity,
      &root_client,
      &client_server_peer,
      addr,
    )
    .await
    .unwrap();
    assert_eq!(report.sent, 1);
    assert_eq!(report.received, 1);

    let server_report = server.await.unwrap();
    assert_eq!(server_report.sent, 1);
    assert_eq!(server_report.received, 1);

    let server_events = load_all(&root_server).unwrap();
    let client_events = load_all(&root_client).unwrap();
    let server_orders = &server_events["orders"];
    let client_orders = &client_events["orders"];
    assert_eq!(server_orders.len(), 2);
    assert_eq!(client_orders.len(), 2);
    assert!(server_orders.iter().any(|e| e.id == "client-order"));
    assert!(client_orders.iter().any(|e| e.id == "server-order"));

    let _ = std::fs::remove_dir_all(root_server);
    let _ = std::fs::remove_dir_all(root_client);
  }
}
