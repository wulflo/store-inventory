use jni::objects::{JByteArray, JClass, JObject, JString, JValue};
use jni::JavaVM;

/* ------------------------------------------------------------------ */
/* Puente JNI: guardar el APK en la carpeta pública Descargas         */
/* ------------------------------------------------------------------ */

/**
 * Llama a `Downloads.save(context, fileName, mimeType, bytes)` de Kotlin.
 *
 * MediaStore (Android 10+) no requiere permisos de almacenamiento. En
 * Android 9 el helper usa el directorio público legacy y el manifiesto
 * declara WRITE_EXTERNAL_STORAGE con maxSdkVersion=28.
 */
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
    return Err("Android rechazó la escritura en Descargas (¿permiso denegado?).".into());
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
