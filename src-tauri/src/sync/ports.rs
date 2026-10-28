use serde::{Deserialize, Serialize};
use std::path::Path;

/* ------------------------------------------------------------------ */
/* Puertos de sincronización configurables                            */
/* ------------------------------------------------------------------ */

pub const DEFAULT_SYNC_PORT: u16 = 14242;
pub const DEFAULT_PAIRING_PORT: u16 = 14243;
pub const MIN_SYNC_PORT: u16 = 1024;
/// El emparejamiento usa el puerto siguiente, así que el máximo es uno menos.
pub const MAX_SYNC_PORT: u16 = 65534;

/// Puertos TCP que usa este dispositivo.
///
/// El descubrimiento UDP queda fijo en `14244` para que dos instalaciones se
/// encuentren aunque una haya cambiado sus puertos TCP. Los anuncios incluyen
/// los puertos configurados, así que el otro lado no necesita adivinarlos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncPorts {
  pub sync: u16,
  pub pairing: u16,
}

impl Default for SyncPorts {
  fn default() -> Self {
    Self {
      sync: DEFAULT_SYNC_PORT,
      pairing: DEFAULT_PAIRING_PORT,
    }
  }
}

impl SyncPorts {
  /// Deriva el puerto de emparejamiento a partir del puerto de sincronización.
  pub fn from_base(base: u16) -> Result<Self, String> {
    if !(MIN_SYNC_PORT..=MAX_SYNC_PORT).contains(&base) {
      return Err(format!(
        "El puerto debe estar entre {MIN_SYNC_PORT} y {MAX_SYNC_PORT}."
      ));
    }
    Ok(Self {
      sync: base,
      pairing: base + 1,
    })
  }

  pub fn base(&self) -> u16 {
    self.sync
  }

  fn is_valid(self) -> bool {
    self.sync >= MIN_SYNC_PORT
      && self.sync <= MAX_SYNC_PORT
      && self.pairing == self.sync + 1
  }

  /// Carga la configuración persistida; si no existe o es inválida, usa los
  /// puertos históricos para no romper instalaciones anteriores.
  pub fn load(path: &Path) -> Self {
    let Ok(bytes) = std::fs::read(path) else {
      return Self::default();
    };
    let Ok(file) = serde_json::from_slice::<PortsFile>(&bytes) else {
      return Self::default();
    };
    Self::from_base(file.base_port).unwrap_or_default()
  }

  pub fn save(self, path: &Path) -> Result<(), String> {
    if !self.is_valid() {
      return Err("La configuración de puertos no es válida.".into());
    }
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent)
        .map_err(|e| format!("No se pudo crear la carpeta de configuración: {e}"))?;
    }
    let json = serde_json::to_vec_pretty(&PortsFile {
      base_port: self.base(),
    })
    .map_err(|e| format!("No se pudo serializar la configuración de puertos: {e}"))?;
    std::fs::write(path, json)
      .map_err(|e| format!("No se pudo guardar la configuración de puertos: {e}"))
  }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct PortsFile {
  base_port: u16,
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn derives_pairing_port() {
    let ports = SyncPorts::from_base(15000).unwrap();
    assert_eq!(ports.sync, 15000);
    assert_eq!(ports.pairing, 15001);
  }

  #[test]
  fn rejects_privileged_and_out_of_range_ports() {
    assert!(SyncPorts::from_base(80).is_err());
    assert!(SyncPorts::from_base(0).is_err());
    assert!(SyncPorts::from_base(MAX_SYNC_PORT + 1).is_err());
    assert!(SyncPorts::from_base(MAX_SYNC_PORT).is_ok());
  }

  #[test]
  fn default_matches_historical_ports() {
    let ports = SyncPorts::default();
    assert_eq!(ports.sync, 14242);
    assert_eq!(ports.pairing, 14243);
  }

  #[test]
  fn saves_and_loads_configuration() {
    let stamp = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let dir = std::env::temp_dir().join(format!("inventario-ports-{stamp}"));
    let path = dir.join("ports.json");

    let ports = SyncPorts::from_base(15100).unwrap();
    ports.save(&path).unwrap();
    assert_eq!(SyncPorts::load(&path), ports);

    std::fs::remove_dir_all(dir).unwrap();
  }
}
