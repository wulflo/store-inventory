# Guía replicable: P2P LAN cifrado con mTLS + pinning

## Requisitos
- Rust + Tokio
- rustls 0.23, tokio-rustls, rustls-pki-types
- sha2, rcgen
- serde/serde_json

## Arquitectura
1. Generar identidad Ed25519 + cert autofirmado por dispositivo
2. Descubrir solo por multicast LAN (validado)
3. Conectar por TCP solo a IPs RFC1918/link-local/loopback
4. TLS 1.3 mutuo
5. Emparejar con intercambio de certificados + código SAS
6. Guardar peer con fingerprint en almacén local
7. A partir de ahí solo aceptar peers confiables con pinning

## Código clave

### net.rs (validación LAN)
```rust
pub fn is_lan_ip(ip: &IpAddr) -> bool { /* RFC1918, link-local, ULA, loopback */ }
pub fn validate_peer_addr(addr: &SocketAddr) -> Result<(), String> { if !is_lan_ip(&addr.ip()){ Err(...)} else {Ok(())}}
pub fn is_lan_multicast(ip: &IpAddr) -> bool { /* solo LAN scopes */ }
```

### tls.rs (mTLS)
```rust
// Servidor: with_client_cert_verifier + allow_unauthenticated pero validar por app
// Cliente: with_custom_certificate_verifier para pinning
```

### pairing.rs (SAS)
```rust
// sas = u32_from_be(sha256(local_fp || remote_fp || transcript))[0..4] % 1_000_000
// Confirmar solo tras verificación manual
```

### server.rs
```rust
// bind 0.0.0.0 pero validate_peer_addr en accept()
// tras TLS, verificar fingerprint contra peers.json trusted
```

### client.rs
```rust
// validate_peer_addr antes de connect
// mTLS + pinning
```

## Reglas obligatorias
- NUNCA conectar a IPs públicas
- NUNCA usar multicast global
- SIEMPRE mTLS
- SIEMPRE pinning por fingerprint
- SIEMPRE SAS en primer emparejamiento
- NUNCA confiar en certificados sin pin
- Revocar on mismatch
- Almacenar claves en directorio privado

## Testing
- Rechazo IP pública ✓
- Rechazo multicast WAN ✓
- MITM con cert distinto rechazado ✓
- Solo peers confiables ✓
- SAS determinista ✓
