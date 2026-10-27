package com.inventariotienda.app

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import androidx.activity.result.contract.ActivityResultContracts
import androidx.documentfile.provider.DocumentFile
import java.io.OutputStream

/**
 * Bóveda externa persistente mediante Storage Access Framework (SAF).
 *
 * Permite elegir una carpeta del sistema (ACTION_OPEN_DOCUMENT_TREE), tomar
 * permiso persistente de lectura/escritura y acceder a ella sin rutas de
 * sistema. Funciona en Android 10+ (scoped storage) y sobrevive a reinicios.
 */
object Vault {
    private const val PREFS = "vault_prefs"
    private const val KEY_URI = "vault_tree_uri"

    /** Devuelve el URI persistente guardado, o null si no hay. */
    @JvmStatic
    fun getStoredUri(context: Context): String? {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getString(KEY_URI, null)
    }

    /** Guarda el URI persistente. */
    @JvmStatic
    fun storeUri(context: Context, uri: String) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().putString(KEY_URI, uri).apply()
    }

    /** Elimina el URI guardado (revocar bóveda). */
    @JvmStatic
    fun clearUri(context: Context) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs.edit().remove(KEY_URI).apply()
    }

    /** Toma permiso persistente sobre el URI (lectura + escritura). */
    @JvmStatic
    fun takePersistablePermission(context: Context, uri: Uri): Boolean {
        return try {
            val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            context.contentResolver.takePersistableUriPermission(uri, flags)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Verifica que el URI siga accesible (permiso + existencia). */
    @JvmStatic
    fun isAccessible(context: Context, uriString: String): Boolean {
        return try {
            val uri = Uri.parse(uriString)
            val flags = context.contentResolver.persistedUriPermissions
            val hasPermission = flags.any { it.uri == uri && it.isReadPermission && it.isWritePermission }
            if (!hasPermission) return false
            val doc = DocumentFile.fromTreeUri(context, uri) ?: return false
            doc.exists() && doc.isDirectory
        } catch (e: Exception) {
            false
        }
    }

    /** Crea un subdirectorio dentro del árbol SAF. Devuelve su URI como string. */
    @JvmStatic
    fun createDir(context: Context, parentUri: String, name: String): String? {
        return try {
            val parent = DocumentFile.fromTreeUri(context, Uri.parse(parentUri)) ?: return null
            val existing = parent.findFile(name)
            if (existing != null && existing.isDirectory) {
                existing.uri.toString()
            } else {
                val created = parent.createDirectory(name) ?: return null
                created.uri.toString()
            }
        } catch (e: Exception) {
            null
        }
    }

    /** Escribe bytes en un archivo dentro del árbol SAF. Devuelve true si OK. */
    @JvmStatic
    fun writeFile(context: Context, parentUri: String, fileName: String, bytes: ByteArray): Boolean {
        return try {
            val parent = DocumentFile.fromTreeUri(context, Uri.parse(parentUri)) ?: return false
            var file = parent.findFile(fileName)
            if (file == null) {
                file = parent.createFile("application/octet-stream", fileName) ?: return false
            }
            context.contentResolver.openOutputStream(file.uri, "w")?.use { out ->
                out.write(bytes)
                out.flush()
            } ?: return false
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Lista los nombres de archivos en un directorio SAF. */
    @JvmStatic
    fun listFiles(context: Context, dirUri: String): Array<String> {
        return try {
            val doc = DocumentFile.fromTreeUri(context, Uri.parse(dirUri)) ?: return emptyArray()
            doc.listFiles().mapNotNull { it.name }.toTypedArray()
        } catch (e: Exception) {
            emptyArray()
        }
    }

    /** Lee bytes de un archivo en SAF. */
    @JvmStatic
    fun readFile(context: Context, fileUri: String): ByteArray? {
        return try {
            context.contentResolver.openInputStream(Uri.parse(fileUri))?.use { it.readBytes() }
        } catch (e: Exception) {
            null
        }
    }
}
KOTLIN
echo "---"
wc -l /home/alonso/Documentos/Repositorios/inventario-tienda/src-tauri/gen/android/app/src/main/java/com/inventariotienda/app/Vault.kt