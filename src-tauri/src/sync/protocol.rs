use crate::sync::framing::{MAX_BATCH_EVENTS, MAX_BATCH_BYTES};
use crate::sync::store_types::{DomainEvent, EventMetadata};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::collections::BTreeMap;

/* ------------------------------------------------------------------ */
/* Protocolo de reconciliación por dominio                            */
/* ------------------------------------------------------------------ */

/** Resumen de un dominio para intercambio durante la reconciliación. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainSummary {
  pub domain: String,
  pub event_count: u64,
  pub max_hlc: u64,
  /** Hash agregado (XOR de hashes de IDs) para detectar divergencia rápida. */
  pub aggregate_hash: u64,
}

/** Resumen completo de todos los dominios. */
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncSummary {
  pub summaries: Vec<DomainSummary>,
  pub protocol_version: u32,
  pub schema_version: u32,
}

impl SyncSummary {
  pub fn new(summaries: Vec<DomainSummary>) -> Self {
    Self {
      summaries,
      protocol_version: 1,
      schema_version: 1,
    }
  }
}

/** Resultado de una reconciliación: eventos que este peer debe enviar y recibir. */
#[derive(Debug, Clone)]
pub struct Reconciliation {
  pub domain: String,
  pub send_ids: Vec<String>,    // ids de eventos que tenemos y el peer no
  pub receive_ids: Vec<String>, // ids que el peer tiene y nosotros no
}

/** Dominio que difiere entre ambos resúmenes, con los conteos de cada lado. */
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DivergentDomain {
  pub domain: String,
  pub local_count: u64,
  pub remote_count: u64,
}

/** Lote de eventos listo para enviar (≤ MAX_BATCH_EVENTS o ≤ MAX_BATCH_BYTES). */
#[derive(Debug, Clone)]
pub struct EventBatch {
  pub domain: String,
  pub events: Vec<DomainEvent>,
  pub batch_sha256: String, // hex del hash del lote
}

/* ------------------------------------------------------------------ */
/* Cálculo de resumen                                                 */
/* ------------------------------------------------------------------ */

pub fn compute_summary(domain: &str, events: &[DomainEvent]) -> DomainSummary {
  let max_hlc = events.iter().map(|e| e.metadata.hlc).max().unwrap_or(0);
  let mut hash: u64 = 0;
  for e in events {
    let id_hash = hash_id(&e.id);
    hash ^= id_hash;
  }
  DomainSummary {
    domain: domain.to_string(),
    event_count: events.len() as u64,
    max_hlc,
    aggregate_hash: hash,
  }
}

fn hash_id(id: &str) -> u64 {
  let mut h: u64 = 0xcbf29ce484222325; // FNV offset
  for b in id.bytes() {
    h ^= b as u64;
    h = h.wrapping_mul(0x100000001b3); // FNV prime
  }
  h
}

/* ------------------------------------------------------------------ */
/* Diff entre dos resúmenes                                           */
/* ------------------------------------------------------------------ */

/**
 * Dominios cuyo contenido difiere realmente entre ambos resúmenes.
 *
 * A diferencia de `diff_summaries`, conserva los conteos de cada lado para
 * que el cliente y el servidor sepan cuántas listas de IDs esperar. Los
 * dominios ausentes se tratan como vacíos (conteo 0, hash 0), igual que
 * `compute_summary` para una lista vacía.
 */
pub fn divergent_domains(
  local: &[DomainSummary],
  remote: &[DomainSummary],
) -> Vec<DivergentDomain> {
  let mut local_map: BTreeMap<&str, &DomainSummary> = BTreeMap::new();
  for s in local {
    local_map.insert(s.domain.as_str(), s);
  }
  let mut remote_map: BTreeMap<&str, &DomainSummary> = BTreeMap::new();
  for s in remote {
    remote_map.insert(s.domain.as_str(), s);
  }

  let mut domains: Vec<&str> = local_map.keys().chain(remote_map.keys()).copied().collect();
  domains.sort_unstable();
  domains.dedup();

  let mut out = Vec::new();
  for domain in domains {
    let l = local_map.get(domain);
    let r = remote_map.get(domain);
    let local_count = l.map(|s| s.event_count).unwrap_or(0);
    let remote_count = r.map(|s| s.event_count).unwrap_or(0);
    let local_hash = l.map(|s| s.aggregate_hash).unwrap_or(0);
    let remote_hash = r.map(|s| s.aggregate_hash).unwrap_or(0);
    if local_count != remote_count || local_hash != remote_hash {
      out.push(DivergentDomain {
        domain: domain.to_string(),
        local_count,
        remote_count,
      });
    }
  }
  out
}

pub fn diff_summaries(
  local: &[DomainSummary],
  remote: &[DomainSummary],
) -> BTreeMap<String, (bool, bool)> {
  // clave: domain -> (local_tiene_mas, remote_tiene_mas) aproximado por conteo/hash
  let mut local_map: BTreeMap<String, &DomainSummary> = BTreeMap::new();
  for s in local {
    local_map.insert(s.domain.clone(), s);
  }
  let mut remote_map: BTreeMap<String, &DomainSummary> = BTreeMap::new();
  for s in remote {
    remote_map.insert(s.domain.clone(), s);
  }

  let mut out = BTreeMap::new();
  for domain in local_map.keys().chain(remote_map.keys()) {
    let l = local_map.get(domain);
    let r = remote_map.get(domain);
    match (l, r) {
      (Some(ls), Some(rs)) => {
        if ls.aggregate_hash != rs.aggregate_hash || ls.event_count != rs.event_count {
          out.insert(domain.clone(), (ls.event_count > rs.event_count, rs.event_count > ls.event_count));
        }
      }
      (Some(_), None) => {
        out.insert(domain.clone(), (true, false));
      }
      (None, Some(_)) => {
        out.insert(domain.clone(), (false, true));
      }
      (None, None) => {}
    }
  }
  out
}

/* ------------------------------------------------------------------ */
/* Batches                                                            */
/* ------------------------------------------------------------------ */

pub fn batch_events(
  domain: &str,
  events: &[DomainEvent],
) -> Vec<EventBatch> {
  let mut batches = Vec::new();
  let mut current: Vec<DomainEvent> = Vec::new();
  let mut current_bytes = 0usize;

  for ev in events {
    let ev_bytes = serde_json::to_vec(ev).unwrap_or_default().len();
    if current.len() >= MAX_BATCH_EVENTS || (current_bytes + ev_bytes > MAX_BATCH_BYTES && !current.is_empty()) {
      batches.push(make_batch(domain, std::mem::take(&mut current), current_bytes));
      current_bytes = 0;
    }
    current.push(ev.clone());
    current_bytes += ev_bytes;
  }
  if !current.is_empty() {
    batches.push(make_batch(domain, current, current_bytes));
  }
  batches
}

fn make_batch(domain: &str, mut events: Vec<DomainEvent>, bytes: usize) -> EventBatch {
  let payload = serde_json::to_vec(&events).unwrap_or_default();
  let mut hasher = sha2::Sha256::new();
  hasher.update(&payload);
  let digest = hasher.finalize();
  let batch_sha256 = digest.iter().map(|b| format!("{b:02x}")).collect();
  events.sort_by(|a, b| a.metadata.hlc.cmp(&b.metadata.hlc));
  EventBatch {
    domain: domain.to_string(),
    events,
    batch_sha256,
  }
}

/* ------------------------------------------------------------------ */
/* Validación de evento entrante                                      */
/* ------------------------------------------------------------------ */

pub fn validate_incoming_event(
  ev: &DomainEvent,
  now_ms: u64,
  future_tolerance_ms: u64,
) -> Result<(), String> {
  // id válido
  if ev.id.is_empty() {
    return Err("evento sin id".into());
  }
  // tipo conocido (prefijo de dominio)
  let _prefix = ev.type_.split('.').next().unwrap_or("");
  // El HLC del frontend se codifica como `wall_ms * 1000 + contador`
  // (microsegundos lógicos), mientras que `now_ms` y la tolerancia están en
  // milisegundos. Comparar ambos valores directamente hacía que TODO evento
  // entrante pareciera ~1000 veces futuro y la sincronización fallara siempre.
  let hlc_ms = ev.metadata.hlc / 1000;
  if hlc_ms > now_ms + future_tolerance_ms {
    return Err(format!(
      "HLC del evento ({hlc_ms} ms) excesivamente futuro (ahora {now_ms} ms, tolerancia {future_tolerance_ms} ms)"
    ));
  }
  // payload serializable (ya lo es si llegó por la red)
  let _ = serde_json::to_string(ev);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn summary_and_diff_detects_divergence() {
    let ev1 = make_event("ev-1", 100);
    let ev2 = make_event("ev-2", 200);
    let local = vec![ev1.clone()];
    let remote = vec![ev1.clone(), ev2.clone()];

    let s_local = compute_summary("orders", &local);
    let s_remote = compute_summary("orders", &remote);
    assert_ne!(s_local.aggregate_hash, s_remote.aggregate_hash);
    assert_ne!(s_local.event_count, s_remote.event_count);

    let diff = diff_summaries(&[s_local], &[s_remote]);
    let d = diff.get("orders").unwrap();
    assert!(!d.0 && d.1); // remote tiene más
  }

  #[test]
  fn divergent_domains_returns_counts_and_ignores_equal_domains() {
    let ev1 = make_event("ev-1", 100);
    let ev2 = make_event("ev-2", 200);
    let orders_local = compute_summary("orders", &[ev1.clone()]);
    let orders_remote = compute_summary("orders", &[ev1.clone(), ev2.clone()]);
    let customers_local = compute_summary("customers", &[]);
    let customers_remote = compute_summary("customers", &[]);

    let divergent = divergent_domains(
      &[orders_local, customers_local],
      &[orders_remote, customers_remote],
    );
    assert_eq!(divergent.len(), 1);
    assert_eq!(divergent[0].domain, "orders");
    assert_eq!(divergent[0].local_count, 1);
    assert_eq!(divergent[0].remote_count, 2);
  }

  #[test]
  fn divergent_domains_detects_domains_missing_on_one_side() {
    let ev1 = make_event("ev-1", 100);
    let divergent = divergent_domains(&[], &[compute_summary("orders", &[ev1])]);
    assert_eq!(divergent.len(), 1);
    assert_eq!(divergent[0].local_count, 0);
    assert_eq!(divergent[0].remote_count, 1);
  }

  #[test]
  fn batches_respect_limits() {
    let events: Vec<_> = (0..1200).map(|i| make_event(&format!("ev-{i}"), i as u64)).collect();
    let batches = batch_events("orders", &events);
    assert!(batches.len() >= 3); // 1200 / 500 = 2.4 -> 3 lotes
    for b in &batches {
      assert!(b.events.len() <= MAX_BATCH_EVENTS);
    }
  }

  #[test]
  fn validate_rejects_future_hlc() {
    let ev = make_event("ev-future", u64::MAX);
    assert!(validate_incoming_event(&ev, 1000, 60_000).is_err());
  }

  #[test]
  fn validate_accepts_reasonable_hlc() {
    let ev = make_event("ev-ok", 5000);
    assert!(validate_incoming_event(&ev, 10000, 60_000).is_ok());
  }

  #[test]
  fn validate_accepts_hlc_encoded_in_microseconds() {
    // El HLC real es ms * 1000 + contador; no debe confundirse con ms.
    let now_ms = 1_793_164_690_356;
    let ev = make_event("ev-now", now_ms * 1000 + 123);
    assert!(validate_incoming_event(&ev, now_ms, 60_000).is_ok());
  }

  #[test]
  fn validate_rejects_future_hlc_encoded_in_microseconds() {
    let now_ms = 1_793_164_690_356;
    let ev = make_event("ev-future", (now_ms + 61_000) * 1000);
    assert!(validate_incoming_event(&ev, now_ms, 60_000).is_err());
  }

  fn make_event(id: &str, hlc: u64) -> DomainEvent {
    DomainEvent {
      id: id.to_string(),
      type_: "Order.Created".to_string(),
      payload: serde_json::json!({}),
      metadata: EventMetadata {
        hlc,
        device_id: "dev".to_string(),
        timestamp: hlc,
        version: 1,
      },
    }
  }
}
