use crate::sync::framing::{read_frame_async, write_frame_async, Frame, FrameType};
use crate::sync::store_types::DomainEvent;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

/* ------------------------------------------------------------------ */
/* Mensajes del canal TLS                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncHello {
  pub device_id: String,
  pub name: String,
  pub fingerprint: String,
  pub protocol_version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventsPayload {
  pub domain: String,
  pub events: Vec<DomainEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdListPayload {
  pub domain: String,
  pub ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorPayload {
  pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncReport {
  pub peer_id: String,
  pub peer_name: String,
  pub sent: usize,
  pub received: usize,
  pub domains: Vec<String>,
  pub at: u64,
}

pub async fn write_json<W, T>(writer: &mut W, kind: FrameType, value: &T) -> Result<(), String>
where
  W: AsyncWrite + Unpin,
  T: Serialize,
{
  let payload = serde_json::to_vec(value).map_err(|e| format!("JSON inválido: {e}"))?;
  write_frame_async(writer, &Frame { r#type: kind, payload })
    .await
    .map_err(|e| format!("Error de red escribiendo frame: {e}"))
}

pub async fn read_json<R, T>(reader: &mut R) -> Result<(FrameType, T), String>
where
  R: AsyncRead + Unpin,
  T: for<'de> Deserialize<'de>,
{
  let frame = read_frame_async(reader)
    .await
    .map_err(|e| format!("Error de red leyendo frame: {e}"))?;
  if frame.r#type == FrameType::Error {
    let err: ErrorPayload = serde_json::from_slice(&frame.payload).unwrap_or(ErrorPayload {
      message: String::from_utf8_lossy(&frame.payload).to_string(),
    });
    return Err(format!("El peer rechazó la operación: {}", err.message));
  }
  let value = serde_json::from_slice(&frame.payload)
    .map_err(|e| format!("Frame {} inválido: {e}", frame.r#type as u8))?;
  Ok((frame.r#type, value))
}

pub async fn send_error<W>(writer: &mut W, message: impl Into<String>)
where
  W: AsyncWrite + Unpin,
{
  let _ = write_json(
    writer,
    FrameType::Error,
    &ErrorPayload {
      message: message.into(),
    },
  )
  .await;
}
