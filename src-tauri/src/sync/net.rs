use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/* ------------------------------------------------------------------ */
/* Validación de direcciones LAN                                      */
/* ------------------------------------------------------------------ */

/** true solo para direcciones que pueden existir en una LAN doméstica. */
pub fn is_lan_ip(ip: IpAddr) -> bool {
  match ip {
    IpAddr::V4(v4) => is_lan_ipv4(v4),
    IpAddr::V6(v6) => is_lan_ipv6(v6),
  }
}

fn is_lan_ipv4(ip: Ipv4Addr) -> bool {
  ip.is_loopback()
    || ip.is_private()
    || ip.is_link_local()
    // Rango de documentación/benchmark usado por algunos emuladores.
    || ip.octets()[0] == 192 && ip.octets()[1] == 0 && ip.octets()[2] == 2
}

fn is_lan_ipv6(ip: Ipv6Addr) -> bool {
  ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local()
}

/**
 * Convierte "ip", "ip:puerto" o "[ipv6]:puerto" a SocketAddr y rechaza
 * cualquier dirección que no sea LAN.
 *
 * No se aceptan nombres de host: evita que DNS resuelva a una IP pública y
 * también evita depender de la red para emparejar.
 */
pub fn validate_peer_addr(input: &str, default_port: u16) -> Result<SocketAddr, String> {
  let trimmed = input.trim();
  if trimmed.is_empty() {
    return Err("Ingresá la dirección IP del otro dispositivo.".into());
  }

  let with_port = if trimmed.starts_with('[') {
    // IPv6 con puerto: [fe80::1]:14243
    if trimmed.contains("]:") {
      trimmed.to_string()
    } else {
      format!("{trimmed}:{default_port}")
    }
  } else if trimmed.matches(':').count() > 1 {
    // IPv6 sin puerto.
    format!("[{trimmed}]:{default_port}")
  } else if trimmed.contains(':') {
    trimmed.to_string()
  } else {
    format!("{trimmed}:{default_port}")
  };

  let addr: SocketAddr = with_port
    .parse()
    .map_err(|_| format!("Dirección inválida: «{trimmed}». Usá el formato 192.168.0.10 o 192.168.0.10:14243."))?;

  if !is_lan_ip(addr.ip()) {
    return Err(format!(
      "Por seguridad, la sincronización solo se permite en la red local (LAN). {addr} no es una IP privada, link-local ni loopback."
    ));
  }
  if addr.port() == 0 {
    return Err("El puerto no puede ser 0.".into());
  }
  Ok(addr)
}

/** Direcciones IPv4/IPv6 de la LAN local, sin loopback ni interfaces virtuales. */
pub fn local_lan_addresses() -> Vec<String> {
  let mut out: Vec<String> = Vec::new();
  if let Ok(interfaces) = if_addrs::get_if_addrs() {
    for iface in interfaces {
      if iface.is_loopback() {
        continue;
      }
      let ip = iface.ip();
      if !is_lan_ip(ip) {
        continue;
      }
      // En Android suele haber varias interfaces (wlan0, rmnet, etc.).
      // Mostramos todas las que sean LAN; el usuario elige la de Wi-Fi.
      let text = ip.to_string();
      if !out.contains(&text) {
        out.push(text);
      }
    }
  }
  out
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_private_ipv4() {
    assert!(validate_peer_addr("192.168.0.10", 14243).is_ok());
    assert!(validate_peer_addr("10.0.0.5:14243", 14243).is_ok());
    assert!(validate_peer_addr("172.16.5.4", 14243).is_ok());
    assert!(validate_peer_addr("127.0.0.1:5000", 14243).is_ok());
    assert!(validate_peer_addr("10.0.2.2", 14243).is_ok());
  }

  #[test]
  fn rejects_public_ipv4() {
    assert!(validate_peer_addr("8.8.8.8", 14243).is_err());
    assert!(validate_peer_addr("example.com:14243", 14243).is_err());
    assert!(validate_peer_addr("1.1.1.1:80", 14243).is_err());
  }

  #[test]
  fn accepts_ula_and_link_local_ipv6() {
    assert!(validate_peer_addr("fd00::1", 14243).is_ok());
    assert!(validate_peer_addr("[fe80::1]:14243", 14243).is_ok());
    assert!(validate_peer_addr("::1", 14243).is_ok());
  }

  #[test]
  fn rejects_public_ipv6() {
    assert!(validate_peer_addr("2001:4860:4860::8888", 14243).is_err());
  }
}
