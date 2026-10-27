use crate::event_store::{domain_path, events_dir, EVENTS_WRITE_LOCK};
use crate::sync::protocol::{compute_summary, DomainSummary, SyncSummary};
use crate::sync::store_types::DomainEvent;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;

/* ------------------------------------------------------------------ */
/* Acceso a los JSONL locales para el motor de sincronización          */
/* ------------------------------------------------------------------ */

pub const DOMAINS: [&str; 14] = [
  "collections",
  "products",
  "colors",
  "variants",
  "customers",
  "orders",
  "order_lines",
  "payments",
  "production_orders",
  "production_lines",
  "stock_movements",
  "expenses",
  "settings",
  "device_info",
];

pub fn ensure_layout(root: &str) -> Result<(), String> {
  fs::create_dir_all(events_dir(root))
    .map_err(|e| format!("No se pudo crear la carpeta de eventos: {e}"))
}

pub fn load_domain(root: &str, domain: &str) -> Result<Vec<DomainEvent>, String> {
  let path = domain_path(root, domain);
  let text = match fs::read_to_string(&path) {
    Ok(text) => text,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
    Err(e) => return Err(format!("No se pudo leer {domain}.jsonl: {e}")),
  };

  let mut events = Vec::new();
  for line in text.lines() {
    let line = line.trim();
    if line.is_empty() {
      continue;
    }
    // Una línea parcial al final (proceso interrumpido) se descarta.
    if let Ok(ev) = serde_json::from_str::<DomainEvent>(line) {
      events.push(ev);
    }
  }
  events.sort_by(|a, b| {
    a.metadata
      .hlc
      .cmp(&b.metadata.hlc)
      .then_with(|| a.id.cmp(&b.id))
  });
  Ok(events)
}

pub fn load_all(root: &str) -> Result<BTreeMap<String, Vec<DomainEvent>>, String> {
  let mut out = BTreeMap::new();
  for domain in DOMAINS {
    out.insert(domain.to_string(), load_domain(root, domain)?);
  }
  Ok(out)
}

pub fn summaries_for(events: &BTreeMap<String, Vec<DomainEvent>>) -> Vec<DomainSummary> {
  DOMAINS
    .iter()
    .map(|domain| {
      let list = events.get(*domain).map(Vec::as_slice).unwrap_or(&[]);
      compute_summary(domain, list)
    })
    .collect()
}

pub fn local_summary(root: &str) -> Result<SyncSummary, String> {
  let all = load_all(root)?;
  Ok(SyncSummary::new(summaries_for(&all)))
}

/**
 * Agrega solo eventos cuyo id no exista. Devuelve cuántos se agregaron.
 *
 * El archivo es append-only: nunca se reescribe ni se borra historia. Si dos
 * dispositivos envían el mismo evento, el segundo se ignora por id.
 */
pub fn append_missing(
  root: &str,
  domain: &str,
  incoming: &[DomainEvent],
) -> Result<usize, String> {
  if !DOMAINS.contains(&domain) {
    return Err(format!("Dominio desconocido: {domain}"));
  }
  if incoming.is_empty() {
    return Ok(0);
  }

  let _guard = EVENTS_WRITE_LOCK
    .lock()
    .unwrap_or_else(|e| e.into_inner());

  let existing = load_domain(root, domain)?;
  let mut ids: BTreeSet<String> = existing.into_iter().map(|e| e.id).collect();
  let mut to_write: Vec<&DomainEvent> = Vec::new();
  for ev in incoming {
    if ev.id.is_empty() {
      continue;
    }
    if ev.domain() != domain {
      return Err(format!(
        "El evento {} pertenece al dominio {}, no a {}",
        ev.id,
        ev.domain(),
        domain
      ));
    }
    if ids.insert(ev.id.clone()) {
      to_write.push(ev);
    }
  }
  if to_write.is_empty() {
    return Ok(0);
  }

  fs::create_dir_all(events_dir(root))
    .map_err(|e| format!("No se pudo crear la carpeta de eventos: {e}"))?;
  let path = domain_path(root, domain);
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("No se pudo abrir {domain}.jsonl para escritura: {e}"))?;
  for ev in &to_write {
    let line = serde_json::to_string(ev)
      .map_err(|e| format!("No se pudo serializar el evento {}: {e}", ev.id))?;
    writeln!(file, "{line}").map_err(|e| format!("Error escribiendo eventos: {e}"))?;
  }
  file.flush().map_err(|e| format!("Error haciendo flush: {e}"))?;
  Ok(to_write.len())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::sync::store_types::EventMetadata;
  use serde_json::json;
  use std::path::PathBuf;

  fn temp_root(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "inventario-sync-store-{tag}-{}",
      std::process::id()
    ));
    let _ = fs::remove_dir_all(&dir);
    dir
  }

  fn event(id: &str, domain: &str) -> DomainEvent {
    DomainEvent {
      id: id.into(),
      type_: match domain {
        "orders" => "Order.Created".to_string(),
        "products" => "Product.Created".to_string(),
        _ => format!("{domain}.Created"),
      },
      payload: json!({ "id": id }),
      metadata: EventMetadata {
        hlc: 100,
        device_id: "dev".into(),
        timestamp: 100,
        version: 1,
      },
    }
  }

  #[test]
  fn append_is_idempotent() {
    let root = temp_root("append");
    let root_s = root.to_string_lossy().to_string();
    ensure_layout(&root_s).unwrap();
    let ev = event("ev-1", "orders");
    assert_eq!(append_missing(&root_s, "orders", std::slice::from_ref(&ev)).unwrap(), 1);
    assert_eq!(append_missing(&root_s, "orders", std::slice::from_ref(&ev)).unwrap(), 0);
    assert_eq!(load_domain(&root_s, "orders").unwrap().len(), 1);
    let _ = fs::remove_dir_all(root);
  }

  #[test]
  fn summary_detects_remote_events() {
    let root = temp_root("summary");
    let root_s = root.to_string_lossy().to_string();
    ensure_layout(&root_s).unwrap();
    append_missing(&root_s, "orders", &[event("ev-1", "orders")]).unwrap();
    let summary = local_summary(&root_s).unwrap();
    let orders = summary
      .summaries
      .iter()
      .find(|s| s.domain == "orders")
      .unwrap();
    assert_eq!(orders.event_count, 1);
    let _ = fs::remove_dir_all(root);
  }
}
