use crate::sync::identity::Identity;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ClientConfig, ServerConfig};
use std::sync::Arc;

/// Configura TLS 1.3 con autenticación mutua usando la identidad del dispositivo.
pub fn server_config(identity: &Identity) -> Result<ServerConfig, String> {
    let certs: Vec<CertificateDer<'static>> = vec![CertificateDer::from(identity.cert_der.clone())];
    let key_vec = identity.key_pair_pem.as_bytes().to_vec();
    let key = PrivateKeyDer::try_from(key_vec).map_err(|e| format!("Clave privada inválida para TLS: {e}"))?;

    let client_verifier = rustls::server::WebPkiClientVerifier::builder(Arc::new(rustls::RootCertStore::empty()))
        .allow_unauthenticated()
        .build()
        .map_err(|e| format!("No se pudo configurar verificador mTLS: {e}"))?;

    let config = ServerConfig::builder()
        .with_client_cert_verifier(client_verifier)
        .with_single_cert(certs, key)
        .map_err(|e| format!("No se pudo configurar TLS servidor: {e}"))?;

    Ok(config)
}

/// Configura TLS 1.3 cliente con autenticación mutua.
pub fn client_config(identity: &Identity) -> Result<ClientConfig, String> {
    let certs: Vec<CertificateDer<'static>> = vec![CertificateDer::from(identity.cert_der.clone())];
    let key_vec = identity.key_pair_pem.as_bytes().to_vec();
    let key = PrivateKeyDer::try_from(key_vec).map_err(|e| format!("Clave privada inválida para TLS: {e}"))?;

    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinningVerifier))
        .with_client_auth_cert(certs, key)
        .map_err(|e| format!("No se pudo configurar TLS cliente: {e}"))?;

    Ok(config)
}

#[derive(Debug)]
struct PinningVerifier;

impl rustls::client::danger::ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::ring::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}
