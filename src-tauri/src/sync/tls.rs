use crate::sync::identity::fingerprint_from_der;
use crate::sync::identity::Identity;
use crate::sync::peer::PeersStore;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{DigitallySignedStruct, DistinguishedName, SignatureScheme};
use std::sync::{Arc, Mutex};

/* ------------------------------------------------------------------ */
/* TLS mutuo con certificados autofirmados y pinning                  */
/* ------------------------------------------------------------------ */

/**
 * Proveedor criptográfico explícito (*ring*).
 *
 * No usamos `CryptoProvider::get_default()` porque el actualizador (reqwest)
 * puede habilitar aws-lc-rs por su cuenta. Elegir el proveedor explícitamente
 * evita el error de "múltiples proveedores" y hace reproducible la validación
 * de firmas del handshake.
 */
fn provider() -> Arc<CryptoProvider> {
  Arc::new(rustls::crypto::ring::default_provider())
}

fn certs(identity: &Identity) -> Vec<CertificateDer<'static>> {
  vec![CertificateDer::from(identity.cert_der.clone())]
}

fn private_key(identity: &Identity) -> Result<PrivateKeyDer<'static>, String> {
  PrivateKeyDer::from_pem_slice(identity.key_pair_pem.as_bytes())
    .map_err(|e| format!("No se pudo leer la clave privada del dispositivo: {e}"))
}


/* ------------------------- Servidor estricto ---------------------- */

/** Acepta únicamente certificados de peers ya emparejados (mTLS + pinning). */
#[derive(Debug)]
pub struct TrustedClientsVerifier {
  provider: Arc<CryptoProvider>,
  peers: Arc<Mutex<PeersStore>>,
}

impl TrustedClientsVerifier {
  pub fn new(provider: Arc<CryptoProvider>, peers: Arc<Mutex<PeersStore>>) -> Self {
    Self { provider, peers }
  }
}

impl ClientCertVerifier for TrustedClientsVerifier {
  fn root_hint_subjects(&self) -> &[DistinguishedName] {
    &[]
  }

  fn verify_client_cert(
    &self,
    end_entity: &CertificateDer<'_>,
    _intermediates: &[CertificateDer<'_>],
    _now: UnixTime,
  ) -> Result<ClientCertVerified, rustls::Error> {
    let fingerprint = fingerprint_from_der(end_entity.as_ref());
    let peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
    if peers.trusted_by_fingerprint(&fingerprint).is_some() {
      Ok(ClientCertVerified::assertion())
    } else {
      Err(rustls::Error::General(format!(
        "Certificado de dispositivo no emparejado ({fingerprint})"
      )))
    }
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    self
      .provider
      .signature_verification_algorithms
      .supported_schemes()
  }
}

/* -------------------------- Cliente estricto ---------------------- */

/** Acepta únicamente el certificado exacto del peer (pin). */
#[derive(Debug)]
pub struct PinnedServerVerifier {
  provider: Arc<CryptoProvider>,
  expected_der: Vec<u8>,
}

impl PinnedServerVerifier {
  pub fn new(provider: Arc<CryptoProvider>, expected_der: Vec<u8>) -> Self {
    Self {
      provider,
      expected_der,
    }
  }
}

impl ServerCertVerifier for PinnedServerVerifier {
  fn verify_server_cert(
    &self,
    end_entity: &CertificateDer<'_>,
    _intermediates: &[CertificateDer<'_>],
    _server_name: &ServerName<'_>,
    _ocsp_response: &[u8],
    _now: UnixTime,
  ) -> Result<ServerCertVerified, rustls::Error> {
    if end_entity.as_ref() == self.expected_der.as_slice() {
      Ok(ServerCertVerified::assertion())
    } else {
      Err(rustls::Error::General(format!(
        "El certificado del servidor no coincide con el peer emparejado ({})",
        fingerprint_from_der(end_entity.as_ref())
      )))
    }
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    self
      .provider
      .signature_verification_algorithms
      .supported_schemes()
  }
}

/* ------------------- Verificadores de emparejamiento -------------- */

/**
 * Durante el emparejamiento todavía no conocemos el certificado del otro lado.
 * Aceptamos cualquier certificado autofirmado, pero exigimos que la firma del
 * handshake sea válida. La confianza real se establece después, cuando ambos
 * usuarios comparan el SAS y confirman.
 */
#[derive(Debug)]
pub struct PairingClientVerifier {
  provider: Arc<CryptoProvider>,
}

impl PairingClientVerifier {
  pub fn new(provider: Arc<CryptoProvider>) -> Self {
    Self { provider }
  }
}

impl ClientCertVerifier for PairingClientVerifier {
  fn root_hint_subjects(&self) -> &[DistinguishedName] {
    &[]
  }

  fn verify_client_cert(
    &self,
    end_entity: &CertificateDer<'_>,
    _intermediates: &[CertificateDer<'_>],
    _now: UnixTime,
  ) -> Result<ClientCertVerified, rustls::Error> {
    if end_entity.as_ref().is_empty() {
      Err(rustls::Error::General("Certificado vacío".into()))
    } else {
      Ok(ClientCertVerified::assertion())
    }
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    self
      .provider
      .signature_verification_algorithms
      .supported_schemes()
  }
}

#[derive(Debug)]
pub struct PairingServerVerifier {
  provider: Arc<CryptoProvider>,
}

impl PairingServerVerifier {
  pub fn new(provider: Arc<CryptoProvider>) -> Self {
    Self { provider }
  }
}

impl ServerCertVerifier for PairingServerVerifier {
  fn verify_server_cert(
    &self,
    end_entity: &CertificateDer<'_>,
    _intermediates: &[CertificateDer<'_>],
    _server_name: &ServerName<'_>,
    _ocsp_response: &[u8],
    _now: UnixTime,
  ) -> Result<ServerCertVerified, rustls::Error> {
    if end_entity.as_ref().is_empty() {
      Err(rustls::Error::General("Certificado vacío".into()))
    } else {
      Ok(ServerCertVerified::assertion())
    }
  }

  fn verify_tls12_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn verify_tls13_signature(
    &self,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    self
      .provider
      .signature_verification_algorithms
      .supported_schemes()
  }
}

/* --------------------------- Configs ------------------------------ */

pub fn server_config(
  identity: &Identity,
  peers: Arc<Mutex<PeersStore>>,
) -> Result<rustls::ServerConfig, String> {
  let provider = provider();
  let verifier = Arc::new(TrustedClientsVerifier::new(provider.clone(), peers));
  let mut config = rustls::ServerConfig::builder_with_provider(provider)
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| format!("No se pudo configurar TLS: {e}"))?
    .with_client_cert_verifier(verifier)
    .with_single_cert(certs(identity), private_key(identity)?)
    .map_err(|e| format!("No se pudo cargar el certificado del dispositivo: {e}"))?;
  config.alpn_protocols = vec![b"inventario-sync/1".to_vec()];
  Ok(config)
}

pub fn client_config(
  identity: &Identity,
  expected_cert_der: &[u8],
) -> Result<rustls::ClientConfig, String> {
  let provider = provider();
  let verifier = Arc::new(PinnedServerVerifier::new(
    provider.clone(),
    expected_cert_der.to_vec(),
  ));
  let mut config = rustls::ClientConfig::builder_with_provider(provider)
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| format!("No se pudo configurar TLS: {e}"))?
    .dangerous()
    .with_custom_certificate_verifier(verifier)
    .with_client_auth_cert(certs(identity), private_key(identity)?)
    .map_err(|e| format!("No se pudo cargar el certificado del dispositivo: {e}"))?;
  config.alpn_protocols = vec![b"inventario-sync/1".to_vec()];
  Ok(config)
}

pub fn pairing_server_config(identity: &Identity) -> Result<rustls::ServerConfig, String> {
  let provider = provider();
  let verifier = Arc::new(PairingClientVerifier::new(provider.clone()));
  let mut config = rustls::ServerConfig::builder_with_provider(provider)
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| format!("No se pudo configurar TLS de emparejamiento: {e}"))?
    .with_client_cert_verifier(verifier)
    .with_single_cert(certs(identity), private_key(identity)?)
    .map_err(|e| format!("No se pudo cargar el certificado del dispositivo: {e}"))?;
  config.alpn_protocols = vec![b"inventario-pairing/1".to_vec()];
  Ok(config)
}

pub fn pairing_client_config(identity: &Identity) -> Result<rustls::ClientConfig, String> {
  let provider = provider();
  let verifier = Arc::new(PairingServerVerifier::new(provider.clone()));
  let mut config = rustls::ClientConfig::builder_with_provider(provider)
    .with_protocol_versions(&[&rustls::version::TLS13])
    .map_err(|e| format!("No se pudo configurar TLS de emparejamiento: {e}"))?
    .dangerous()
    .with_custom_certificate_verifier(verifier)
    .with_client_auth_cert(certs(identity), private_key(identity)?)
    .map_err(|e| format!("No se pudo cargar el certificado del dispositivo: {e}"))?;
  config.alpn_protocols = vec![b"inventario-pairing/1".to_vec()];
  Ok(config)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn configs_build_with_ring_provider() {
    let identity = Identity::generate("tls-test").unwrap();
    let peers = Arc::new(Mutex::new(PeersStore::new()));
    assert!(server_config(&identity, peers).is_ok());
    assert!(client_config(&identity, &identity.cert_der).is_ok());
    assert!(pairing_server_config(&identity).is_ok());
    assert!(pairing_client_config(&identity).is_ok());
  }
}

#[cfg(test)]
mod mtls_tests {
  use super::*;
  use crate::sync::identity::cert_der_to_pem;
  use crate::sync::peer::Peer;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};

  #[tokio::test]
  async fn mutual_tls_with_pinned_certificates() {
    let server_identity = Identity::generate("Servidor").unwrap();
    let client_identity = Identity::generate("Cliente").unwrap();

    let mut peers = PeersStore::new();
    peers.add_or_update(
      Peer::new(
        client_identity.device_id.clone(),
        "Cliente".into(),
        client_identity.fingerprint(),
      )
      .with_cert(cert_der_to_pem(&client_identity.cert_der)),
    );

    let server_config = server_config(&server_identity, Arc::new(Mutex::new(peers))).unwrap();
    let client_config = client_config(&client_identity, &server_identity.cert_der).unwrap();

    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
    let server = tokio::spawn(async move {
      let mut stream = acceptor.accept(server_io).await.unwrap();
      let mut buf = [0u8; 5];
      stream.read_exact(&mut buf).await.unwrap();
      assert_eq!(&buf, b"ping!");
      stream.write_all(b"pong!").await.unwrap();
      stream.flush().await.unwrap();
    });

    let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));
    let name = rustls::pki_types::ServerName::try_from("inventario-tienda.local").unwrap();
    let mut stream = connector.connect(name, client_io).await.unwrap();
    stream.write_all(b"ping!").await.unwrap();
    stream.flush().await.unwrap();
    let mut buf = [0u8; 5];
    stream.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"pong!");
    server.await.unwrap();
  }

  #[tokio::test]
  async fn rejects_unpinned_server_certificate() {
    let server_identity = Identity::generate("Servidor").unwrap();
    let client_identity = Identity::generate("Cliente").unwrap();
    let other_identity = Identity::generate("Otro").unwrap();

    let server_config = pairing_server_config(&server_identity).unwrap();
    let client_config = client_config(&client_identity, &other_identity.cert_der).unwrap();

    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(server_config));
    tokio::spawn(async move {
      let _ = acceptor.accept(server_io).await;
    });

    let connector = tokio_rustls::TlsConnector::from(Arc::new(client_config));
    let name = rustls::pki_types::ServerName::try_from("inventario-tienda.local").unwrap();
    assert!(connector.connect(name, client_io).await.is_err());
  }
}
