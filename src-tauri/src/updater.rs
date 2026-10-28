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
const RELEASES_URL: &str = "https://github.com/wulflo/store-inventory/releases/latest";
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
    // Si alguna versión no es semver, no arriesgamos una actualización:
    // preferimos no descargar nada antes que comparar strings arbitrarios.
    _ => false,
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

fn verify_release_signature(bytes: &[u8], signature: &str) -> Result<(), String> {
  let pubkey_text = STANDARD
    .decode(UPDATE_PUBKEY)
    .map_err(|e| format!("Clave pública del updater inválida: {e}"))?;
  let public_key = PublicKey::decode(
    std::str::from_utf8(&pubkey_text).map_err(|e| format!("Clave pública no UTF-8: {e}"))?,
  )
  .map_err(|e| format!("Clave pública minisign inválida: {e}"))?;
  let signature_text = decode_signature(signature);
  let signature =
    Signature::decode(&signature_text).map_err(|e| format!("Firma del archivo inválida: {e}"))?;
  public_key
    .verify(bytes, &signature, true)
    .map_err(|e| format!("La firma del archivo no es válida: {e}"))
}

/* ----------------------------- Común ------------------------------ */

fn update_user_agent() -> String {
  if cfg!(target_os = "android") {
    format!("InventarioTienda/{} Android", current_version())
  } else {
    format!("InventarioTienda/{} Desktop", current_version())
  }
}

async fn fetch_manifest() -> Result<ReleaseManifest, String> {
  let client = reqwest::Client::builder()
    .user_agent(update_user_agent())
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
  let manifest = response
    .json::<ReleaseManifest>()
    .await
    .map_err(|e| format!("Respuesta de actualizaciones inválida: {e}"))?;
  if parse_version(&manifest.version).is_none() {
    return Err(format!(
      "El manifiesto tiene una versión inválida: {}",
      manifest.version
    ));
  }
  Ok(manifest)
}

async fn download_release_bytes(url: &str, timeout_secs: u64) -> Result<Vec<u8>, String> {
  let client = reqwest::Client::builder()
    .user_agent(update_user_agent())
    .timeout(std::time::Duration::from_secs(timeout_secs))
    .build()
    .map_err(|e| format!("No se pudo crear el cliente HTTP: {e}"))?;
  let response = client
    .get(url)
    .send()
    .await
    .map_err(|e| format!("No se pudo descargar la actualización: {e}"))?;
  if !response.status().is_success() {
    return Err(format!(
      "La descarga respondió {}. Puede que el release todavía se esté publicando.",
      response.status()
    ));
  }
  let bytes = response
    .bytes()
    .await
    .map_err(|e| format!("No se pudo leer la descarga: {e}"))?;
  if bytes.is_empty() {
    return Err("El archivo descargado está vacío.".into());
  }
  Ok(bytes.to_vec())
}

/* ----------------------------- Android ---------------------------- */

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

  let bytes = download_release_bytes(&platform.url, 300).await?;
  if bytes.len() < 1024 {
    return Err("El APK descargado está vacío o incompleto.".into());
  }
  if bytes.len() > 300 * 1024 * 1024 {
    return Err("El APK descargado es demasiado grande.".into());
  }
  verify_release_signature(&bytes, &platform.signature)?;

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

/* ----------------------------- Desktop ---------------------------- */

/// Plan B cuando el plugin updater no puede instalar (por ejemplo, una
/// instalación hecha con `.deb`). Descarga el artefacto correcto y abre el
/// instalador del sistema para que el usuario confirme.
#[cfg(not(target_os = "android"))]
fn pick_desktop_platform<'a>(
  platforms: &'a BTreeMap<String, ReleasePlatform>,
) -> Option<(&'a str, &'a ReleasePlatform)> {
  let key = if cfg!(target_os = "linux") {
    "linux-x86_64"
  } else if cfg!(target_os = "windows") {
    "windows-x86_64"
  } else if cfg!(target_os = "macos") {
    if std::env::consts::ARCH == "aarch64" {
      "darwin-aarch64"
    } else {
      "darwin-x86_64"
    }
  } else {
    return None;
  };
  platforms.get(key).map(|platform| (key, platform))
}

#[cfg(not(target_os = "android"))]
fn release_file_name(url: &str) -> String {
  let raw = url
    .split('?')
    .next()
    .unwrap_or(url)
    .rsplit('/')
    .next()
    .unwrap_or("inventario-tienda-update");
  let sanitized: String = raw
    .chars()
    .map(|c| {
      if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
        c
      } else {
        '_'
      }
    })
    .collect();
  if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
    "inventario-tienda-update".to_string()
  } else {
    sanitized
  }
}

#[cfg(not(target_os = "android"))]
async fn desktop_manual_install(app: &AppHandle) -> Result<String, String> {
  use tauri::Manager;
  use tauri_plugin_opener::OpenerExt;

  let manifest = fetch_manifest().await?;
  let (key, platform) = pick_desktop_platform(&manifest.platforms)
    .ok_or_else(|| "El release no incluye un instalador para este sistema.".to_string())?;

  // En Linux, si la app no corre como AppImage, probablemente se instaló con
  // el .deb. El plugin updater solo puede reemplazar AppImages, así que
  // descargamos el .deb del release… pero SOLO si viene con firma propia.
  let use_deb = cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_none();
  let (url, file_name, signature) = if use_deb {
    let deb = manifest.platforms.get("linux-x86_64-deb").ok_or_else(|| {
      format!(
        "Esta versión no publicó un .deb firmado para el actualizador. \
         Descargalo manualmente desde {RELEASES_URL}"
      )
    })?;
    (
      deb.url.clone(),
      release_file_name(&deb.url),
      deb.signature.clone(),
    )
  } else {
    (
      platform.url.clone(),
      release_file_name(&platform.url),
      platform.signature.clone(),
    )
  };

  let bytes = download_release_bytes(&url, 300).await?;
  if bytes.len() < 1024 {
    return Err("El instalador descargado está vacío o incompleto.".into());
  }
  // Nunca instalamos un artefacto sin verificar su firma minisign.
  verify_release_signature(&bytes, &signature)?;

  let downloads = app
    .path()
    .download_dir()
    .or_else(|_| app.path().home_dir())
    .map_err(|e| format!("No se pudo ubicar la carpeta de descargas: {e}"))?;
  std::fs::create_dir_all(&downloads)
    .map_err(|e| format!("No se pudo crear la carpeta de descargas: {e}"))?;
  let destination = downloads.join(&file_name);
  std::fs::write(&destination, &bytes)
    .map_err(|e| format!("No se pudo guardar el instalador: {e}"))?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if !use_deb {
      if let Ok(metadata) = std::fs::metadata(&destination) {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        let _ = std::fs::set_permissions(&destination, permissions);
      }
    }
  }

  let opened = app
    .opener()
    .open_path(destination.to_string_lossy().to_string(), None::<&str>)
    .is_ok();
  let path = destination.display();
  let suffix = if opened {
    "Se abrió el instalador del sistema; confirmá la instalación."
  } else {
    "Abrilo manualmente para instalar la nueva versión."
  };
  Ok(format!(
    "No se pudo instalar automáticamente, pero se descargó la versión {} ({}): {path}. {suffix}",
    manifest.version, key
  ))
}

/* ------------------------------ Comandos --------------------------- */

#[tauri::command]
pub async fn cmd_updater_check(app: AppHandle) -> Result<UpdateCheck, String> {
  #[cfg(target_os = "android")]
  {
    let _ = app;
    match tokio::time::timeout(std::time::Duration::from_secs(30), android_check()).await {
      Ok(res) => res,
      Err(_) => Err("Tiempo agotado al buscar actualizaciones.".into()),
    }
  }
  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
      .updater()
      .map_err(|e| format!("El actualizador no está disponible: {e}"))?;
    let check_result = tokio::time::timeout(std::time::Duration::from_secs(30), updater.check())
      .await
      .map_err(|_| "Tiempo agotado al buscar actualizaciones.".to_string())?;
    match check_result.map_err(|e| format!("No se pudo buscar actualizaciones: {e}"))? {
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
    match tokio::time::timeout(std::time::Duration::from_secs(300), android_install()).await {
      Ok(res) => res,
      Err(_) => Err("Tiempo agotado al descargar la actualización.".into()),
    }
  }
  #[cfg(not(target_os = "android"))]
  {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
      .updater()
      .map_err(|e| format!("El actualizador no está disponible: {e}"))?;
    let check_result = tokio::time::timeout(std::time::Duration::from_secs(30), updater.check())
      .await
      .map_err(|_| "Tiempo agotado al buscar actualizaciones.".to_string())?;
    let update = check_result
      .map_err(|e| format!("No se pudo buscar actualizaciones: {e}"))?
      .ok_or_else(|| "Ya tenés la última versión.".to_string())?;

    let plugin_result: Result<(), String> = match tokio::time::timeout(
      std::time::Duration::from_secs(180),
      update.download_and_install(|_, _| {}, || {}),
    )
    .await
    {
      Ok(Ok(())) => Ok(()),
      Ok(Err(error)) => Err(error.to_string()),
      Err(_) => Err("Tiempo agotado al descargar la actualización.".into()),
    };

    match plugin_result {
      Ok(()) => Ok(format!(
        "Versión {} descargada e instalada. Cerrá y volvé a abrir la app para usar la nueva versión.",
        update.version
      )),
      Err(plugin_error) => {
        let manual = tokio::time::timeout(
          std::time::Duration::from_secs(300),
          desktop_manual_install(&app),
        )
        .await
        .map_err(|_| {
          format!(
            "El actualizador falló ({plugin_error}) y la descarga manual agotó el tiempo."
          )
        })?;
        manual.map(|message| format!("{message} Detalle del actualizador: {plugin_error}"))
      }
    }
  }
}

#[tauri::command]
pub fn cmd_open_release_page(app: AppHandle) -> Result<(), String> {
  use tauri_plugin_opener::OpenerExt;
  app
    .opener()
    .open_url(
      "https://github.com/wulflo/store-inventory/releases/latest",
      None::<&str>,
    )
    .map_err(|e| format!("No se pudo abrir la página de descargas: {e}"))
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
