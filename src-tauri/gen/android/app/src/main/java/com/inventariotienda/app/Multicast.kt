package com.inventariotienda.app

import android.content.Context
import android.net.wifi.WifiManager

/**
 * Mantiene vivo el multicast Wi-Fi mientras la app busca dispositivos en la
 * LAN. Sin este lock Android filtra los paquetes multicast y el
 * descubrimiento automático no recibe anuncios.
 */
object Multicast {
  private var lock: WifiManager.MulticastLock? = null

  @JvmStatic
  fun acquire(context: Context): Boolean {
    return try {
      val current = lock
      if (current != null && current.isHeld) {
        return true
      }
      val wifi = context.applicationContext
        .getSystemService(Context.WIFI_SERVICE) as WifiManager
      val created = wifi.createMulticastLock("inventario-tienda-discovery")
      created.setReferenceCounted(false)
      created.acquire()
      lock = created
      true
    } catch (_: Exception) {
      false
    }
  }

  @JvmStatic
  fun release() {
    try {
      val current = lock
      if (current != null && current.isHeld) {
        current.release()
      }
    } catch (_: Exception) {
      // best-effort
    } finally {
      lock = null
    }
  }
}
