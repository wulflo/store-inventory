use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::AppHandle;

/* ------------------------------------------------------------------ */
/* Actualizaciones multiplataforma                                    */
/* ------------------------------------------------------------------ */

const UPDATE_ENDPOINT: &str =
  "https://github.com/wulflo/store-inventory/releases/latest/download/latest.json";
const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEU3M0I4RDQ3N0IwODJEN0YKUldSL0xRaDdSNDA3NTZUZEhkMXJHL1JrV0l3czFIWkxHLzNPejJmaEpmY0Q1NWVmd2lxT1ZVd0YK";

#[derive(Debug, Clone, Serialize)]
pub struct UpdateCheck {
  pub available: bool,
  pub current_version: String,
  pub version: Option<String>,
  pub notes: Option<String>,
  pub date: Option<String>,
  pub target: Option<String>,
  /// "desktop" | "android"
  pub kind: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseManifest {
  version: String,
  #[serde(default)]
  notes: Option<String>,
  #[serde(default)]
  pub_date: Option<String>,
  #[serde(default)]
  platforms: BTreeMap<String, ReleasePlatform>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleasePlatform {
  url: String,
  signature: String,
}

fn current_version() -> String {
  env!("CARGO_PKG_VERSION").to_string()
}

fn parse_version(text: &str) -> Option<semver::Version> {
  semver::Version::parse(text.trim().trim_start_matches('v')).ok()
}

fn is_newer(remote: &str, current: &str) -> bool {
  match (parse_version(remote), parse_version(current)) {
    (Some(remote), Some(current)) => remote > current,
    _ => remote.trim() != current.trim(),
  }
}

#[cfg(target_os = "android")]
fn android_target_candidates() -> Vec<&'static str> {
  let arch = std::env::consts::ARCH;
  let specific = match arch {
    "aarch64" => "android-aarch64",
    "arm" => "android-armv7",
    "x86_64" => "android-x86_64",
    "x86" => "android-i686",
    _ => "android-universal",
  };
  if specific == "android-universal" {
    vec!["android-universal", "android"]
  } else {
    vec![specific, "android-universal", "android"]
  }
}

#[cfg(target_os = "android")]
fn pick_platform<'a>(
  platforms: &'a BTreeMap<String, ReleasePlatform>,
) -> Option<(&'a str, &'a ReleasePlatform)> {
  for key in android_target_candidates() {
    if let Some(platform) = platforms.get(key) {
      return Some((key, platform));
    }
  }
  None
}

/// La firma de `latest.json` viaja en base64 (formato de Tauri). Aceptamos
/// también el contenido crudo del `.sig` por compatibilidad con manifiestos
/// generados por versiones antiguas del script.
fn decode_signature(value: &str) -> String {
  let compact = value.trim();
  match STANDARD.decode(compact) {
    Ok(bytes) => String::from_utf8(bytes).unwrap_or_else(|_| compact.to_string()),
    Err(_) => compact.to_string(),
  }
}

fn verify_apk(bytes: &[u8], signature: &str) -> Result<(), String> {
  let pubkey_text = STANDARD
    .decode(UPDATE_PUBKEY)
    .map_err(|e| format!("Clave pública del updater inválida: {e}"))?;
  let public_key = PublicKey::decode(
    std::str::from_utf8(&pubkey_text).map_err(|e| format!("Clave pública no UTF-8: {e}"))?,
  )
  .map_err(|e| format!("Clave pública minisign inválida: {e}"))?;
  let signature_text = decode_signature(signature);
  let signature =
    Signature::decode(&signature_text).map_err(|e| format!("Firma del APK inválida: {e}"))?;
  public_key
    .verify(bytes, &signature, true)
    .map_err(|e| format!("La firma del APK no es válida: {e}"))
}

/* ----------------------------- Android ---------------------------- */

#[cfg(target_os = "android")]
async fn fetch_manifest() -> Result<ReleaseManifest, String> {
  let client = reqwest::Client::builder()
    .user_agent(format!("InventarioTienda/{} Android", current_version()))
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|e| format!("No se pudo crear el cliente HTTP: {e}"))?;
  let response = client
    .get(UPDATE_ENDPOINT)
    .send()
    .await
    .map_err(|e| format!("No se pudo consultar actualizaciones: {e}"))?;
  if !response.status().is_success() {
    return Err(format!(
      "El servidor de actualizaciones respondió {}.",
      response.status()
    ));
  }
  response
    .json::<ReleaseManifest>()
    .await
    .map_err(|e| format!("Respuesta de actualizaciones inválida: {e}"))
}

#[cfg(target_os = "android")]
async fn android_check() -> Result<UpdateCheck, String> {
  let manifest = fetch_manifest().await?;
  let platform = pick_platform(&manifest.platforms);
  let available = platform.is_some() && is_newer(&manifest.version, &current_version());
  Ok(UpdateCheck {
    available,
    current_version: current_version(),
    version: Some(manifest.version.clone()),
    notes: manifest.notes,
    date: manifest.pub_date,
    target: platform.map(|(key, _)| key.to_string()),
    kind: "android".into(),
  })
}

#[cfg(target_os = "android")]
async fn android_install() -> Result<String, String> {
  let manifest = fetch_manifest().await?;
  if !is_newer(&manifest.version, &current_version()) {
    return Err("Ya tenés la última versión.".into());
  }
  let (_, platform) = pick_platform(&manifest.platforms).ok_or_else(|| {
    "El release no incluye un APK para este dispositivo. Intentá de nuevo cuando el release termine de publicarse."
      .to_string()
  })?;

  let client = reqwest::Client::builder()
    .user_agent(format!("InventarioTienda/{} Android", current_version()))
    .timeout(std::time::Duration::from_secs(300))
    .build()
    .map_err(|e| format!("No se pudo crear el cliente HTTP: {e}"))?;
  let response = client
    .get(&platform.url)
    .send()
    .await
    .map_err(|e| format!("No se pudo descargar el APK: {e}"))?;
  if !response.status().is_success() {
    return Err(format!(
      "La descarga del APK respondió {}.",
      response.status()
    ));
  }
  let bytes = response
    .bytes()
    .await
    .map_err(|e| format!("No se pudo leer el APK descargado: {e}"))?;
  if bytes.len() < 1024 {
    return Err("El APK descargado está vacío o incompleto.".into());
  }
  if bytes.len() > 300 * 1024 * 1024 {
    return Err("El APK descargado es demasiado grande.".into());
  }
  verify_apk(&bytes, &platform.signature)?;

  let file_name = format!("Inventario-Tienda-v{}.apk", manifest.version);
  let saved = crate::android_fs::save_to_downloads(
    &file_name,
    "application/vnd.android.package-archive",
    &bytes,
  )?;
  // Intentar lanzar el instalador automáticamente (FileProvider/MediaStore).
  let _ = crate::android_fs::install_apk(&file_name);
  Ok(format!(
    "APK {} guardado en Descargas. Ruta: {saved}. Si no se abrió el instalador, abrilo manualmente para actualizar.",
    manifest.version
  ))
}

/* ------------------------------ Comandos --------------------------- */

#[tauri::command]
pub async fn cmd_updater_check(app: AppHandle) -> Result<UpdateCheck, String> {
  #[cfg(target_os = "android")]
  {
    let _ = app;
    android_check().await
  }
  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
      .updater()
      .map_err(|e| format!("El actualizador no está disponible: {e}"))?;
    match updater
      .check()
      .await
      .map_err(|e| format!("No se pudo buscar actualizaciones: {e}"))?
    {
      Some(update) => Ok(UpdateCheck {
        available: true,
        current_version: update.current_version.clone(),
        version: Some(update.version.clone()),
        notes: update.body.clone(),
        date: update.date.map(|d| d.to_string()),
        target: Some(update.target.clone()),
        kind: "desktop".into(),
      }),
      None => Ok(UpdateCheck {
        available: false,
        current_version: current_version(),
        version: None,
        notes: None,
        date: None,
        target: None,
        kind: "desktop".into(),
      }),
    }
  }
}

#[tauri::command]
pub async fn cmd_updater_install(app: AppHandle) -> Result<String, String> {
  #[cfg(target_os = "android")]
  {
    let _ = app;
    android_install().await
  }
  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
      .updater()
      .map_err(|e| format!("El actualizador no está disponible: {e}"))?;
    let update = updater
      .check()
      .await
      .map_err(|e| format!("No se pudo buscar actualizaciones: {e}"))?
      .ok_or_else(|| "Ya tenés la última versión.".to_string())?;
    update
      .download_and_install(|_, _| {}, || {})
      .await
      .map_err(|e| format!("No se pudo instalar la actualización: {e}"))?;
    Ok(format!(
      "Versión {} descargada e instalada. Cerrá y volvé a abrir la app para usar la nueva versión.",
      update.version
    ))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn semver_comparison() {
    assert!(is_newer("0.1.3", "0.1.2"));
    assert!(!is_newer("0.1.2", "0.1.2"));
    assert!(!is_newer("0.1.1", "0.1.2"));
  }

  #[test]
  fn decodes_base64_signature() {
    let raw = "untrusted comment: test\nABC\n";
    let encoded = STANDARD.encode(raw);
    assert_eq!(decode_signature(&encoded), raw);
  }
}
