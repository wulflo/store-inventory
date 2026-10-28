use crate::sync::framing::{read_frame_async, FrameType};
use crate::sync::identity::{fingerprint_from_der, Identity};
use crate::sync::pairing::now_ms;
use crate::sync::peer::Peer;
use crate::sync::protocol::{batch_events, divergent_domains, validate_incoming_event, SyncSummary};
use crate::sync::store::{append_missing, load_all, summaries_for};
use crate::sync::tls;
use crate::sync::wire::{read_json, write_json, EventsPayload, IdListPayload, SyncHello, SyncReport};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::CertificateDer;
use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;

/* ------------------------------------------------------------------ */
/* Cliente de sincronización                                          */
/* ------------------------------------------------------------------ */

// Una IP de LAN que no responde suele estar apagada o fuera de la red. Con
// 10 s el usuario veía "tiempo de espera agotado" y la app parecía colgada;
// 4 s permiten probar la siguiente dirección (p. ej. la descubierta) rápido.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const SYNC_TIMEOUT: Duration = Duration::from_secs(300);
const FUTURE_TOLERANCE_MS: u64 = 24 * 60 * 60 * 1000;

pub async fn sync_peer(
  identity: &Identity,
  root: &str,
  peer: &Peer,
  address: SocketAddr,
) -> Result<SyncReport, String> {
  if peer.cert_pem.trim().is_empty() {
    return Err(
      "Este peer fue emparejado con una versión anterior. Quitalo y volvé a emparejarlo."
        .into(),
    );
  }
  let expected_cert = CertificateDer::from_pem_slice(peer.cert_pem.as_bytes())
    .map_err(|e| format!("Certificado guardado del peer inválido: {e}"))?
    .as_ref()
    .to_vec();

  let local_all = load_all(root)?;
  let local_summary = SyncSummary::new(summaries_for(&local_all));

  let result = tokio::time::timeout(SYNC_TIMEOUT, async {
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address))
      .await
      .map_err(|_| format!("Tiempo de espera agotado conectando a {address}"))?
      .map_err(|e| format!("No se pudo conectar a {address}: {e}"))?;
    tcp.set_nodelay(true).ok();

    let config = tls::client_config(identity, &expected_cert)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let server_name = rustls::pki_types::ServerName::try_from("inventario-tienda.local")
      .map_err(|e| format!("Nombre TLS inválido: {e}"))?;
    let mut stream = connector
      .connect(server_name, tcp)
      .await
      .map_err(|e| format!("TLS rechazado por {address}: {e}"))?;

    let server_cert = stream
      .get_ref()
      .1
      .peer_certificates()
      .and_then(|certs| certs.first())
      .map(|c| c.as_ref().to_vec())
      .ok_or_else(|| "El servidor no presentó certificado.".to_string())?;
    if server_cert != expected_cert {
      return Err("El certificado del servidor cambió respecto al peer emparejado.".into());
    }

    write_json(
      &mut stream,
      FrameType::Handshake,
      &SyncHello {
        device_id: identity.device_id.clone(),
        name: identity.name.clone(),
        fingerprint: identity.fingerprint(),
        protocol_version: 1,
      },
    )
    .await?;
    write_json(&mut stream, FrameType::Summary, &local_summary).await?;

    let (kind, remote_hello): (FrameType, SyncHello) = read_json(&mut stream).await?;
    if kind != FrameType::Handshake {
      return Err("Se esperaba el saludo del servidor.".into());
    }
    if remote_hello.device_id != peer.device_id
      || !remote_hello.fingerprint.eq_ignore_ascii_case(&peer.fingerprint)
      || !remote_hello
        .fingerprint
        .eq_ignore_ascii_case(&fingerprint_from_der(&server_cert))
    {
      return Err(
        "La identidad del servidor no coincide con el peer emparejado. Cancelado por seguridad."
          .into(),
      );
    }

    let (kind, remote_summary): (FrameType, SyncSummary) = read_json(&mut stream).await?;
    if kind != FrameType::Summary {
      return Err("Se esperaba el resumen del servidor.".into());
    }
    if remote_summary.protocol_version != local_summary.protocol_version {
      return Err(format!(
        "Versiones de protocolo incompatibles (local {}, remoto {}).",
        local_summary.protocol_version, remote_summary.protocol_version
      ));
    }

    let divergent = divergent_domains(&local_summary.summaries, &remote_summary.summaries);
    let mut sent = 0usize;
    let mut received = 0usize;
    let mut domains = BTreeSet::new();
    let now = now_ms();

    // Solo intercambiamos listas de IDs en los dominios que realmente
    // difieren. Antes se enviaban los 14 dominios en cada pasada: aunque no
    // hubiera cambios, el otro lado tenía que recorrer todos los IDs y la
    // sincronización tardaba 10 s en cerrar (esperando el timeout de frame).
    let mut pending_id_lists: BTreeSet<String> =
      divergent.iter().map(|d| d.domain.clone()).collect();

    for d in &divergent {
      let events = local_all.get(&d.domain).cloned().unwrap_or_default();
      let ids: Vec<String> = events.iter().map(|e| e.id.clone()).collect();
      // Enviamos también listas vacías en los dominios divergentes: si el
      // otro equipo tiene eventos que nosotros no conocemos, necesita saber
      // que nos faltan todos para poder enviarlos.
      write_json(
        &mut stream,
        FrameType::IdList,
        &IdListPayload {
          domain: d.domain.clone(),
          ids,
        },
      )
      .await?;
    }

    // Sin dominios divergentes no hay nada que intercambiar: cerramos de
    // inmediato en vez de esperar 10 s a que venza el timeout de lectura.
    let mut sent_bye = false;
    if pending_id_lists.is_empty() {
      write_json(&mut stream, FrameType::Bye, &serde_json::json!({})).await?;
      sent_bye = true;
    }

    // Procesar IdList del servidor y enviar SOLO los eventos que le falten
    loop {
      // 10 s por frame: 2 s era demasiado agresivo en Wi-Fi y podía cortar
      // la recepción de lotes grandes antes de que llegaran todos.
      let frame = match tokio::time::timeout(std::time::Duration::from_secs(10), read_frame_async(&mut stream)).await {
        Ok(Ok(f)) => f,
        Ok(Err(e)) => return Err(format!("Error leyendo del peer: {e}")),
        Err(_) => {
          // Si ya enviamos Bye, el peer simplemente no lo confirmó; no es un
          // error de datos. Si todavía esperábamos listas, el peer se colgó.
          if !sent_bye {
            return Err("El peer dejó de responder durante la sincronización.".into());
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
          pending_id_lists.remove(&list.domain);
          let remote_ids: BTreeSet<String> = list.ids.into_iter().collect();
          let local_events = local_all.get(&list.domain).cloned().unwrap_or_default();
          let mut to_send: Vec<crate::sync::store_types::DomainEvent> = Vec::new();
          for ev in local_events {
            if !remote_ids.contains(&ev.id) {
              to_send.push(ev);
            }
          }
          if !to_send.is_empty() {
            for batch in batch_events(&list.domain, &to_send) {
              write_json(
                &mut stream,
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
          if pending_id_lists.is_empty() && !sent_bye {
            write_json(&mut stream, FrameType::Bye, &serde_json::json!({})).await?;
            sent_bye = true;
          }
        }
        FrameType::Events => {
          let payload: EventsPayload = serde_json::from_slice(&frame.payload)
            .map_err(|e| format!("Lote de eventos inválido: {e}"))?;
          if payload.events.len() > crate::sync::framing::MAX_BATCH_EVENTS {
            return Err("El peer envió demasiados eventos en un lote.".into());
          }
          for ev in &payload.events {
            validate_incoming_event(ev, now, FUTURE_TOLERANCE_MS)?;
            if ev.domain() != payload.domain {
              return Err(format!(
                "El peer envió un evento del dominio {} en el lote {}",
                ev.domain(),
                payload.domain
              ));
            }
          }
          let added = append_missing(root, &payload.domain, &payload.events)?;
          if added > 0 {
            received += added;
            domains.insert(payload.domain);
          }
        }
        FrameType::Bye => {
          if !sent_bye {
            let _ = write_json(&mut stream, FrameType::Bye, &serde_json::json!({})).await;
            sent_bye = true;
          }
          break;
        }
        FrameType::KeepAlive | FrameType::Summary | FrameType::BatchAck => {}
        FrameType::Handshake => {
          return Err("Frame inesperado durante la sincronización.".into());
        }
        FrameType::Error => {
          let msg = serde_json::from_slice::<crate::sync::wire::ErrorPayload>(&frame.payload)
            .map(|e| e.message)
            .unwrap_or_else(|_| "Error remoto desconocido".into());
          return Err(msg);
        }
      }
    }

    Ok(SyncReport {
      peer_id: peer.device_id.clone(),
      peer_name: peer.name.clone(),
      sent,
      received,
      domains: domains.into_iter().collect(),
      at: now_ms(),
    })
  })
  .await;

  match result {
    Ok(inner) => inner,
    Err(_) => Err("La sincronización superó el tiempo máximo de 5 minutos.".into()),
  }
}
