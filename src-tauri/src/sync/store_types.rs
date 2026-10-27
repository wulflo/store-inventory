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
  /** Dominio/archivo al que pertenece el evento, según el prefijo del tipo. */
  pub fn domain(&self) -> &'static str {
    domain_for_event_type(&self.type_)
  }
}

/** Misma tabla que `domainForEventType` del frontend. */
pub fn domain_for_event_type(event_type: &str) -> &'static str {
  match event_type.split('.').next().unwrap_or("") {
    "Collection" => "collections",
    "Product" => "products",
    "Color" => "colors",
    "Variant" => "variants",
    "Customer" => "customers",
    "Order" => "orders",
    "OrderLine" => "order_lines",
    "Payment" => "payments",
    "ProductionOrder" => "production_orders",
    "ProductionLine" => "production_lines",
    "Stock" => "stock_movements",
    "Expense" => "expenses",
    "Setting" => "settings",
    "Device" => "device_info",
    _ => "settings",
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn maps_event_type_prefixes_to_file_domains() {
    assert_eq!(domain_for_event_type("Order.Created"), "orders");
    assert_eq!(domain_for_event_type("OrderLine.Added"), "order_lines");
    assert_eq!(domain_for_event_type("ProductionOrder.Created"), "production_orders");
    assert_eq!(domain_for_event_type("Stock.Moved"), "stock_movements");
    assert_eq!(domain_for_event_type("Unknown.Thing"), "settings");
  }
}
