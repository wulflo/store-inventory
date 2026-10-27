package com.inventariotienda.app

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  companion object {
    /** Referencia viva para pedir permisos desde el puente JNI del actualizador. */
    @Volatile
    var instance: MainActivity? = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    instance = this
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Android 15+ dibuja edge-to-edge. El WebView no expone la altura de la
    // barra de estado por CSS, así que aplicamos el inset nativo al contenido.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(content)
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray,
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    Downloads.onPermissionResult(requestCode)
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    super.onDestroy()
  }
}
