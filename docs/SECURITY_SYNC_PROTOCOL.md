# Auditoría de seguridad del protocolo P2P (LAN-only, mTLS, pinning)

Fecha: 2026-10-27
Estado: Implementado con restricciones estrictas

## Objetivos
- Comunicación **únicamente** entre dispositivos en red local (LAN)
- Emparejamiento cifrado con verificación manual (SAS)
- Autenticación mutua TLS 1.3
- Pinning por huella SHA-256 del certificado
- Sin exposición a Internet
- Resiliente ante intentos de MITM, spoofing, replay

## Superficie atacable analizada
| Vector | Estado | Mitigación |
|---|---|---|
| Conexión desde IP pública | BLOQUEADO | `sync/net.rs::validate_peer_addr` rechaza cualquier IP no RFC1918/link-local/ULA/loopback |
| Conexión 0.0.0.0/:: remota | BLOQUEADO | Validación estricta por IP |
| Descubrimiento multicast fuera de LAN | BLOQUEADO | `is_lan_multicast` solo permite 224.0.0.0/24 o ff02::/16 |
| MITM sin certificado conocido | BLOQUEADO | mTLS + verificación por fingerprint contra `peers.json` |
| Emparejamiento con dispositivo incorrecto | MITIGADO | Código SAS derivado de fingerprints + transcript (verificación manual) |
| Replay de eventos | MITIGADO | HLC + IDs únicos + deduplicación |
| Eventos fuera de rango temporal | MITIGADO | Validación HLC con tolerancia |
| Tamaño excesivo de frames/batches | MITIGADO | Límites en framing/protocol |
| Clave privada expuesta | MITIGADO | Almacenada solo en directorio privado de app |
| Conexiones no emparejadas | BLOQUEADO | Solo peers con `trusted=true` aceptados tras pinning |
| DNS rebinding / nombres externos | BLOQUEADO | No se usa DNS, solo IPs directas + validación LAN |

## Implementación por componente

### 1) Identidad
- **Archivo**: `src-tauri/src/sync/identity.rs`
- Ed25519, certificado autofirmado (rcgen)
- Device ID estable derivado de SHA-256 del DER
- Fingerprint legible SHA-256
- Persistencia en `identity/identity.pem` + `identity/certificate.pem`
- Clave privada nunca exportada fuera del dispositivo

### 2) Red / Restricciones LAN
- **Archivo**: `src-tauri/src/sync/net.rs`
- `is_lan_ip()`: permite loopback, link-local, RFC1918 (10/8, 172.16/12, 192.168/16), ULA IPv6
- `validate_peer_addr()`: rechaza cualquier otra IP con error
- `validate_discovery_source()`: valida origen de anuncios
- `is_lan_multicast()`: solo 224.0.0.0/24 (IPv4) o ff02::/16 (IPv6)

### 3) TLS 1.3 mutuo
- **Archivo**: `src-tauri/src/sync/tls.rs`
- `server_config()`: mTLS con cliente opcionalmente aceptado pero validado por app
- `client_config()`: mTLS con verificador personalizado para pinning
- Rustls con ring provider
- Certificados cargados desde identidad propia

### 4) Emparejamiento (Pairing)
- **Archivos**: `src-tauri/src/sync/pairing.rs` (no existe `pair.rs`)
- Intercambio de certificados + Device ID + fingerprint
- SAS code = f(local_fp, remote_fp, transcript) % 10^6
- Solo se añade a `peers.json` tras confirmación manual del SAS
- Verificación de fingerprint contra certificado recibido
- Peer marcado `trusted=true` únicamente tras confirmación

### 5) Servidor
- **Archivo**: `src-tauri/src/sync/server.rs`
- `SyncServerReal`: bind a `0.0.0.0:PORT` pero **filtra** cada conexión por `validate_peer_addr`
- TLS acceptor con mTLS
- Tras handshake TLS, se realiza **pinning** contra `PeersStore`
- Solo peers confiables aceptados
- Conexiones desde IP no LAN rechazadas inmediatamente

### 6) Cliente
- **Archivo**: `src-tauri/src/sync/client.rs`
- `connect_lan()`: valida IP destino antes de conectar
- TLS mutuo
- Pinning por fingerprint obligatorio tras conexión

### 7) Descubrimiento
- **Archivo**: `src-tauri/src/sync/discovery.rs`
- Solo multicast LAN
- Valida origen de cada anuncio
- Nunca descubre por DNS/internet

### 8) Almacenamiento de confianza
- **Archivo**: `src-tauri/src/sync/peer.rs`
- `peers.json` con lista de peers
- Campos: device_id, name, fingerprint, trusted, paired_at, last_seen, address
- `revoke()` permite invalidar peer
- Solo `trusted=true` permitidos

## Checklist de seguridad
- [x] Sin tráfico a Internet (solo LAN validado)
- [x] mTLS obligatorio
- [x] Pinning por huella
- [x] SAS para pairing
- [x] Validación de IP estricta
- [x] Multicast restringido
- [x] Revocación de peers
- [x] Claves privadas en storage privado
- [x] Sin DNS externo
- [x] Límites en protocolo/framing
- [x] HLC + deduplicación

## Recomendaciones operativas
1. Verificar SAS siempre manualmente
2. Revocar peers perdidos
3. Usar solo WiFi confiable (no hotspots públicos)
4. Mantener app actualizada
5. No compartir `identity.pem`

## Cómo replicar en otro proyecto
Ver `docs/security/SYNC_PROTOCOL_REPLICABLE.md`


## Actualización: Revisión de seguridad real (2026-10-27)

Ver [SECURITY_REVIEW_2026-10-27.md](./SECURITY_REVIEW_2026-10-27.md) para auditoría completa con hallazgos, correcciones aplicadas y recomendaciones.

**Correcciones aplicadas:**
- Eliminado fallback UDP a 8.8.8.8 en `local_lan_addresses()` (sin tráfico a Internet)
- Añadida revisión exhaustiva documentada
