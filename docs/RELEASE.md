# Release y firma — Inventario Tienda

Documento operativo. **No contiene secretos**: las claves viven fuera del repo y
en el Environment `release` de GitHub.

## Identificador

- `identifier` (Tauri) y `applicationId` (Android): `com.inventariotienda.app`.
- Es un reverse-DNS válido: `app` no es palabra reservada de Java/Kotlin.
- Terminar en `.app` **no** genera incompatibilidad: el identificador no es un
  nombre de archivo y no choca con la extensión `.app` de macOS.
- **No cambiar después del primer release Android**: rompe la continuidad de
  actualizaciones (el sistema trata otra app). Si se quiere otro prefijo, hacerlo
  antes de publicar.

## Estado actual (dry-run del 2026-10-27)

- Run [`40484612737`](https://github.com/wulflo/store-inventory/actions/runs/40484612737)
  en `main`: `verify`, `build-linux`, `build-windows`, `build-android` y `publish`
  en verde.
- Draft `v1.0.0` (`isDraft: true`), **sin tag público**. URL:
  `https://github.com/wulflo/store-inventory/releases/tag/untagged-6b35539ab9ef803899f0`.
- El draft tiene 10 assets; el endpoint `releases/latest/download/latest.json`
  todavía no existe para el updater.

| Asset | Bytes | Firma |
|---|---:|---|
| `app-universal-release.apk` | 39.923.555 | APK release, 4 ABIs |
| `app-universal-release.aab` | 14.599.467 | AAB release |
| `Inventario.Tienda_1.0.0_amd64.AppImage` | 83.683.832 | `.sig` 452 B |
| `Inventario.Tienda_1.0.0_amd64.deb` | 5.231.942 | — |
| `Inventario.Tienda_1.0.0_x64-setup.exe` | 3.622.879 | `.sig` 448 B |
| `Inventario.Tienda_1.0.0_x64_en-US.msi` | 5.488.640 | `.sig` 448 B |
| `latest.json` | 1.373 | firmas Linux/Windows |

Verificado sobre los assets descargados: el APK contiene `arm64-v8a`,
`armeabi-v7a`, `x86` y `x86_64`; APK y AAB usan el certificado release
`CN=Inventario Tienda` (SHA-256 `9fccd9d1…fd492a`). Las firmas de `latest.json`
coinciden con los `.sig` y las URLs usan los nombres reales con puntos.

## Secretos del Environment `release`

Se cargan con `gh secret set NOMBRE --env release` leyendo desde archivo, nunca
pegando valores en el chat ni en logs.

| Secreto | Origen | Respaldo |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri signer generate` | `~/.config/inventario-tienda/secrets/updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contraseña elegida al generar | `~/.config/inventario-tienda/secrets/updater.password` |
| `ANDROID_KEYSTORE_BASE64` | keystore `.jks` en base64 | `~/.config/inventario-tienda/secrets/android-release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | contraseña del keystore | `~/.config/inventario-tienda/secrets/android-keystore.password` |
| `ANDROID_KEY_ALIAS` | alias (actual: `inventario`) | `~/.config/inventario-tienda/secrets/android-alias.txt` |
| `ANDROID_KEY_PASSWORD` | contraseña de la clave | `~/.config/inventario-tienda/secrets/android-key.password` |

Verificar nombres cargados sin ver valores:

```bash
gh secret list --env release -R wulflo/store-inventory
```

La carpeta local de secretos debe estar con permisos `700` y los archivos `600`.

**Importante:** todos los jobs que usan estos secretos deben declarar
`environment: release` en `release.yml` (Linux, Windows, Android y publish). Si
un job no lo declara, GitHub entrega los secretos vacíos y la firma falla con
`Missing comment in secret key`.

## Actualizaciones (desktop y Android)

- Endpoint: `https://github.com/wulflo/store-inventory/releases/latest/download/latest.json`.
- `bundle.createUpdaterArtifacts: true` hace que `tauri build` firme directamente
  el AppImage de Linux y los instaladores `.exe`/`.msi` de Windows, generando sus
  `.sig`. El script también acepta los formatos v1 (`.AppImage.tar.gz`,
  `.nsis.zip`, `.msi.zip`) por compatibilidad.
- `scripts/latest-json.mjs` arma el `latest.json` real con versión, fecha,
  plataforma, URL y firma en **base64** (compatible con Tauri). Soporta
  `android-aarch64`, `android-armv7`, `android-x86_64`, `android-i686` y
  `android-universal`. El workflow firma el APK universal con `tauri signer sign`
  y genera `app-universal-release.apk.sig`.
- El updater de escritorio usa `tauri-plugin-updater`. En Android la app descarga
  el APK, verifica la firma minisign con la clave pública configurada, lo guarda
  en la carpeta **Descargas** vía MediaStore (Android 10+) o almacenamiento
  legacy con permiso `WRITE_EXTERNAL_STORAGE` (Android 9) y pide instalarlo.
- GitHub reemplaza los espacios del nombre del asset por puntos; el script
  normaliza la URL para que el updater no reciba un 404.
- Un release en **draft** no alimenta `releases/latest`: el updater solo ve
  versiones publicadas.

## Firma Android

El workflow decodifica `ANDROID_KEYSTORE_BASE64` a `$RUNNER_TEMP/keystore.jks`
y crea `src-tauri/gen/android/keystore.properties` (ignorado por git):

```properties
storePassword=<ANDROID_KEYSTORE_PASSWORD>
keyPassword=<ANDROID_KEY_PASSWORD>
keyAlias=<ANDROID_KEY_ALIAS>
storeFile=/ruta/al/keystore.jks
```

`app/build.gradle.kts` lee ese archivo y configura `signingConfigs.release`;
si no existe, el build release queda sin firmar y el workflow falla al verificar
el APK. En este proyecto las contraseñas de keystore y clave pueden coincidir,
pero se cargan como secretos separados.

## Flujo de release

```bash
# 1. Versión + tag (actualiza package.json, Cargo.toml, tauri.conf.json y versionCode)
npm run release -- set 1.1.0

# 2. Push de main y tag
git push origin main --tags

# 3. GitHub Actions: verify → builds → publish
```

Antes del tag, `node scripts/version.mjs check` debe pasar. El `versionCode`
Android se calcula como `major*1_000_000 + minor*1_000 + patch` y debe ser
monotónico.

Para probar sin publicar:

```bash
gh workflow run release.yml --ref main -f dry-run=true
```

El `workflow_dispatch` solo se registra desde la rama default `main`. El dry-run
crea un draft y no crea tag público; para que el updater lo vea hay que publicar
el draft desde GitHub. Recién entonces existe
`releases/latest/download/latest.json`.

## Windows

Los instaladores MSI/NSIS se publican **sin firma Authenticode** (no hay
certificado). Windows SmartScreen puede mostrar una advertencia. La firma del
updater (`.sig`) es independiente y sí está configurada.

## Respaldo

Guardar copia offline de:

1. `android-release.jks` + contraseñas + alias.
2. `updater.key` + contraseña.

Si se pierde la keystore no se puede actualizar una app Android ya instalada.
Si se pierde la clave del updater, las instalaciones viejas rechazan las
actualizaciones nuevas.
