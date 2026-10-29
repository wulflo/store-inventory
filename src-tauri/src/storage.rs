//! Abstracción de almacenamiento para la bóveda.
//!
//! En escritorio la bóveda es una carpeta normal y se usa `std::fs`.
//! En Android la bóveda se eligió con SAF y se accede con
//! `tauri-plugin-android-fs`; la "raíz" es un `DirPath` serializado como JSON
//! (`{"topTreeUri":"...","relativeTerms":["omega"]}`), no una ruta del sistema.
//!
//! Todas las rutas que reciben estas funciones son **relativas** a la raíz de
//! datos (`omega`) y usan `/` como separador. Nunca se aceptan `..`.

#[cfg(target_os = "android")]
use std::collections::BTreeMap;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "android")]
use std::sync::Mutex;
use std::sync::OnceLock;

use tauri::AppHandle;

#[cfg(target_os = "android")]
use tauri_plugin_android_fs::{AndroidFs, AndroidFsExt, DirPath, EntryPath, FilePath};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Guarda el `AppHandle` para que las operaciones SAF puedan acceder al plugin.
pub fn init_app(app: AppHandle) {
  let _ = APP_HANDLE.set(app);
}

/// `AppHandle` guardado en `init_app`, si ya está disponible.
///
/// Lo usan el diario local y las operaciones que necesitan resolver el
/// directorio privado de la app (fuera de la bóveda).
pub(crate) fn app_handle() -> Option<AppHandle> {
  APP_HANDLE.get().cloned()
}

#[cfg(target_os = "android")]
fn android_app_handle() -> Result<AppHandle, String> {
  app_handle().ok_or_else(|| "El almacenamiento SAF todavía no está inicializado.".to_string())
}

/// `true` si la raíz es un `DirPath` SAF serializado.
pub fn is_saf(root: &str) -> bool {
  let trimmed = root.trim_start();
  trimmed.starts_with('{') && trimmed.contains("topTreeUri")
}

/// Normaliza una ruta relativa y rechaza componentes peligrosos.
pub fn normalize(relative: &str) -> Result<String, String> {
  let replaced = relative.replace('\\', "/");
  let trimmed = replaced.trim_matches('/');
  if trimmed.is_empty() {
    return Ok(String::new());
  }
  for component in Path::new(trimmed).components() {
    match component {
      Component::Normal(_) => {}
      _ => {
        return Err(format!(
          "La ruta '{relative}' no es válida dentro de la bóveda."
        ))
      }
    }
  }
  Ok(trimmed.to_string())
}

fn local_path(root: &str, relative: &str) -> Result<PathBuf, String> {
  let relative = normalize(relative)?;
  let base = Path::new(root);
  if relative.is_empty() {
    Ok(base.to_path_buf())
  } else {
    Ok(base.join(relative))
  }
}

#[cfg(target_os = "android")]
fn mime_for(_relative: &str) -> &'static str {
  // SAF agrega una extensión según el MIME si el nombre no termina en ella.
  // `application/json` convertía `events/foo.jsonl` en `foo.jsonl.json`, y
  // cada escritura creaba un duplicado (" (1)", " (2)"...). El MIME genérico
  // conserva exactamente el nombre que pidió la app.
  "application/octet-stream"
}

/* ------------------------------------------------------------------ */
/* Implementación SAF                                                 */
/* ------------------------------------------------------------------ */

#[cfg(target_os = "android")]
struct SafCtx {
  root: DirPath,
  files: BTreeMap<String, FilePath>,
  dirs: BTreeMap<String, DirPath>,
  /// Última vez que se releyó el árbol SAF. Un agente externo puede
  /// reemplazar documentos (borrar + crear) y dejar URIs viejas; refrescar
  /// con TTL evita leer/escribir el documento equivocado sin escanear en cada
  /// operación.
  last_refresh: Option<std::time::Instant>,
}

#[cfg(target_os = "android")]
const SAF_INDEX_TTL: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(target_os = "android")]
impl SafCtx {
  fn new(root: DirPath) -> Self {
    Self {
      root,
      files: BTreeMap::new(),
      dirs: BTreeMap::new(),
      last_refresh: None,
    }
  }

  fn index_is_fresh(&self) -> bool {
    self
      .last_refresh
      .map(|t| t.elapsed() < SAF_INDEX_TTL)
      .unwrap_or(false)
  }

  fn scan(
    &self,
    dir: &DirPath,
    prefix: &str,
    depth: usize,
    files: &mut BTreeMap<String, FilePath>,
    dirs: &mut BTreeMap<String, DirPath>,
  ) -> Result<(), String> {
    if depth > 64 {
      return Err("La bóveda SAF tiene demasiados niveles de carpetas.".to_string());
    }
    let app = android_app_handle()?;
    let api = app.android_fs();
    let entries = api.read_dir(dir).map_err(|e| e.to_string())?;
    for (name, entry) in entries {
      if name.is_empty() || name == "." || name == ".." {
        continue;
      }
      let relative = if prefix.is_empty() {
        name
      } else {
        format!("{prefix}/{name}")
      };
      match entry {
        EntryPath::File(path) => {
          files.insert(relative, path);
        }
        EntryPath::Dir(child) => {
          dirs.insert(relative.clone(), child.clone());
          self.scan(&child, &relative, depth + 1, files, dirs)?;
        }
      }
    }
    Ok(())
  }

  fn refresh(&mut self) -> Result<(), String> {
    let mut files = BTreeMap::new();
    let mut dirs = BTreeMap::new();
    self.scan(&self.root, "", 0, &mut files, &mut dirs)?;
    self.files = files;
    self.dirs = dirs;
    self.last_refresh = Some(std::time::Instant::now());
    Ok(())
  }

  fn file_path(&mut self, relative: &str) -> Result<Option<FilePath>, String> {
    let relative = normalize(relative)?;
    if relative.is_empty() {
      return Ok(None);
    }
    if let Some(path) = self.files.get(&relative) {
      if self.index_is_fresh() {
        return Ok(Some(path.clone()));
      }
    }
    self.refresh()?;
    Ok(self.files.get(&relative).cloned())
  }

  fn dir_path(&mut self, relative: &str) -> Result<DirPath, String> {
    let relative = normalize(relative)?;
    if relative.is_empty() {
      return Ok(self.root.clone());
    }
    if let Some(path) = self.dirs.get(&relative) {
      return Ok(path.clone());
    }
    self.refresh()?;
    self
      .dirs
      .get(&relative)
      .cloned()
      .ok_or_else(|| format!("No se encontró la carpeta '{relative}' en la bóveda SAF."))
  }

  fn ensure_dir(&mut self, relative: &str) -> Result<DirPath, String> {
    let relative = normalize(relative)?;
    if relative.is_empty() {
      return Ok(self.root.clone());
    }
    if let Ok(path) = self.dir_path(&relative) {
      return Ok(path);
    }
    let app = android_app_handle()?;
    let api = app.android_fs();
    let marker_file = format!(
      ".keep-{}",
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    );
    let keep_name = format!("{relative}/{marker_file}");
    let keep = api
      .new_file_with_contents(&self.root, &keep_name, Some("text/plain"), b"")
      .map_err(|e| format!("No se pudo crear la carpeta '{relative}': {e}"))?;
    let _ = api.remove_file(&keep);
    self.refresh()?;
    let dir = self
      .dirs
      .get(&relative)
      .cloned()
      .ok_or_else(|| format!("No se pudo crear la carpeta '{relative}' en la bóveda SAF."))?;

    // El plugin no expone create_dir; el archivo marcador es el precio de
    // crearla. Si `remove_file` no aceptó el FilePath recién creado, lo
    // borramos usando el FilePath que devuelve `read_dir`.
    if let Ok(entries) = api.read_dir(&dir) {
      for (name, entry) in entries {
        if name == marker_file {
          if let EntryPath::File(path) = entry {
            let _ = api.remove_file(&path);
          }
        }
      }
    }

    Ok(dir)
  }

  fn read_bytes(&mut self, relative: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(path) = self.file_path(relative)? else {
      return Ok(None);
    };
    let app = android_app_handle()?;
    let api = app.android_fs();
    api
      .read(&path)
      .map(Some)
      .map_err(|e| format!("No se pudo leer '{relative}' de la bóveda: {e}"))
  }

  fn write_bytes(&mut self, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let relative = normalize(relative)?;
    if relative.is_empty() {
      return Err("No se puede escribir en la raíz de la bóveda.".to_string());
    }
    // Los archivos de eventos pueden haber sido reemplazados por un agente de
    // sync: no escribir sobre una URI vieja.
    if relative.starts_with("events/") {
      self.refresh()?;
    }
    if let Some(path) = self.file_path(&relative)? {
      let app = android_app_handle()?;
      let api = app.android_fs();
      return api
        .write(&path, bytes)
        .map_err(|e| format!("No se pudo escribir '{relative}': {e}"));
    }
    let app = android_app_handle()?;
    let api = app.android_fs();
    let path = api
      .new_file_with_contents(&self.root, &relative, Some(mime_for(&relative)), bytes)
      .map_err(|e| format!("No se pudo crear '{relative}': {e}"))?;
    self.files.insert(relative, path);
    Ok(())
  }

  fn append_bytes(&mut self, relative: &str, bytes: &[u8]) -> Result<(), String> {
    let relative = normalize(relative)?;
    if relative.is_empty() {
      return Err("No se puede escribir en la raíz de la bóveda.".to_string());
    }
    // Forzar un índice fresco: si el agente de sync reemplazó el documento,
    // la URI cacheada apuntaría al archivo viejo.
    self.refresh()?;
    if let Some(path) = self.files.get(&relative).cloned() {
      let uri = tauri_plugin_android_fs::convert_file_path_to_string(&path);
      return crate::android_fs::append_saf_file(&uri, bytes);
    }
    // No existe todavía: crearlo con el contenido (no hay nada que appendear).
    self.write_bytes(&relative, bytes)
  }

  fn remove_file(&mut self, relative: &str) -> Result<(), String> {
    let Some(path) = self.file_path(relative)? else {
      return Ok(());
    };
    let app = android_app_handle()?;
    let api = app.android_fs();
    api
      .remove_file(&path)
      .map_err(|e| format!("No se pudo borrar '{relative}': {e}"))?;
    self.files.remove(&normalize(relative)?);
    Ok(())
  }

  fn list_dir(&mut self, relative: &str) -> Result<Vec<String>, String> {
    let dir = self.dir_path(relative)?;
    let app = android_app_handle()?;
    let api = app.android_fs();
    let entries = api.read_dir(&dir).map_err(|e| e.to_string())?;
    let prefix = normalize(relative)?;
    let mut names = Vec::new();
    for (name, entry) in entries {
      if name.is_empty() || name == "." || name == ".." {
        continue;
      }
      let child = if prefix.is_empty() {
        name.clone()
      } else {
        format!("{prefix}/{name}")
      };
      match entry {
        EntryPath::File(path) => {
          self.files.insert(child, path);
        }
        EntryPath::Dir(path) => {
          self.dirs.insert(child, path);
        }
      }
      names.push(name);
    }
    names.sort();
    Ok(names)
  }

  fn list_files_recursive(&mut self, relative: &str) -> Result<Vec<String>, String> {
    let prefix = normalize(relative)?;
    self.refresh()?;
    let mut out: Vec<String> = self
      .files
      .keys()
      .filter(|path| {
        prefix.is_empty()
          || *path == &prefix
          || path.starts_with(&format!("{prefix}/"))
      })
      .cloned()
      .collect();
    out.sort();
    Ok(out)
  }
}

#[cfg(target_os = "android")]
fn saf_context(root: &str) -> Result<std::sync::MutexGuard<'static, BTreeMap<String, SafCtx>>, String> {
  static CONTEXTS: OnceLock<Mutex<BTreeMap<String, SafCtx>>> = OnceLock::new();
  let map = CONTEXTS.get_or_init(|| Mutex::new(BTreeMap::new()));
  let mut guard = map.lock().map_err(|_| "No se pudo acceder al índice SAF.".to_string())?;
  if !guard.contains_key(root) {
    let path: DirPath = serde_json::from_str(root)
      .map_err(|e| format!("La ruta SAF guardada está dañada: {e}"))?;
    guard.insert(root.to_string(), SafCtx::new(path));
  }
  Ok(guard)
}

/* ------------------------------------------------------------------ */
/* API pública                                                        */
/* ------------------------------------------------------------------ */

pub fn read_bytes(root: &str, relative: &str) -> Result<Option<Vec<u8>>, String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.read_bytes(relative);
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  match std::fs::read(&path) {
    Ok(bytes) => Ok(Some(bytes)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("No se pudo leer {path:?}: {e}")),
  }
}

pub fn read_string(root: &str, relative: &str) -> Result<Option<String>, String> {
  let bytes = read_bytes(root, relative)?;
  match bytes {
    Some(bytes) => String::from_utf8(bytes)
      .map(Some)
      .map_err(|e| format!("El archivo '{relative}' no es texto UTF-8 válido: {e}")),
    None => Ok(None),
  }
}

/// Fuerza a releer el índice SAF. En escritorio no hace nada.
///
/// Se usa antes de una reparación para no comparar contra URIs viejas.
pub fn refresh_index(root: &str) -> Result<(), String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.refresh();
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  Ok(())
}

pub fn exists(root: &str, relative: &str) -> Result<bool, String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return Ok(ctx.file_path(relative)?.is_some() || ctx.dir_path(relative).is_ok());
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  Ok(local_path(root, relative)?.exists())
}

pub fn write_bytes(root: &str, relative: &str, bytes: &[u8]) -> Result<(), String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.write_bytes(relative, bytes);
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| format!("No se pudo crear la carpeta {parent:?}: {e}"))?;
  }
  std::fs::write(&path, bytes).map_err(|e| format!("No se pudo escribir {path:?}: {e}"))
}

/// Escritura atómica en local; en SAF se escribe directo (SAF no lo garantiza).
pub fn write_atomic(root: &str, relative: &str, bytes: &[u8]) -> Result<(), String> {
  if is_saf(root) {
    return write_bytes(root, relative, bytes);
  }
  let path = local_path(root, relative)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| format!("No se pudo crear la carpeta {parent:?}: {e}"))?;
  }
  let tmp = path.with_extension(format!(
    "{}.tmp",
    path.extension().and_then(|e| e.to_str()).unwrap_or("tmp")
  ));
  std::fs::write(&tmp, bytes).map_err(|e| format!("No se pudo escribir {tmp:?}: {e}"))?;
  std::fs::rename(&tmp, &path).map_err(|e| format!("No se pudo reemplazar {path:?}: {e}"))
}

pub fn append_bytes(root: &str, relative: &str, bytes: &[u8]) -> Result<(), String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.append_bytes(relative, bytes);
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  use std::io::Write;
  let path = local_path(root, relative)?;
  if let Some(parent) = path.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| format!("No se pudo crear la carpeta {parent:?}: {e}"))?;
  }
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| format!("No se pudo abrir {path:?} para agregar: {e}"))?;
  file
    .write_all(bytes)
    .map_err(|e| format!("No se pudo escribir en {path:?}: {e}"))?;
  file
    .flush()
    .map_err(|e| format!("No se pudo sincronizar {path:?}: {e}"))
}

pub fn create_dir_all(root: &str, relative: &str) -> Result<(), String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      ctx.ensure_dir(relative)?;
      return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  std::fs::create_dir_all(&path).map_err(|e| format!("No se pudo crear {path:?}: {e}"))
}

pub fn list_dir(root: &str, relative: &str) -> Result<Vec<String>, String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.list_dir(relative);
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  match std::fs::read_dir(&path) {
    Ok(entries) => {
      let mut names = Vec::new();
      for entry in entries {
        let entry = entry.map_err(|e| format!("No se pudo leer {path:?}: {e}"))?;
        if let Some(name) = entry.file_name().to_str() {
          names.push(name.to_string());
        }
      }
      names.sort();
      Ok(names)
    }
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
    Err(e) => Err(format!("No se pudo leer {path:?}: {e}")),
  }
}

pub fn list_files_recursive(root: &str, relative: &str) -> Result<Vec<String>, String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.list_files_recursive(relative);
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let base = local_path(root, relative)?;
  let mut out = Vec::new();
  let mut stack = vec![(base, normalize(relative)?)];
  while let Some((dir, prefix)) = stack.pop() {
    let entries = match std::fs::read_dir(&dir) {
      Ok(entries) => entries,
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
      Err(e) => return Err(format!("No se pudo leer {dir:?}: {e}")),
    };
    for entry in entries {
      let entry = entry.map_err(|e| format!("No se pudo leer {dir:?}: {e}"))?;
      let path = entry.path();
      let name = entry.file_name().to_string_lossy().to_string();
      let child = if prefix.is_empty() {
        name
      } else {
        format!("{prefix}/{name}")
      };
      if path.is_dir() {
        stack.push((path, child));
      } else {
        out.push(child);
      }
    }
  }
  out.sort();
  Ok(out)
}

pub fn remove_file(root: &str, relative: &str) -> Result<(), String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      return ctx.remove_file(relative);
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  match std::fs::remove_file(&path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("No se pudo borrar {path:?}: {e}")),
  }
}

pub fn remove_dir_all(root: &str, relative: &str) -> Result<(), String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      // El plugin no expone remove_dir para DirPath: se borran los archivos
      // recursivamente y después se intenta limpiar la carpeta con JNI.
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      let prefix = normalize(relative)?;
      let files = ctx.list_files_recursive(&prefix)?;
      for file in files {
        ctx.remove_file(&file)?;
      }
      let _ = crate::android_fs::delete_saf_dir(root, &prefix);
      // El JNI borra la carpeta fuera del plugin; hay que invalidar el índice
      // para que un `create_dir_all` posterior no reutilice un DirPath muerto.
      ctx.refresh()?;
      return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  match std::fs::remove_dir_all(&path) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("No se pudo borrar {path:?}: {e}")),
  }
}

pub fn rename(root: &str, from: &str, to: &str) -> Result<(), String> {
  if is_saf(root) {
    let bytes = read_bytes(root, from)?
      .ok_or_else(|| format!("No se encontró '{from}' para mover."))?;
    write_bytes(root, to, &bytes)?;
    remove_file(root, from)?;
    return Ok(());
  }
  let from = local_path(root, from)?;
  let to = local_path(root, to)?;
  if let Some(parent) = to.parent() {
    std::fs::create_dir_all(parent)
      .map_err(|e| format!("No se pudo crear la carpeta {parent:?}: {e}"))?;
  }
  std::fs::rename(&from, &to).map_err(|e| format!("No se pudo mover {from:?} a {to:?}: {e}"))
}

/// Huella barata de un archivo: tamaño + mtime.
///
/// Sirve para detectar cambios externos (agentes de sincronización) sin leer
/// el contenido completo. En SAF se obtiene abriendo el descriptor y leyendo
/// `metadata()`: el plugin no expone `lastModified` directamente, pero el fd
/// soporta `fstat`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
  pub size: u64,
  pub mtime: Option<u64>,
}

pub fn fingerprint(root: &str, relative: &str) -> Result<Option<FileFingerprint>, String> {
  if is_saf(root) {
    #[cfg(target_os = "android")]
    {
      let mut guard = saf_context(root)?;
      let ctx = guard
        .get_mut(root)
        .ok_or_else(|| "No se pudo abrir la bóveda SAF.".to_string())?;
      let Some(path) = ctx.file_path(relative)? else {
        return Ok(None);
      };
      let app = android_app_handle()?;
      let api = app.android_fs();
      let file = api
        .open_file(&path)
        .map_err(|e| format!("No se pudo abrir '{relative}' para leer su huella: {e}"))?;
      let metadata = file
        .metadata()
        .map_err(|e| format!("No se pudo leer la huella de '{relative}': {e}"))?;
      let mtime = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
      return Ok(Some(FileFingerprint {
        size: metadata.len(),
        mtime,
      }));
    }
    #[cfg(not(target_os = "android"))]
    {
      return Err("La bóveda SAF solo está disponible en Android.".to_string());
    }
  }
  let path = local_path(root, relative)?;
  let metadata = match std::fs::metadata(&path) {
    Ok(metadata) => metadata,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("No se pudo leer {path:?}: {e}")),
  };
  let mtime = metadata
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64);
  Ok(Some(FileFingerprint {
    size: metadata.len(),
    mtime,
  }))
}

pub fn mtime_ms(root: &str, relative: &str) -> Result<Option<u64>, String> {
  Ok(fingerprint(root, relative)?.and_then(|f| f.mtime))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_root(tag: &str) -> String {
    let nanos = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    std::env::temp_dir()
      .join(format!("inventario-storage-{tag}-{nanos}"))
      .to_string_lossy()
      .to_string()
  }

  #[test]
  fn normalize_rejects_escape_paths() {
    assert!(normalize("../fuera").is_err());
    assert!(normalize("events/../../fuera").is_err());
    assert!(normalize("/events/orders.jsonl").is_ok());
    assert_eq!(normalize("events/orders.jsonl").unwrap(), "events/orders.jsonl");
  }

  #[test]
  fn local_roundtrip_and_recursive_listing() {
    let root = temp_root("local");
    write_bytes(&root, "events/orders.jsonl", b"uno\n").unwrap();
    append_bytes(&root, "events/orders.jsonl", b"dos\n").unwrap();
    assert_eq!(
      read_string(&root, "events/orders.jsonl").unwrap().unwrap(),
      "uno\ndos\n"
    );
    assert_eq!(
      list_files_recursive(&root, "").unwrap(),
      vec!["events/orders.jsonl".to_string()]
    );
    rename(&root, "events/orders.jsonl", "events/old.jsonl").unwrap();
    assert!(!exists(&root, "events/orders.jsonl").unwrap());
    assert!(exists(&root, "events/old.jsonl").unwrap());
    remove_dir_all(&root, "events").unwrap();
    assert!(!exists(&root, "events/old.jsonl").unwrap());
    let _ = std::fs::remove_dir_all(&root);
  }

}
