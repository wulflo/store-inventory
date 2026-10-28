#!/usr/bin/env node
/**
 * Genera el `latest.json` que consume tauri-plugin-updater a partir de los
 * artefactos y sus archivos `.sig` producidos por `tauri build`.
 *
 * Uso:
 *   node scripts/latest-json.mjs \
 *     --version 1.2.3 --tag v1.2.3 --repo owner/repo \
 *     --artifacts artifacts --out latest.json
 *
 * No usa dependencias externas. El JSON resultante tiene este formato:
 *   {
 *     "version": "1.2.3",
 *     "notes": "...",
 *     "pub_date": "2026-10-27T00:00:00.000Z",
 *     "platforms": {
 *       "linux-x86_64":   { "signature": "...", "url": "https://..." },
 *       "windows-x86_64": { "signature": "...", "url": "https://..." }
 *     }
 *   }
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Devuelve todos los archivos de un directorio, recursivamente. */
export function walkFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * Mapea el artefacto del updater a plataforma y prioridad.
 *
 * `createUpdaterArtifacts: true` (Tauri v2) firma directamente el AppImage y
 * los instaladores `.exe`/`.msi`. `"v1Compatible"` genera `.tar.gz`/`.zip`.
 * Aceptamos ambos formatos para no romper si cambia la configuración.
 */
export function updaterArtifact(fileName) {
  // .deb firmado: lo usa el instalador manual de Linux cuando la app no corre
  // como AppImage. Va en una clave propia para no pisar la firma del AppImage.
  if (fileName.endsWith('.deb')) return { platform: 'linux-x86_64-deb', rank: 1 };
  if (fileName.endsWith('.AppImage')) return { platform: 'linux-x86_64', rank: 2 };
  if (fileName.endsWith('.AppImage.tar.gz')) return { platform: 'linux-x86_64', rank: 1 };

  // NSIS es el instalador recomendado para el updater; MSI queda como respaldo.
  if (fileName.endsWith('.exe')) return { platform: 'windows-x86_64', rank: 4 };
  if (fileName.endsWith('.nsis.zip')) return { platform: 'windows-x86_64', rank: 3 };
  if (fileName.endsWith('.msi')) return { platform: 'windows-x86_64', rank: 2 };
  if (fileName.endsWith('.msi.zip')) return { platform: 'windows-x86_64', rank: 1 };

  // APK universal para el actualizador interno de Android. Si en el futuro se
  // publican APK divididos por ABI, también los reconocemos.
  if (fileName.endsWith('.apk')) {
    if (/universal/i.test(fileName)) return { platform: 'android-universal', rank: 5 };
    if (/arm64-v8a|aarch64/i.test(fileName)) return { platform: 'android-aarch64', rank: 4 };
    if (/armeabi-v7a|armv7/i.test(fileName)) return { platform: 'android-armv7', rank: 3 };
    if (/x86_64/i.test(fileName)) return { platform: 'android-x86_64', rank: 2 };
    if (/x86/i.test(fileName)) return { platform: 'android-i686', rank: 1 };
  }

  return null;
}

/** Compatibilidad: devuelve solo la plataforma. */
export function platformFor(fileName) {
  return updaterArtifact(fileName)?.platform ?? null;
}

export function buildLatestJson({
  version,
  tag,
  repo,
  artifactsDir,
  notes = `Inventario Tienda ${version}`,
  pubDate = new Date().toISOString(),
}) {
  if (!version || !tag || !repo) {
    throw new Error('Faltan --version, --tag o --repo.');
  }

  const files = walkFiles(artifactsDir);
  const signatures = files.filter((f) => f.endsWith('.sig'));
  const platforms = {};

  for (const sigPath of signatures) {
    const target = sigPath.slice(0, -'.sig'.length);
    const name = basename(target);
    const artifact = updaterArtifact(name);
    if (!artifact) continue;

    // GitHub reemplaza los espacios del nombre al subir el asset.
    const assetName = name.replace(/ /g, '.');

    // Si hay varios formatos para la misma plataforma, nos quedamos con el de
    // mayor prioridad (NSIS sobre MSI; AppImage directo sobre .tar.gz).
    if (platforms[artifact.platform]?.rank >= artifact.rank) continue;

    const signature = readFileSync(sigPath, 'utf8').trim();
    if (!signature) throw new Error(`Firma vacía: ${sigPath}`);
    // Tauri v2 ya escribe el .sig como base64 del texto minisign. El plugin
    // (y nuestro fallback) decodifica una sola vez, así que publicamos el
    // contenido del archivo tal cual. Volver a codificarlo rompe la firma.
    platforms[artifact.platform] = {
      rank: artifact.rank,
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
    };
  }

  const cleanPlatforms = Object.fromEntries(
    Object.entries(platforms).map(([key, value]) => [
      key,
      { signature: value.signature, url: value.url },
    ])
  );

  if (Object.keys(cleanPlatforms).length === 0) {
    throw new Error(
      `No se encontraron artefactos de updater firmados en ${artifactsDir}. ` +
        'Revisá que createUpdaterArtifacts esté activo y TAURI_SIGNING_PRIVATE_KEY configurada.'
    );
  }

  return { version, notes, pub_date: pubDate, platforms: cleanPlatforms };
}

/* ------------------------------ CLI ------------------------------ */

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const version = arg('--version');
    const tag = arg('--tag', `v${version}`);
    const repo = arg('--repo');
    const artifactsDir = resolve(arg('--artifacts', 'artifacts'));
    const out = resolve(arg('--out', 'latest.json'));
    const notes = arg('--notes', `Inventario Tienda ${version}`);

    const latest = buildLatestJson({ version, tag, repo, artifactsDir, notes });
    writeFileSync(out, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
    console.log(`latest.json generado: ${out}`);
    console.log(`Plataformas: ${Object.keys(latest.platforms).join(', ')}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
