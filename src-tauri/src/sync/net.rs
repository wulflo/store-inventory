use std::net::{IpAddr, SocketAddr};

/// Valida que una dirección IP sea estrictamente LAN (RFC1918, link-local, ULA, loopback).
/// Nunca permite direcciones públicas ni 0.0.0.0/:: para conexiones remotas.
pub fn is_lan_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_link_local()
                || (o[0] == 10)
                || (o[0] == 172 && o[1] >= 16 && o[1] <= 31)
                || (o[0] == 192 && o[1] == 168)
                || v4.is_private()
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unique_local() // fc00::/7 (ULA)
                || v6.is_unicast_link_local() // fe80::/10
        }
    }
}

/// Valida que una dirección de socket sea segura para sincronización P2P (solo LAN).
pub fn validate_peer_addr(addr: &SocketAddr) -> Result<(), String> {
    if !is_lan_ip(&addr.ip()) {
        return Err(format!("Conexión rechazada: {} no es una IP de red local", addr.ip()));
    }
    Ok(())
}

/// Valida que un anuncio de descubrimiento provenga solo de LAN.
pub fn validate_discovery_source(addr: &SocketAddr) -> Result<(), String> {
    validate_peer_addr(addr)
}

/// Valida que una dirección multicast sea válida solo para LAN.
pub fn is_lan_multicast(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            // 224.0.0.0/4 multicast, forzamos solo link-local scope (224.0.0.0/24) o administrativamente local
            // Preferimos 224.0.0.0/24 (224.0.0.0-224.0.0.255) para descubrimiento seguro
            o[0] >= 224 && o[0] <= 239 && o[0] == 224 && o[1] == 0 && o[2] == 0
        }
        IpAddr::V6(v6) => {
            // ff02::/16 link-local multicast únicamente
            let seg = v6.segments();
            (seg[0] & 0xfff0) == 0xff00 && (seg[0] & 0x000f) == 0x2
        }
    }
}
