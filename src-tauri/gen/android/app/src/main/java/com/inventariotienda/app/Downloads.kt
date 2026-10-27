package com.inventariotienda.app

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.core.content.FileProvider
import androidx.core.app.ActivityCompat
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Guarda el APK descargado por el actualizador en la carpeta pública Descargas.
 *
 * Android 10+ usa MediaStore (sin permisos de almacenamiento). Android 9
 * escribe directamente en el directorio público legacy y requiere el permiso
 * WRITE_EXTERNAL_STORAGE declarado en el manifiesto.
 */
object Downloads {
    private const val LEGACY_PERMISSION = android.Manifest.permission.WRITE_EXTERNAL_STORAGE
    private const val REQUEST_LEGACY_PERMISSION = 4217

    @Volatile
    private var permissionLatch: CountDownLatch? = null

    @JvmStatic
    fun save(context: Context, fileName: String, mimeType: String, bytes: ByteArray): String {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            saveWithMediaStore(context, fileName, mimeType, bytes)
        } else {
            saveLegacy(context, fileName, bytes)
        }
    }

    /** Lo llama MainActivity cuando el usuario responde al diálogo de permisos. */
    @JvmStatic
    fun onPermissionResult(requestCode: Int) {
        if (requestCode == REQUEST_LEGACY_PERMISSION) {
            permissionLatch?.countDown()
            permissionLatch = null
        }
    }

    /**
     * Android 9 exige permiso de almacenamiento en tiempo de ejecución. La
     * descarga corre en un hilo del runtime Rust, así que podemos mostrar el
     * diálogo en el hilo de UI y esperar la respuesta sin bloquear la pantalla.
     */
    private fun requestLegacyPermission(context: Context) {
        if (context.checkSelfPermission(LEGACY_PERMISSION) == PackageManager.PERMISSION_GRANTED) {
            return
        }
        val activity = MainActivity.instance
            ?: throw SecurityException(
                "No se pudo abrir el diálogo de permisos. Volvé a intentar desde la pantalla de actualizaciones.",
            )
        val latch = CountDownLatch(1)
        permissionLatch = latch
        activity.runOnUiThread {
            ActivityCompat.requestPermissions(
                activity,
                arrayOf(LEGACY_PERMISSION),
                REQUEST_LEGACY_PERMISSION,
            )
        }
        val answered = latch.await(60, TimeUnit.SECONDS)
        permissionLatch = null
        if (!answered) {
            throw SecurityException("El pedido de permiso de almacenamiento expiró.")
        }
        if (context.checkSelfPermission(LEGACY_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException(
                "Para guardar el APK en Descargas en Android 9, habilitá el permiso de almacenamiento de la app.",
            )
        }
    }

    private fun saveWithMediaStore(context: Context, fileName: String, mimeType: String, bytes: ByteArray): String {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, fileName)
            put(MediaStore.Downloads.MIME_TYPE, mimeType)
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            ?: throw SecurityException("No se pudo crear el archivo en Descargas.")
        try {
            resolver.openOutputStream(uri)?.use { out ->
                out.write(bytes)
                out.flush()
            } ?: throw SecurityException("No se pudo escribir el APK en Descargas.")
            values.clear()
            values.put(MediaStore.Downloads.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return uri.toString()
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
    }

    private fun saveLegacy(context: Context, fileName: String, bytes: ByteArray): String {
        requestLegacyPermission(context)
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!dir.exists()) {
            dir.mkdirs()
        }
        val file = File(dir, fileName)
        FileOutputStream(file).use { out ->
            out.write(bytes)
            out.flush()
        }
        return file.absolutePath
    }

    /**
     * Lanza el instalador del APK. Para Android 7+ se usa FileProvider; en
     * versiones antiguas se usa un Uri directo (solo viable para archivos propios).
     */
    @JvmStatic
    fun install(context: Context, fileName: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            installWithMediaStore(context, fileName)
        } else {
            installLegacy(context, fileName)
        }
    }

    private fun installWithMediaStore(context: Context, fileName: String) {
        val resolver = context.contentResolver
        val query = resolver.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.Downloads._ID, MediaStore.Downloads.DISPLAY_NAME),
            "${MediaStore.Downloads.DISPLAY_NAME} = ?",
            arrayOf(fileName),
            null,
        )
        query?.use { cursor ->
            if (cursor.moveToFirst()) {
                val id = cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Downloads._ID))
                val uri = Uri.withAppendedPath(MediaStore.Downloads.EXTERNAL_CONTENT_URI, id.toString())
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
                }
                context.startActivity(intent)
                return
            }
        }
        // Si no se encuentra por nombre (poca probabilidad), avisamos al usuario.
        throw SecurityException("No se encontró el APK en Descargas para abrirlo.")
    }

    private fun installLegacy(context: Context, fileName: String) {
        val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val file = File(dir, fileName)
        if (!file.exists()) {
            throw SecurityException("No se encontró el APK en Descargas para abrirlo.")
        }
        val uri: Uri = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        } else {
            Uri.fromFile(file)
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION
        }
        // Conceder permiso de lectura al instalador
        val resInfoList = context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
        for (resolveInfo in resInfoList) {
            val packageName = resolveInfo.activityInfo.packageName
            context.grantUriPermission(packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(intent)
    }
}
