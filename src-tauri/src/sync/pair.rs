use rustls_pki_types::{pem::PemObject, CertificateDer};
use sha2::{Digest, Sha256};
use crate::sync::identity::{fingerprint_from_der, sas_code, Identity};
use crate::sync::peer::{Peer, PeersStore};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairRequest {
    pub device_id: String,
    pub name: String,
    pub fingerprint: String,
    pub cert_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairChallenge {
    pub sas_code: u32,
    pub transcript_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairConfirm {
    pub device_id: String,
    pub accepted: bool,
}

pub struct PairManager {
    identity: Arc<Identity>,
    peers: Arc<Mutex<PeersStore>>,
}

impl PairManager {
    pub fn new(identity: Arc<Identity>, peers: Arc<Mutex<PeersStore>>) -> Self {
        Self { identity, peers }
    }

    /// Inicia emparejamiento: genera solicitud con fingerprint
    pub fn initiate(&self, remote_hint: &[u8]) -> PairRequest {
        let local_fp = self.identity.cert_der.as_slice();
        let transcript = format!("pair:{}|{}", self.identity.device_id, self.identity.fingerprint()).into_bytes();
        let _sas = sas_code(local_fp, remote_hint, &transcript);
        PairRequest {
            device_id: self.identity.device_id.clone(),
            name: self.identity.name.clone(),
            fingerprint: self.identity.fingerprint(),
            cert_pem: self.identity.cert_pem(),
        }
    }

    /// Genera desafío SAS tras intercambiar certificados
    pub fn challenge(&self, remote_cert_der: &[u8]) -> PairChallenge {
        let local_fp = self.identity.cert_der.as_slice();
        let transcript = format!("pair:{}|{}", self.identity.device_id, self.identity.fingerprint()).into_bytes();
        let sas = sas_code(local_fp, remote_cert_der, &transcript);
        PairChallenge {
            sas_code: sas,
            transcript_hash: hex_encode(&Sha256::digest(&transcript)),
        }
    }

    /// Confirma emparejamiento solo si SAS coincide (verificación manual)
    pub fn confirm(&self, req: PairRequest, remote_cert_der: &[u8]) -> Result<Peer, String> {
        // Validar certificado
        let _cert = CertificateDer::from_pem_slice(req.cert_pem.as_bytes())
            .map_err(|e| format!("Certificado inválido: {e}"))?;
        let fp = fingerprint_from_der(remote_cert_der);
        if fp != req.fingerprint {
            return Err("Fingerprint no coincide".to_string());
        }
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
        peers.add_or_update(peer.clone());
        Ok(peer)
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
