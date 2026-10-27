use std::io::{self, Read};
use tokio::io::AsyncWriteExt;

/* ------------------------------------------------------------------ */
/* Framing del protocolo de sincronización                            */
/* ------------------------------------------------------------------ */

/** Tamaño máximo de un frame individual (1 MiB). */
pub const MAX_FRAME_SIZE: usize = 1_024 * 1024;

/** Longitud máxima de un lote de eventos (≤500 eventos o ≤1 MiB). */
pub const MAX_BATCH_EVENTS: usize = 500;
pub const MAX_BATCH_BYTES: usize = MAX_FRAME_SIZE;

/** Tipos de frame del protocolo. */
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
  Handshake = 0,
  Summary = 1,
  IdList = 2,
  Events = 3,
  BatchAck = 4,
  Error = 5,
  KeepAlive = 6,
  Bye = 7,
}

impl TryFrom<u8> for FrameType {
  type Error = io::Error;
  fn try_from(v: u8) -> Result<Self, io::Error> {
    match v {
      0 => Ok(FrameType::Handshake),
      1 => Ok(FrameType::Summary),
      2 => Ok(FrameType::IdList),
      3 => Ok(FrameType::Events),
      4 => Ok(FrameType::BatchAck),
      5 => Ok(FrameType::Error),
      6 => Ok(FrameType::KeepAlive),
      7 => Ok(FrameType::Bye),
      _ => Err(io::Error::new(io::ErrorKind::InvalidData, "tipo de frame desconocido")),
    }
  }
}

/** Un frame del protocolo. */
#[derive(Debug, Clone)]
pub struct Frame {
  pub r#type: FrameType,
  pub payload: Vec<u8>,
}

/** Escribe un frame en un búfer de bytes (prefijo u32 BE + tipo u8 + payload). */
pub fn write_frame_to_vec(buf: &mut Vec<u8>, frame: &Frame) -> io::Result<()> {
  if frame.payload.len() > MAX_FRAME_SIZE {
    return Err(io::Error::new(
      io::ErrorKind::InvalidInput,
      "frame excede el tamaño máximo",
    ));
  }
  let total = 1u32 + 4 + frame.payload.len() as u32;
  buf.extend_from_slice(&total.to_be_bytes());
  buf.push(frame.r#type as u8);
  buf.extend_from_slice(&frame.payload);
  Ok(())
}

/** Serializa un frame a bytes (útil para tests sin red). */
pub fn serialize_frame(frame: &Frame) -> Vec<u8> {
  let mut buf = Vec::new();
  let _ = write_frame_to_vec(&mut buf, frame);
  buf
}

/** Lee un frame de un lector. Valida el tamaño antes de leer el payload. */
pub fn read_frame<R: Read>(reader: &mut R) -> io::Result<Frame> {
  let mut len_buf = [0u8; 4];
  reader.read_exact(&mut len_buf)?;
  let total = u32::from_be_bytes(len_buf) as usize;
  if total < 5 || total > MAX_FRAME_SIZE + 5 {
    return Err(io::Error::new(
      io::ErrorKind::InvalidData,
      "longitud de frame inválida",
    ));
  }
  let mut type_buf = [0u8; 1];
  reader.read_exact(&mut type_buf)?;
  let r#type = FrameType::try_from(type_buf[0])?;
  let payload_len = total - 5;
  let mut payload = vec![0u8; payload_len];
  reader.read_exact(&mut payload)?;
  Ok(Frame { r#type, payload })
}

/** Escribe un frame en un stream async (tokio::io::Write). */
pub async fn write_frame_async<W: tokio::io::AsyncWrite + Unpin>(
  writer: &mut W,
  frame: &Frame,
) -> io::Result<()> {
  let mut buf = Vec::new();
  write_frame_to_vec(&mut buf, frame)?;
  writer.write_all(&buf).await?;
  writer.flush().await?;
  Ok(())
}

/** Deserializa bytes a un frame (útil para tests). */
pub fn deserialize_frame(buf: &[u8]) -> io::Result<Frame> {
  use std::io::Cursor;
  let mut cursor = Cursor::new(buf);
  read_frame(&mut cursor)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn roundtrip_frame() {
    let frame = Frame {
      r#type: FrameType::Events,
      payload: b"evento-prueba".to_vec(),
    };
    let mut buf = Vec::new();
    write_frame_to_vec(&mut buf, &frame).unwrap();
    let back = deserialize_frame(&buf).unwrap();
    assert_eq!(back.r#type, FrameType::Events);
    assert_eq!(back.payload, b"evento-prueba");
  }

  #[test]
  fn rejects_oversized_frame() {
    let frame = Frame {
      r#type: FrameType::Events,
      payload: vec![0u8; MAX_FRAME_SIZE + 1],
    };
    let mut buf = Vec::new();
    assert!(write_frame_to_vec(&mut buf, &frame).is_err());
  }

  #[test]
  fn rejects_invalid_type() {
    let mut buf = Vec::new();
    buf.extend_from_slice(&[9, 0, 0, 0]); // total=9
    buf.push(99); // tipo inválido
    buf.extend_from_slice(b"....");
    let result = deserialize_frame(&buf);
    assert!(result.is_err());
  }
}
