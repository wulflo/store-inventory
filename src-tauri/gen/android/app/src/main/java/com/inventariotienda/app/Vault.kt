package com.inventariotienda.app

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile

/**
 * Complemento SAF mínimo.
 *
 * La lectura/escritura de la bóveda la hace `tauri-plugin-android-fs`. Este
 * puente solo existe porque el plugin 2.x no expone `remove_dir` para un
 * `DirPath`: después de borrar los archivos con el plugin, Rust llama acá para
 * eliminar la carpeta ya vacía con `DocumentFile.delete()`.
 */
object Vault {
    @JvmStatic
    fun deleteDir(context: Context, treeUri: String, relativePath: String): Boolean {
        return try {
            var current = DocumentFile.fromTreeUri(context, Uri.parse(treeUri)) ?: return false
            for (part in relativePath.split('/').filter { it.isNotEmpty() }) {
                current = current.findFile(part) ?: return true
            }
            // Nunca borrar la raíz del árbol.
            if (current.uri == Uri.parse(treeUri)) return false
            current.delete()
        } catch (e: Exception) {
            false
        }
    }
}
