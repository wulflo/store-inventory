use rustls_pki_types::{pem::PemObject, CertificateDer};
use sha2::{Digest, Sha256};
use crate::sync::identity::{fingerprint_from_der, sas_code, Identity};
use crate::sync::peer::{Peer, PeersStore};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingRequest {
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    pub cert_pem: String,
    pub sas_local: u32,
    pub transcript_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairingResponse {
    pub accepted: bool,
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    pub cert_pem: String,
    pub sas_local: u32,
    pub transcript_hash: String,
}

pub struct PairingSession {
    identity: Arc<Identity>,
    peers: Arc<Mutex<PeersStore>>,
    pending: Arc<Mutex<Option<PairingRequest>>>,
}

impl PairingSession {
    pub fn new(identity: Arc<Identity>, peers: Arc<Mutex<PeersStore>>) -> Self {
        Self {
            identity,
            peers,
            pending: Arc::new(Mutex::new(None)),
        }
    }

    /// Genera una solicitud de emparejamiento con código SAS para verificación manual
    pub fn create_request(&self, remote_fp_hint: &[u8]) -> PairingRequest {
        let local_fp = self.identity.cert_der.as_slice();
        let transcript = format!("{}|{}", self.identity.device_id, self.identity.fingerprint()).into_bytes();
        let sas = sas_code(local_fp, remote_fp_hint, &transcript);
        PairingRequest {
            device_id: self.identity.device_id.clone(),
            name: self.identity.name.clone(),
            fingerprint: self.identity.fingerprint(),
            cert_pem: self.identity.cert_pem(),
            sas_local: sas,
            transcript_hash: hex_encode(&Sha256::digest(&transcript)),
        }
    }

    /// Verifica y acepta un emparejamiento solo tras confirmación manual del SAS
    pub fn accept(&self, req: PairingRequest) -> Result<PairingResponse, String> {
        // Validar que el certificado sea parseable
        let _cert = rustls_pki_types::CertificateDer::from_pem_slice(req.cert_pem.as_bytes())
            .map_err(|e| format!("Certificado remoto inválido: {e}"))?;

        // Verificar fingerprint coincide con lo anunciado
        let fp = fingerprint_from_der(_cert.as_ref());
        if fp != req.fingerprint {
            return Err("Fingerprint no coincide con el certificado".to_string());
        }

        // Añadir como peer confiable tras verificación SAS (se espera confirmación externa)
        let mut peers = self.peers.lock().unwrap();
        let peer = Peer {
            device_id: req.device_id.clone(),
            name: req.name.clone(),
            fingerprint: req.fingerprint.clone(),
            trusted: true,
            paired_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            last_seen: None,
            address: None,
        };
        peers.add_or_update(peer);

        let local_fp = self.identity.cert_der.as_slice();
        let remote_fp = _cert.as_ref();
        let transcript = format!("{}|{}", self.identity.device_id, self.identity.fingerprint()).into_bytes();
        let sas = sas_code(local_fp, remote_fp, &transcript);

        Ok(PairingResponse {
            accepted: true,
            device_id: self.identity.device_id.clone(),
            name: self.identity.name.clone(),
            fingerprint: self.identity.fingerprint(),
            cert_pem: self.identity.cert_pem(),
            sas_local: sas,
            transcript_hash: hex_encode(&Sha256::digest(&transcript)),
        })
    }

    /// Verifica que un certificado remoto coincida con un peer confiable
    pub fn verify_peer(&self, device_id: &str, cert_der: &[u8]) -> Result<(), String> {
        let peers = self.peers.lock().unwrap();
        let peer = peers.get(device_id).ok_or("Dispositivo no emparejado")?;
        if !peer.trusted {
            return Err("Dispositivo revocado o no confiable".to_string());
        }
        let fp = fingerprint_from_der(cert_der);
        if fp != peer.fingerprint {
            return Err("Fingerprint no coincide con el peer confiable (posible ataque MITM)".to_string());
        }
        Ok(())
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
