use jni::objects::{JByteArray, JClass, JObject, JString, JValue};
use jni::JavaVM;

/* ------------------------------------------------------------------ */
/* Puente JNI: guardar el APK en la carpeta pública Descargas         */
/* ------------------------------------------------------------------ */

/// Guarda bytes en Descargas y devuelve la ruta guardada.
/// En Android 10+ usa MediaStore; en Android 9 escribe directo con permiso.
pub fn save_to_downloads(file_name: &str, mime: &str, bytes: &[u8]) -> Result<String, String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
    .map_err(|e| format!("No se pudo obtener la JavaVM: {e}"))?;
  let mut env = vm
    .attach_current_thread()
    .map_err(|e| format!("No se pudo adjuntar el hilo a JNI: {e}"))?;

  let context = unsafe { JObject::from_raw(ctx.context().cast()) };
  let loader = env
    .call_method(
      &context,
      "getClassLoader",
      "()Ljava/lang/ClassLoader;",
      &[],
    )
    .map_err(|e| format!("No se pudo obtener el ClassLoader: {e}"))?
    .l()
    .map_err(|e| format!("ClassLoader inválido: {e}"))?;
  let class_name = env
    .new_string("com.inventariotienda.app.Downloads")
    .map_err(|e| format!("No se pudo crear el nombre de clase: {e}"))?;
  let class_obj = env
    .call_method(
      &loader,
      "loadClass",
      "(Ljava/lang/String;)Ljava/lang/Class;",
      &[JValue::Object(&class_name)],
    )
    .map_err(|e| format!("No se pudo cargar Downloads.kt: {e}"))?
    .l()
    .map_err(|e| format!("Clase Downloads inválida: {e}"))?;
  let class = JClass::from(class_obj);

  let file_name = env
    .new_string(file_name)
    .map_err(|e| format!("Nombre de archivo inválido: {e}"))?;
  let mime = env
    .new_string(mime)
    .map_err(|e| format!("MIME inválido: {e}"))?;
  let bytes: JByteArray = env
    .byte_array_from_slice(bytes)
    .map_err(|e| format!("No se pudo copiar el APK a Java: {e}"))?;
  let bytes_obj: &JObject = bytes.as_ref();

  let result = env
    .call_static_method(
      &class,
      "save",
      "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;[B)Ljava/lang/String;",
      &[
        JValue::Object(&context),
        JValue::Object(&file_name),
        JValue::Object(&mime),
        JValue::Object(bytes_obj),
      ],
    )
    .map_err(|e| format!("No se pudo guardar el APK en Descargas: {e}"))?;

  if env.exception_check().unwrap_or(false) {
    let _ = env.exception_describe();
    let _ = env.exception_clear();
    return Err("Android rechazó la escritura en Descargas (¿permiso denegado o sin espacio?).".into());
  }

  let result = result
    .l()
    .map_err(|e| format!("Respuesta inválida de Descargas: {e}"))?;
  let result = JString::from(result);
  let path: String = env
    .get_string(&result)
    .map_err(|e| format!("No se pudo leer la ruta guardada: {e}"))?
    .into();
  Ok(path)
}

/// Abre el APK guardado usando FileProvider para lanzar el instalador.
pub fn install_apk(file_name: &str) -> Result<(), String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { JavaVM::from_raw(ctx.vm().cast()) }
    .map_err(|e| format!("No se pudo obtener la JavaVM: {e}"))?;
  let mut env = vm
    .attach_current_thread()
    .map_err(|e| format!("No se pudo adjuntar el hilo a JNI: {e}"))?;

  let context = unsafe { JObject::from_raw(ctx.context().cast()) };
  let loader = env
    .call_method(
      &context,
      "getClassLoader",
      "()Ljava/lang/ClassLoader;",
      &[],
    )
    .map_err(|e| format!("No se pudo obtener el ClassLoader: {e}"))?
    .l()
    .map_err(|e| format!("ClassLoader inválido: {e}"))?;
  let class_name = env
    .new_string("com.inventariotienda.app.Downloads")
    .map_err(|e| format!("No se pudo crear el nombre de clase: {e}"))?;
  let class_obj = env
    .call_method(
      &loader,
      "loadClass",
      "(Ljava/lang/String;)Ljava/lang/Class;",
      &[JValue::Object(&class_name)],
    )
    .map_err(|e| format!("No se pudo cargar Downloads.kt: {e}"))?
    .l()
    .map_err(|e| format!("Clase Downloads inválida: {e}"))?;
  let class = JClass::from(class_obj);

  let file_name = env
    .new_string(file_name)
    .map_err(|e| format!("Nombre de archivo inválido: {e}"))?;

  let result = env
    .call_static_method(
      &class,
      "install",
      "(Landroid/content/Context;Ljava/lang/String;)V",
      &[JValue::Object(&context), JValue::Object(&file_name)],
    )
    .map_err(|e| format!("No se pudo lanzar el instalador: {e}"))?;

  if env.exception_check().unwrap_or(false) {
    let _ = env.exception_describe();
    let _ = env.exception_clear();
    return Err("Android rechazó lanzar el instalador (revisá permisos de instalación).".into());
  }
  let _ = result;
  Ok(())
}

/* ------------------------------------------------------------------ */
/* Bóveda externa vía SAF (Android)                                  */
/* ------------------------------------------------------------------ */

fn call_vault_static(env: &mut jni::JNIEnv, ctx: &jni::objects::JObject, method: &str, sig: &str, args: &[jni::objects::JValue]) -> Result<jni::objects::JValue, String> {
  let loader = env
    .call_method(ctx, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])
    .map_err(|e| format!("No se pudo obtener ClassLoader: {e}"))?
    .l()
    .map_err(|e| format!("ClassLoader inválido: {e}"))?;
  let class_name = env
    .new_string("com.inventariotienda.app.Vault")
    .map_err(|e| format!("No se pudo crear nombre de clase: {e}"))?;
  let class_obj = env
    .call_method(&loader, "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", &[jni::objects::JValue::Object(&class_name)])
    .map_err(|e| format!("No se pudo cargar Vault: {e}"))?
    .l()
    .map_err(|e| format!("Clase Vault inválida: {e}"))?;
  let class = jni::objects::JClass::from(class_obj);
  env
    .call_static_method(&class, method, sig, args)
    .map_err(|e| format!("Error llamando Vault.{method}: {e}"))
}

pub fn vault_is_accessible(uri: &str) -> bool {
  let ctx = ndk_context::android_context();
  let vm = match unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } {
    Ok(v) => v,
    Err(_) => return false,
  };
  let mut env = match vm.attach_current_thread() {
    Ok(e) => e,
    Err(_) => return false,
  };
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let uri_j = match env.new_string(uri) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let result = call_vault_static(
    &mut env,
    &context,
    "isAccessible",
    "(Landroid/content/Context;Ljava/lang/String;)Z",
    &[jni::objects::JValue::Object(&context), jni::objects::JValue::Object(&uri_j)],
  );
  match result {
    Ok(v) => v.z().unwrap_or(false),
    Err(_) => false,
  }
}

pub fn vault_create_dir(parent_uri: &str, name: &str) -> Result<String, String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
    .map_err(|e| format!("No se pudo obtener JavaVM: {e}"))?;
  let mut env = vm.attach_current_thread()
    .map_err(|e| format!("No se pudo adjuntar hilo: {e}"))?;
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let parent_j = env.new_string(parent_uri).map_err(|e| format!("URI inválido: {e}"))?;
  let name_j = env.new_string(name).map_err(|e| format!("Nombre inválido: {e}"))?;
  let result = call_vault_static(
    &mut env,
    &context,
    "createDir",
    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
    &[jni::objects::JValue::Object(&context), jni::objects::JValue::Object(&parent_j), jni::objects::JValue::Object(&name_j)],
  )?;
  if env.exception_check().unwrap_or(false) {
    let _ = env.exception_clear();
    return Err("Android rechazó crear directorio en la bóveda.".into());
  }
  let result = result.l().map_err(|e| format!("Respuesta inválida: {e}"))?;
  if result.is_null() {
    return Err("No se pudo crear el directorio en la bóveda.".into());
  }
  let s = jni::objects::JString::from(result);
  let path: String = env.get_string(&s).map_err(|e| format!("No se pudo leer URI: {e}"))?.into();
  Ok(path)
}

pub fn vault_write_file(parent_uri: &str, file_name: &str, bytes: &[u8]) -> Result<(), String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
    .map_err(|e| format!("No se pudo obtener JavaVM: {e}"))?;
  let mut env = vm.attach_current_thread()
    .map_err(|e| format!("No se pudo adjuntar hilo: {e}"))?;
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let parent_j = env.new_string(parent_uri).map_err(|e| format!("URI inválido: {e}"))?;
  let file_j = env.new_string(file_name).map_err(|e| format!("Nombre inválido: {e}"))?;
  let bytes_arr = env.byte_array_from_slice(bytes).map_err(|e| format!("No se pudo copiar bytes: {e}"))?;
  let bytes_obj: &jni::objects::JObject = bytes_arr.as_ref();
  let result = call_vault_static(
    &mut env,
    &context,
    "writeFile",
    "(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;[B)Z",
    &[jni::objects::JValue::Object(&context), jni::objects::JValue::Object(&parent_j), jni::objects::JValue::Object(&file_j), jni::objects::JValue::Object(bytes_obj)],
  )?;
  if env.exception_check().unwrap_or(false) {
    let _ = env.exception_clear();
    return Err("Android rechazó escribir en la bóveda.".into());
  }
  let ok = result.z().unwrap_or(false);
  if !ok {
    return Err("No se pudo escribir el archivo en la bóveda SAF.".into());
  }
  Ok(())
}

/* ------------------------------------------------------------------ */
/* Estado de batería / ahorro (Android)                              */
/* ------------------------------------------------------------------ */

pub fn battery_info() -> (bool, i32, bool) {
  // (power_save_mode, battery_level, is_charging)
  let ctx = ndk_context::android_context();
  let vm = match unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } { Ok(v) => v, Err(_) => return (false, 100, true) };
  let mut env = match vm.attach_current_thread() { Ok(e) => e, Err(_) => return (false, 100, true) };
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };

  // PowerManager.isPowerSaveMode
  let pm_str = match env.new_string("power") { Ok(s) => s, Err(_) => return (false, 100, true) };
  let pm = env.call_method(&context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[jni::objects::JValue::Object(&pm_str)]);
  let pm = match pm { Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()), Err(_) => jni::objects::JObject::null() };
  let power_save = if !pm.is_null() {
    env.call_method(&pm, "isPowerSaveMode", "()Z", &[]).ok().and_then(|v| v.z().ok()).unwrap_or(false)
  } else {
    false
  };

  // BatteryManager
  let bm_str = match env.new_string("batterymanager") { Ok(s) => s, Err(_) => return (power_save, 100, true) };
  let bm = env.call_method(&context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", &[jni::objects::JValue::Object(&bm_str)]);
  let bm = match bm { Ok(v) => v.l().unwrap_or(jni::objects::JObject::null()), Err(_) => jni::objects::JObject::null() };
  let level = if !bm.is_null() {
    env.call_method(&bm, "getIntProperty", "(I)I", &[jni::objects::JValue::Int(4)]).ok().and_then(|v| v.i().ok()).unwrap_or(100)
  } else {
    100
  };
  let charging = if !bm.is_null() {
    env.call_method(&bm, "isCharging", "()Z", &[]).ok().and_then(|v| v.z().ok()).unwrap_or(true)
  } else {
    true
  };
  (power_save, level, charging)
}

pub fn vault_store_uri(uri: &str) {
  let ctx = ndk_context::android_context();
  let vm = match unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } { Ok(v) => v, Err(_) => return };
  let mut env = match vm.attach_current_thread() { Ok(e) => e, Err(_) => return };
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let uri_j = match env.new_string(uri) { Ok(s) => s, Err(_) => return };
  let _ = call_vault_static(&mut env, &context, "storeUri", "(Landroid/content/Context;Ljava/lang/String;)V",
    &[jni::objects::JValue::Object(&context), jni::objects::JValue::Object(&uri_j)]);
}

pub fn vault_get_stored_uri() -> Option<String> {
  let ctx = ndk_context::android_context();
  let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }.ok()?;
  let mut env = vm.attach_current_thread().ok()?;
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let result = call_vault_static(&mut env, &context, "getStoredUri", "(Landroid/content/Context;)Ljava/lang/String;",
    &[jni::objects::JValue::Object(&context)]).ok()?;
  let result = result.l().ok()?;
  if result.is_null() { return None; }
  let s = jni::objects::JString::from(result);
  env.get_string(&s).ok().map(|x| x.into())
}

pub fn vault_clear_uri() {
  let ctx = ndk_context::android_context();
  let vm = match unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } { Ok(v) => v, Err(_) => return };
  let mut env = match vm.attach_current_thread() { Ok(e) => e, Err(_) => return };
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let _ = call_vault_static(&mut env, &context, "clearUri", "(Landroid/content/Context;)V",
    &[jni::objects::JValue::Object(&context)]);
}

pub fn vault_take_permission(uri: &str) -> bool {
  let ctx = ndk_context::android_context();
  let vm = match unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) } { Ok(v) => v, Err(_) => return false };
  let mut env = match vm.attach_current_thread() { Ok(e) => e, Err(_) => return false };
  let context = unsafe { jni::objects::JObject::from_raw(ctx.context().cast()) };
  let uri_j = match env.new_string(uri) { Ok(s) => s, Err(_) => return false };
  let result = call_vault_static(&mut env, &context, "takePersistablePermission", "(Landroid/content/Context;Landroid/net/Uri;)Z",
    &[jni::objects::JValue::Object(&context), jni::objects::JValue::Object(&uri_j)]);
  result.ok().and_then(|v| v.z().ok()).unwrap_or(false)
}
