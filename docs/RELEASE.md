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

## Actualizaciones (desktop)

- Endpoint: `https://github.com/wulflo/store-inventory/releases/latest/download/latest.json`.
- `bundle.createUpdaterArtifacts: true` hace que `tauri build` firme directamente
  el AppImage de Linux y los instaladores `.exe`/`.msi` de Windows, generando sus
  `.sig`. El script también acepta los formatos v1 (`.AppImage.tar.gz`,
  `.nsis.zip`, `.msi.zip`) por compatibilidad.
- `scripts/latest-json.mjs` arma el `latest.json` real con versión, fecha,
  plataforma, URL y firma. El workflow `release.yml` lo publica junto al release.
- El updater **solo funciona en Windows/Linux/macOS**. En Android se actualiza
  reinstalando el APK o desde la tienda; la UI lo informa.
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

# 2. Push de rama y tag
git push origin feat/material-p2p-release --tags

# 3. GitHub Actions: verify → builds → publish
```

Antes del tag, `node scripts/version.mjs check` debe pasar. El `versionCode`
Android se calcula como `major*1_000_000 + minor*1_000 + patch` y debe ser
monotónico.

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
