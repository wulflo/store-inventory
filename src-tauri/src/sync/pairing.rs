use crate::sync::identity::{
  cert_der_to_pem, device_id_from_cert, fingerprint_from_der, sas_code_canonical, Identity,
};
use crate::sync::net::validate_peer_addr;
use crate::sync::tls;
use crate::sync::framing::FrameType;
use crate::sync::wire::{read_json, write_json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;

/* ------------------------------------------------------------------ */
/* Emparejamiento con confirmación SAS                                 */
/* ------------------------------------------------------------------ */

pub const PAIRING_PORT: u16 = crate::sync::ports::DEFAULT_PAIRING_PORT;
/// Tiempo que una solicitud pendiente espera confirmación SAS.
pub const PAIRING_TTL_MS: u64 = 300_000;
/// Vigencia del token de un QR. Pasado ese tiempo, la conexión sigue siendo
/// válida pero requiere confirmación manual del SAS.
pub const PAIRING_QR_TTL_MS: u64 = 120_000;

pub fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/** Saludo intercambiado durante el emparejamiento (dentro del canal TLS). */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairHello {
  pub device_id: String,
  pub name: String,
  pub fingerprint: String,
  /// Puerto donde este dispositivo escucha sincronización normal.
  pub sync_port: u16,
  pub protocol_version: u32,
  /// Token de un solo uso incluido en el QR. Si coincide, el lado que muestra
  /// el QR confía automáticamente (el secreto solo pudo leerse del QR).
  #[serde(default)]
  pub pair_token: Option<String>,
}

/** Candidato pendiente de confirmación manual por el usuario. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPairing {
  pub device_id: String,
  pub name: String,
  pub fingerprint: String,
  /** Código de 6 dígitos que ambos usuarios deben comparar. */
  pub sas: String,
  /** Dirección IP:puerto de sincronización del peer. */
  pub address: String,
  /** Certificado X.509 del peer en PEM, para fijarlo al confirmar. */
  pub cert_pem: String,
  pub created_at: u64,
  pub expires_at: u64,
  /// El peer demostró conocer el token del QR de este dispositivo.
  #[serde(default)]
  pub verified: bool,
}

/** Contenido del QR de emparejamiento. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairQrPayload {
  pub v: u32,
  pub app: String,
  /// Dirección IP:puerto del servidor de emparejamiento.
  pub addr: String,
  /// Huella SHA-256 del certificado del dispositivo que muestra el QR.
  pub fp: String,
  pub id: String,
  pub name: String,
  /// Secreto de un solo uso; expira junto con la ventana de emparejamiento.
  pub token: String,
}

const QR_PREFIX: &str = "inventario-tienda://pair?d=";

impl PairQrPayload {
  pub fn encode(&self) -> Result<String, String> {
    let json = serde_json::to_vec(self).map_err(|e| format!("QR inválido: {e}"))?;
    Ok(format!("{QR_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
  }

  /** Acepta el formato con prefijo o el JSON crudo (por si se pegó a mano). */
  pub fn decode(input: &str) -> Result<Self, String> {
    let text = input.trim();
    if text.is_empty() {
      return Err("El QR está vacío.".into());
    }
    let json = if let Some(encoded) = text.strip_prefix(QR_PREFIX) {
      URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "El QR de emparejamiento está dañado.".to_string())?
    } else {
      text.as_bytes().to_vec()
    };
    let payload: PairQrPayload =
      serde_json::from_slice(&json).map_err(|_| "El código QR no es de Inventario Tienda.".to_string())?;
    if payload.app != "inventario-tienda" || payload.v != 1 {
      return Err("El QR pertenece a una versión incompatible de la app.".into());
    }
    if payload.id.trim().is_empty()
      || payload.fp.trim().is_empty()
      || payload.token.trim().len() < 16
    {
      return Err("El QR de emparejamiento está incompleto o es inválido.".into());
    }
    validate_peer_addr(&payload.addr, PAIRING_PORT)?;
    Ok(payload)
  }
}

#[derive(Default)]
pub struct PairingRegistry {
  pending: BTreeMap<String, PendingPairing>,
}

impl PairingRegistry {
  pub fn new() -> Self {
    Self::default()
  }

  pub fn add(&mut self, item: PendingPairing) {
    self.pending.insert(item.device_id.clone(), item);
  }

  pub fn get(&self, device_id: &str) -> Option<&PendingPairing> {
    self.pending.get(device_id)
  }

  pub fn remove(&mut self, device_id: &str) -> Option<PendingPairing> {
    self.pending.remove(device_id)
  }

  pub fn clear(&mut self) {
    self.pending.clear();
  }

  pub fn list(&self) -> Vec<PendingPairing> {
    self.pending.values().cloned().collect()
  }

  pub fn prune(&mut self) {
    let now = now_ms();
    self.pending.retain(|_, p| p.expires_at > now);
  }

  pub fn first(&self) -> Option<PendingPairing> {
    self.pending.values().next().cloned()
  }
}

fn our_hello(identity: &Identity, sync_port: u16, pair_token: Option<&str>) -> PairHello {
  PairHello {
    device_id: identity.device_id.clone(),
    name: identity.name.clone(),
    fingerprint: identity.fingerprint(),
    sync_port,
    protocol_version: 1,
    pair_token: pair_token.map(str::to_string),
  }
}

fn validate_hello(hello: &PairHello, peer_der: &[u8]) -> Result<(), String> {
  let expected_id = device_id_from_cert(peer_der);
  let expected_fp = fingerprint_from_der(peer_der);
  if hello.device_id != expected_id {
    return Err("El device id del saludo no coincide con su certificado.".into());
  }
  if hello.fingerprint != expected_fp {
    return Err("La huella del saludo no coincide con su certificado.".into());
  }
  if hello.sync_port == 0 {
    return Err("El peer informó un puerto de sincronización inválido.".into());
  }
  Ok(())
}

/** Lado que espera: acepta TLS, lee el saludo y devuelve el candidato con SAS. */
pub async fn accept_pairing(
  identity: &Identity,
  tcp: TcpStream,
  sync_port: u16,
  config: Arc<rustls::ServerConfig>,
  expected_token: Option<&str>,
) -> Result<PendingPairing, String> {
  let remote_ip = tcp
    .peer_addr()
    .map_err(|e| format!("No se pudo obtener la IP del peer: {e}"))?
    .ip();
  let acceptor = TlsAcceptor::from(config);
  let mut stream = acceptor
    .accept(tcp)
    .await
    .map_err(|e| format!("Fallo el handshake TLS de emparejamiento: {e}"))?;

  let peer_der = stream
    .get_ref()
    .1
    .peer_certificates()
    .and_then(|certs| certs.first())
    .map(|c| c.as_ref().to_vec())
    .ok_or_else(|| "El peer no presentó certificado.".to_string())?;

  let (kind, hello): (FrameType, PairHello) = read_json(&mut stream).await?;
  if kind != FrameType::Handshake {
    return Err("Se esperaba un saludo de emparejamiento.".into());
  }
  validate_hello(&hello, &peer_der)?;

  let verified = match (expected_token, hello.pair_token.as_deref()) {
    (Some(expected), Some(received)) if !expected.is_empty() => {
      // Comparación en tiempo constante para no filtrar el token por timing.
      let a = expected.as_bytes();
      let b = received.as_bytes();
      a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
    }
    _ => false,
  };

  write_json(
    &mut stream,
    FrameType::Handshake,
    &our_hello(identity, sync_port, None),
  )
  .await?;

  let sas = sas_code_canonical(
    &identity.cert_der,
    &peer_der,
    b"inventario-tienda/pairing/v1",
  );
  let address = SocketAddr::new(remote_ip, hello.sync_port).to_string();
  let now = now_ms();
  Ok(PendingPairing {
    device_id: hello.device_id,
    name: hello.name,
    fingerprint: hello.fingerprint,
    sas,
    address,
    cert_pem: cert_der_to_pem(&peer_der),
    created_at: now,
    expires_at: now + PAIRING_TTL_MS,
    verified,
  })
}

/** Lado que inicia: conecta a la IP del otro dispositivo y devuelve su candidato. */
pub async fn connect_pairing(
  identity: &Identity,
  addr: SocketAddr,
  sync_port: u16,
  pair_token: Option<&str>,
) -> Result<PendingPairing, String> {
  let tcp = TcpStream::connect(addr)
    .await
    .map_err(|e| format!("No se pudo conectar a {addr}: {e}"))?;
  let config = tls::pairing_client_config(identity)?;
  let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
  let server_name = rustls::pki_types::ServerName::try_from("inventario-tienda.local")
    .map_err(|e| format!("Nombre TLS inválido: {e}"))?;
  let mut stream = connector
    .connect(server_name, tcp)
    .await
    .map_err(|e| format!("Fallo el handshake TLS de emparejamiento: {e}"))?;

  let peer_der = stream
    .get_ref()
    .1
    .peer_certificates()
    .and_then(|certs| certs.first())
    .map(|c| c.as_ref().to_vec())
    .ok_or_else(|| "El peer no presentó certificado.".to_string())?;

  write_json(
    &mut stream,
    FrameType::Handshake,
    &our_hello(identity, sync_port, pair_token),
  )
  .await?;
  let (kind, hello): (FrameType, PairHello) = read_json(&mut stream).await?;
  if kind != FrameType::Handshake {
    return Err("Se esperaba un saludo de emparejamiento.".into());
  }
  validate_hello(&hello, &peer_der)?;

  let sas = sas_code_canonical(
    &identity.cert_der,
    &peer_der,
    b"inventario-tienda/pairing/v1",
  );
  let address = SocketAddr::new(addr.ip(), hello.sync_port).to_string();
  let now = now_ms();
  Ok(PendingPairing {
    device_id: hello.device_id,
    name: hello.name,
    fingerprint: hello.fingerprint,
    sas,
    address,
    cert_pem: cert_der_to_pem(&peer_der),
    created_at: now,
    expires_at: now + PAIRING_TTL_MS,
    // El iniciador ya conoce el token; la verificación real la hace el lado
    // que muestra el QR. Para el iniciador el QR es la confirmación.
    verified: pair_token.is_some(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn sample(id: &str, expires_at: u64) -> PendingPairing {
    PendingPairing {
      device_id: id.into(),
      name: "Peer".into(),
      fingerprint: "aa".into(),
      sas: "123456".into(),
      address: "192.168.0.2:14242".into(),
      cert_pem: "-----BEGIN CERTIFICATE-----".into(),
      created_at: now_ms(),
      expires_at,
      verified: false,
    }
  }

  #[test]
  fn registry_prunes_expired() {
    let mut reg = PairingRegistry::new();
    reg.add(sample("old", now_ms() - 1));
    reg.add(sample("new", now_ms() + 60_000));
    reg.prune();
    assert!(reg.get("old").is_none());
    assert!(reg.get("new").is_some());
  }
}

#[cfg(test)]
mod handshake_tests {
  use super::*;
  use crate::sync::ports::DEFAULT_SYNC_PORT as SYNC_PORT;
  use crate::sync::tls;

  #[tokio::test]
  async fn both_sides_compute_the_same_sas() {
    let server_identity = Identity::generate("Servidor").unwrap();
    let client_identity = Identity::generate("Cliente").unwrap();
    let config = Arc::new(tls::pairing_server_config(&server_identity).unwrap());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
      .await
      .unwrap();
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn({
      let identity = server_identity.clone();
      async move {
        let (tcp, _) = listener.accept().await.unwrap();
        accept_pairing(&identity, tcp, SYNC_PORT, config, None)
          .await
          .unwrap()
      }
    });

    let client = connect_pairing(&client_identity, addr, SYNC_PORT, None)
      .await
      .unwrap();
    let server = server.await.unwrap();

    assert_eq!(client.sas, server.sas);
    assert_eq!(client.device_id, server_identity.device_id);
    assert_eq!(server.device_id, client_identity.device_id);
    assert_eq!(client.address, format!("127.0.0.1:{SYNC_PORT}"));
    assert_eq!(server.address, format!("127.0.0.1:{SYNC_PORT}"));
    assert_eq!(client.fingerprint, server_identity.fingerprint());
    assert_eq!(server.fingerprint, client_identity.fingerprint());
  }
}
