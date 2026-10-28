use jni::objects::{JClass, JObject, JValue};

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
