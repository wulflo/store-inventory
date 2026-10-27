# Revisión de seguridad real - Protocolo P2P Sync (mTLS + pinning)

**Fecha:** 2026-10-27  
**Auditor:** Análisis estático del código fuente  
**Estado:** Revisado con base en implementación real

## Resumen ejecutivo

El protocolo implementa una arquitectura **LAN-only** con múltiples capas defensivas. Tras revisar el código fuente completo, se identifican controles sólidos pero también algunos hallazgos que requieren atención.

## 1. Exposición de puertos y red

| Componente | Puerto | Bind | Estado | Comentario |
|---|---|---|---|---|
| Servidor de sync | `SYNC_PORT` (14242) | `0.0.0.0` | **ACEPTABLE CON RESTRICCIONES** | Se bindea a todas las interfaces, pero **filtra por IP LAN** en `accept()` y rechaza conexiones no-LAN. Ver `server.rs:51,67-69` |
| Servidor de pairing | `PAIRING_PORT` (14243) | `0.0.0.0` | **RIESGO BAJO** | Similar, pero para emparejamiento temporal con SAS. Solo acepta tras validación. Ver `server.rs:350` |
| Descubrimiento multicast | UDP 5353 mDNS estilo | 224.0.0.251 / ff02::fb | **RESTRINGIDO** | Valida origen LAN. Ver `discovery.rs` y `net.rs` |

**Hallazgo:** Bindear a `0.0.0.0` es necesario para aceptar conexiones LAN en todas las interfaces (WiFi, Ethernet). El filtrado posterior por IP es correcto, pero **un escáner externo no podría alcanzar si no hay ruta**. Sin embargo, si el equipo está expuesto por algún tunel/VPN mal configurado, el filtro IP es la única barrera.

**Recomendación:** Considerar bindear solo a interfaces LAN específicas en lugar de `0.0.0.0`.

## 2. Autenticación y cifrado

| Control | Estado | Evidencia |
|---|---|---|
| TLS 1.3 | ✅ OK | `rustls` con configuración por defecto TLS 1.3 |
| mTLS mutuo | ✅ OK | `server_config` requiere certificado cliente, `client_config` configura cliente con certificado propio |
| Certificados autofirmados | ✅ OK | Generados con `rcgen` (Ed25519) |
| Pinning por fingerprint | ✅ OK | Cliente verifica certificado del servidor contra `peers.json`. Servidor valida cliente contra peers confiables. Ver `client.rs:103-145`, `server.rs:163-240` |
| Ed25519 | ✅ OK | Usado para identidad y certificados |

**Hallazgo:** El pinning es estricto. Si el certificado cambia (reinstalación, regeneración), la conexión se rechaza con mensaje claro. Esto previene MITM efectivo.

## 3. Emparejamiento y autorización

| Control | Estado | Evidencia |
|---|---|---|
| SAS manual | ✅ OK | Código de 6 dígitos derivado de fingerprints + transcript, verificación humana obligatoria |
| Solo LAN para pairing | ✅ OK | `pairing_listen_start` valida contexto LAN |
| Peer confiable solo tras confirmación | ✅ OK | Se añade a `peers.json` con `trusted=true` solo tras `sync_pair_confirm` |
| Fingerprint verificado | ✅ OK | Cliente y servidor verifican identidad contra certificado recibido |
| Revocación | ✅ OK | `sync_remove_peer` permite eliminar confianza |

**Hallazgo:** El SAS es determinista y orden-independiente (`canonical_sas`). Esto es correcto para prevenir confusión de orden.

## 4. Validación de red y alcance

| Control | Estado | Evidencia |
|---|---|---|
| Rechazo IP públicas | ✅ OK | `validate_peer_addr` rechaza todo lo que no sea LAN. Tests pasan. |
| Solo RFC1918/link-local/ULA/loopback | ✅ OK | `is_lan_ipv4`/`is_lan_ipv6` estrictos |
| Rechazo nombres DNS | ✅ OK | No se resuelven hostnames, solo IPs parseadas directamente |
| Filtrado en servidor | ✅ OK | `server.rs:67-69` rechaza conexiones desde IP no-LAN antes de TLS |
| Filtrado multicast | ✅ OK | Solo 224.0.0.0/24 y ff02::/16 |
| Sin conexiones salientes a Internet | ✅ OK | No hay código que conecte a dominios públicos. Solo IPs validadas |

**Hallazgo crítico corregido:** Anteriormente había un fallback con `8.8.8.8:80` en `local_lan_addresses()` para descubrir IP local. **Esto NO genera tráfico saliente real** (solo `connect()` UDP sin enviar datos), pero **es conceptualmente cuestionable**. Ver `net.rs:133-146`. Aunque no envía paquetes, hace una conexión UDP que podría ser visible en algunos logs. **Recomendado eliminar** y confiar solo en `if_addrs`.

## 5. Protocolo y transmisión de datos

| Control | Estado | Evidencia |
|---|---|---|
| Sincronización por delta (IDs) | ✅ OK | Implementado recientemente. Solo se envían eventos faltantes. Ver `client.rs:165-290`, `server.rs:194-380` |
| Dedupe por ID | ✅ OK | `append_missing` verifica existencia por ID antes de append |
| Append-only | ✅ OK | Nunca se sobreescribe, solo se añade |
| Validación de eventos entrantes | ✅ OK | `validate_incoming_event` verifica ID, dominio, HLC futuro |
| Límites de frame/batch | ✅ OK | `MAX_FRAME_SIZE=1MB`, `MAX_BATCH_EVENTS=500`, `MAX_BATCH_BYTES=512KB` |
| HLC con tolerancia | ✅ OK | Rechaza eventos con HLC > now + 24h |
| Ordenamiento por HLC | ✅ OK | Batches ordenados por HLC |
| Timeout de conexión/sync | ✅ OK | `CONNECT_TIMEOUT=10s`, `SYNC_TIMEOUT=300s` |

**Hallazgo:** La validación de dominio en eventos es correcta - se verifica que `ev.domain() == payload.domain`.

## 6. Almacenamiento y secretos

| Control | Estado | Evidencia |
|---|---|---|
| Clave privada local | ✅ OK | Almacenada en `app_data_dir/identity/` con permisos del SO |
| Certificados no compartidos | ✅ OK | Solo se intercambian durante pairing (efímero) |
| peers.json con trust | ✅ OK | Solo peers confiables aceptados |
| Sin logs sensibles | ✅ OK | Logs no imprimen claves/certificados completos |
| device_id persistente | ✅ OK | Generado una vez, persistido |

**Hallazgo:** No se observa cifrado en reposo de `peers.json` o `identity/`, pero **están en el directorio privado de la app** del SO. Esto es aceptable para el threat model (dispositivo comprometido ya tiene acceso).

## 7. Posibles vectores de ataque

| Vector | Probabilidad | Impacto | Estado | Mitigación |
|---|---|---|---|---|
| MITM en LAN | Baja | Alto | **MITIGADO** | mTLS + pinning + SAS. Certificado incorrecto rechaza conexión |
| Spoofing de peer | Baja | Alto | **MITIGADO** | Verificación fingerprint vs certificado + vs peers.json |
| Replay de eventos antiguos | Baja | Medio | **MITIGADO** | IDs únicos UUIDv7 + dedupe. HLC ayuda pero no es único |
| Eventos malformados | Media | Medio | **MITIGADO** | Validación JSON, límites de tamaño, validación de campos |
| DoS por muchos frames | Media | Bajo | **MITIGADO** | Timeouts, límites de batch/frame |
| Conexión desde IP falsa | Muy baja | Alto | **MITIGADO** | Filtrado por IP real de TCP socket |
| Rogue pairing server | Baja | Alto | **MITIGADO** | Solo funciona en LAN, SAS manual requerido |
| Memory exhaustion | Media | Bajo | **MITIGADO** | Límites estrictos |

## 8. Hallazgos a corregir

### CRÍTICO: Fallback UDP a 8.8.8.8
**Archivo:** `src-tauri/src/sync/net.rs:133-146`  
**Problema:** Aunque no envía datos, hace `connect()` UDP a IP pública. Esto:
- Genera tráfico de red visible
- Podría activar firewalls/alertas
- Es innecesario

**Solución:** Eliminar completamente ese fallback. Si `if_addrs` no encuentra IPs LAN, devolver lista vacía. El usuario puede ingresar manualmente.

### MEDIO: Bind a 0.0.0.0
**Archivo:** `src-tauri/src/sync/server.rs:51, 350`  
**Problema:** Escucha en todas las interfaces. Aunque se filtra, es más superficie.  
**Solución:** En lo posible bindear solo a interfaces LAN encontradas, o mantener filtro actual (aceptable).

### MEDIO: Sin rate limiting
**Problema:** No hay límite de intentos de conexión/handshake.  
**Solución:** Añadir rate limiting básico por IP (token bucket) en servidor.

### BAJO: Sin logs de seguridad
**Problema:** Rechazos de seguridad no se loguean estructuradamente.  
**Solución:** Añadir logging para auditoría (IP rechazada, pinning fallido, etc.)

## 9. Recomendaciones inmediatas

1. **Eliminar fallback 8.8.8.8** - Innecesario y cuestionable
2. **Añadir rate limiting** - Prevenir brute force/DoS
3. **Mejorar logging de seguridad** - Para debugging/auditoría
4. **Considerar bind por interfaz** - Reducir superficie
5. **Documentar threat model** - Clarificar límites (dispositivo comprometido está fuera de scope)

## Conclusión

El protocolo es **sólidamente seguro para su threat model (LAN-only, dispositivos confiables)**. Los controles principales (mTLS + pinning + SAS + validación LAN) están correctamente implementados. Los hallazgos identificados son mayoritariamente mejoras, no vulnerabilidades explotables con el diseño actual.

**Calificación:** BUENO - Listo para uso en red local confiable con las recomendaciones aplicadas.

## Actualización FASE 2 (2026-10-27)

Cambios implementados tras la revisión:

- **Rate limiting básico por IP** en `server.rs`: máximo 20 conexiones por minuto por IP. Previene DoS/brute force.
- **Logging estructurado de rechazos**: IPs no LAN, pinning fallido, rate-limit excedido se loguean con prefijo `[sync]`.
- **Fallback UDP a 8.8.8.8 eliminado** en `local_lan_addresses()` (verificado: ya no existe en código).
- **Puertos confirmados**: sync `14242`, emparejamiento `14243`.
- **No existe `pair.rs`**: solo `pairing.rs`.
- **Sincronización por delta (IDs)**: implementada en `client.rs`/`server.rs`. Solo viajan eventos faltantes.
