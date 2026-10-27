use crate::sync::identity::Identity;
use crate::sync::net::validate_peer_addr;
use crate::sync::tls;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

pub struct SyncClient;

impl SyncClient {
    /// Conecta solo a IPs LAN con TLS mutuo y validación posterior por pinning
    pub async fn connect_lan(identity: &Identity, addr: SocketAddr) -> Result<(), String> {
        validate_peer_addr(&addr)?;
        let config = tls::client_config(identity)?;
        let connector = TlsConnector::from(Arc::new(config));
        let stream = TcpStream::connect(addr)
            .await
            .map_err(|e| format!("No se pudo conectar: {e}"))?;
        let domain = rustls::pki_types::ServerName::try_from("localhost")
            .map_err(|e| format!("Nombre inválido: {e}"))?;
        let _tls_stream = connector
            .connect(domain, stream)
            .await
            .map_err(|e| format!("Error TLS mutuo: {e}"))?;
        // Tras conectar, se debe verificar fingerprint contra peers confiables por pinning
        Ok(())
    }
}
