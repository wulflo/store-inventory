use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ */
/* Estructuras de evento (equivalentes al JSONL del frontend TS)      */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainEvent {
  pub id: String,
  #[serde(rename = "type")]
  pub type_: String,
  pub payload: serde_json::Value,
  pub metadata: EventMetadata,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventMetadata {
  pub hlc: u64,
  #[serde(rename = "deviceId")]
  pub device_id: String,
  pub timestamp: u64,
  pub version: u32,
}

impl DomainEvent {
  pub fn domain(&self) -> &str {
    self.type_.split('.').next().unwrap_or("")
  }
}
