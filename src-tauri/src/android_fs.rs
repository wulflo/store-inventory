use jni::objects::{JClass, JObject, JValue};

/* ------------------------------------------------------------------ */
/* Append real sobre un documento SAF                                 */
/* ------------------------------------------------------------------ */

/// Abre un documento SAF en modo `"wa"` (write + append) y escribe `bytes`.
///
/// En Android `"w"` trunca el archivo; `"wa"` agrega sin reescribirlo. Esto
/// evita el read-modify-write que podía pisar lo que un agente de sync
/// externo acababa de dejar en la carpeta.
///
/// `uri` es el string de un `FilePath` del plugin. Si el documento fue
/// reemplazado y la URI vieja ya no existe, la llamada falla sin escribir: el
/// diario local se encarga de reparar el evento en la próxima pasada.
pub fn append_saf_file(uri: &str, bytes: &[u8]) -> Result<(), String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
    .map_err(|e| format!("No se pudo obtener JavaVM: {e}"))?;
  let mut env = vm
    .attach_current_thread()
    .map_err(|e| format!("No se pudo adjuntar hilo: {e}"))?;
  let context = unsafe { JObject::from_raw(ctx.context().cast()) };

  let result: Result<(), String> = (|| {
    let resolver = env
      .call_method(
        &context,
        "getContentResolver",
        "()Landroid/content/ContentResolver;",
        &[],
      )
      .map_err(|e| format!("No se pudo obtener ContentResolver: {e}"))?
      .l()
      .map_err(|e| format!("ContentResolver inválido: {e}"))?;

    let uri_string = env
      .new_string(uri)
      .map_err(|e| format!("URI SAF inválida: {e}"))?;
    let uri_obj = env
      .call_static_method(
        "android/net/Uri",
        "parse",
        "(Ljava/lang/String;)Landroid/net/Uri;",
        &[JValue::Object(&uri_string)],
      )
      .map_err(|e| format!("No se pudo parsear la URI SAF: {e}"))?
      .l()
      .map_err(|e| format!("URI SAF inválida: {e}"))?;
    let mode = env
      .new_string("wa")
      .map_err(|e| format!("No se pudo crear el modo de apertura: {e}"))?;

    let afd = env
      .call_method(
        &resolver,
        "openAssetFileDescriptor",
        "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;",
        &[JValue::Object(&uri_obj), JValue::Object(&mode)],
      )
      .map_err(|e| format!("No se pudo abrir el documento SAF en modo append: {e}"))?
      .l()
      .map_err(|e| format!("AssetFileDescriptor inválido: {e}"))?;

    if env.exception_check().unwrap_or(false) {
      return Err("Android rechazó abrir el documento SAF en modo append.".to_string());
    }

    let pfd = env
      .call_method(
        &afd,
        "getParcelFileDescriptor",
        "()Landroid/os/ParcelFileDescriptor;",
        &[],
      )
      .map_err(|e| format!("No se pudo obtener el descriptor SAF: {e}"))?
      .l()
      .map_err(|e| format!("ParcelFileDescriptor inválido: {e}"))?;
    let fd = env
      .call_method(&pfd, "detachFd", "()I", &[])
      .map_err(|e| format!("No se pudo separar el descriptor SAF: {e}"))?
      .i()
      .map_err(|e| format!("Descriptor SAF inválido: {e}"))?;

    use std::io::Write;
    use std::os::fd::FromRawFd;
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    file
      .write_all(bytes)
      .map_err(|e| format!("No se pudo agregar al documento SAF: {e}"))?;
    file
      .flush()
      .map_err(|e| format!("No se pudo sincronizar el documento SAF: {e}"))?;
    Ok(())
  })();

  if result.is_err() {
    // Una excepción Java pendiente contaminaría las próximas llamadas JNI en
    // este hilo. Se limpia sin ocultar el error, que ya se devuelve como texto.
    let _ = env.exception_clear();
  }
  result
}

/* ------------------------------------------------------------------ */
/* Borrado de una carpeta SAF (el plugin no expone remove_dir)        */
/* ------------------------------------------------------------------ */

/// Llama a un método estático de `com.inventariotienda.app.Vault`.
fn call_vault_static<'local>(
  env: &mut jni::JNIEnv<'local>,
  ctx: &JObject<'_>,
  method: &str,
  sig: &str,
  args: &[JValue<'_, '_>],
) -> Result<jni::objects::JValueOwned<'local>, String> {
  let loader = env
    .call_method(ctx, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
    .map_err(|e| format!("No se pudo obtener ClassLoader: {e}"))?
    .l()
    .map_err(|e| format!("ClassLoader inválido: {e}"))?;
  let class_name = env
    .new_string("com.inventariotienda.app.Vault")
    .map_err(|e| format!("No se pudo crear nombre de clase: {e}"))?;
  let class_obj = env
    .call_method(
      &loader,
      "loadClass",
      "(Ljava/lang/String;)Ljava/lang/Class;",
      &[JValue::Object(&class_name)],
    )
    .map_err(|e| format!("No se pudo cargar Vault: {e}"))?
    .l()
    .map_err(|e| format!("Clase Vault inválida: {e}"))?;
  let class = JClass::from(class_obj);
  env
    .call_static_method(&class, method, sig, args)
    .map_err(|e| format!("Error llamando Vault.{method}: {e}"))
}

/// Borra recursivamente una carpeta dentro de un árbol SAF.
///
/// `root` es el `DirPath` serializado (`{ topTreeUri, relativeTerms }`) y
/// `prefix` la ruta relativa a borrar dentro de ese árbol. `storage.rs` borra
/// primero los archivos con el plugin; este puente elimina la carpeta ya vacía
/// con `DocumentFile.delete()`.
pub fn delete_saf_dir(root: &str, prefix: &str) -> Result<(), String> {
  let prefix = prefix.trim_matches('/');
  if prefix.is_empty() {
    return Err("No se puede borrar la raíz de la bóveda.".to_string());
  }
  let value: serde_json::Value = serde_json::from_str(root)
    .map_err(|e| format!("La ruta SAF guardada está dañada: {e}"))?;
  let top_tree_uri = value
    .get("topTreeUri")
    .and_then(|v| v.as_str())
    .ok_or_else(|| "La ruta SAF no tiene topTreeUri.".to_string())?;
  let mut relative_parts: Vec<String> = value
    .get("relativeTerms")
    .and_then(|v| v.as_array())
    .map(|terms| {
      terms
        .iter()
        .filter_map(|t| t.as_str().map(str::to_string))
        .collect()
    })
    .unwrap_or_default();
  relative_parts.extend(
    prefix
      .split('/')
      .filter(|p| !p.is_empty())
      .map(str::to_string),
  );
  let relative = relative_parts.join("/");

  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
    .map_err(|e| format!("No se pudo obtener JavaVM: {e}"))?;
  let mut env = vm
    .attach_current_thread()
    .map_err(|e| format!("No se pudo adjuntar hilo: {e}"))?;
  let context = unsafe { JObject::from_raw(ctx.context().cast()) };
  let tree = env
    .new_string(top_tree_uri)
    .map_err(|e| format!("URI SAF inválida: {e}"))?;
  let relative = env
    .new_string(&relative)
    .map_err(|e| format!("Ruta SAF inválida: {e}"))?;
  let result = call_vault_static(
    &mut env,
    &context,
    "deleteDir",
    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Z",
    &[
      JValue::Object(&context),
      JValue::Object(&tree),
      JValue::Object(&relative),
    ],
  )?;
  if env.exception_check().unwrap_or(false) {
    let _ = env.exception_clear();
    return Err("Android rechazó borrar la carpeta de la bóveda.".to_string());
  }
  let _ = result.z().unwrap_or(false);
  Ok(())
}
