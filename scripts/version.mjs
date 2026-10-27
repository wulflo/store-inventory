/**
 * scripts/version.mjs
 *
 * Gestión de versión SemVer para Inventario Tienda.
 * Node puro, sin dependencias.
 *
 * Uso:
 *   node scripts/version.mjs check          # valida árbol limpio y coherencia tag↔archivos
 *   node scripts/version.mjs set 1.2.3      # sincroniza versión, commitea y crea tag v1.2.3
 *
 * Sincroniza: package.json, package-lock.json, src/core/version.ts,
 *             src-tauri/Cargo.toml, src-tauri/tauri.conf.json (si existen).
 * Cuando src-tauri/ no existe aún, se crean los archivos mínimos de versión
 * para que el script no falle; el resto del backend Rust se completa en
 * fases posteriores.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { parseSemver, mapVersion, formatSemver } from './version-map.mjs';

const ROOT = new URL('.', import.meta.url).pathname;
const PKG_JSON = `${ROOT}package.json`;
const PKG_LOCK = `${ROOT}package-lock.json`;
const VERSION_TS = `${ROOT}src/core/version.ts`;
const CARGO_TOML = `${ROOT}src-tauri/Cargo.toml`;
const CARGO_LOCK = `${ROOT}src-tauri/Cargo.lock`;
const TAURI_CONF = `${ROOT}src-tauri/tauri.conf.json`;

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', cwd: ROOT }).trim();
}

function gitClean() {
  const status = sh('git status --porcelain');
  if (status) {
    console.error('Error: el árbol de trabajo no está limpio. Commitea o descarta cambios antes de release.');
    process.exit(1);
  }
}

function currentBranch() {
  return sh('git rev-parse --abbrev-ref HEAD');
}

function currentTag() {
  try {
    return sh('git describe --tags --exact-match HEAD 2>/dev/null || true');
  } catch {
    return '';
  }
}

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function replaceVersionInText(text, oldVer, newVer) {
  // Reemplaza "version": "1.0.0" (con opcional coma después es parte del JSON, solo tocamos el valor)
  return text.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${newVer}"`);
}

function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;
  // prerelease < release; entre prereleases, comparar identificadores
  if (pa.prerelease === undefined && pb.prerelease !== undefined) return true;
  if (pa.prerelease !== undefined && pb.prerelease === undefined) return false;
  if (pa.prerelease === undefined && pb.prerelease === undefined) return false;
  return comparePrerelease(pa.prerelease, pb.prerelease) > 0;
}

function comparePrerelease(a, b) {
  const ta = a.split('.');
  const tb = b.split('.');
  const n = Math.min(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const na = Number(ta[i]);
    const nb = Number(tb[i]);
    const aIsNum = !Number.isNaN(na);
    const bIsNum = !Number.isNaN(nb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else if (aIsNum && !bIsNum) {
      return -1; // numérico < alfanumérico
    } else if (!aIsNum && bIsNum) {
      return 1;
    } else {
      if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}

async function check() {
  gitClean();
  const pkg = await readJson(PKG_JSON);
  const ver = pkg.version;
  const tag = currentTag();
  const expectedTag = `v${ver}`;

  console.log(`Versión en package.json: ${ver}`);
  console.log(`Tag exacto en HEAD: ${tag || '(ninguno)'}`);

  if (tag && tag !== expectedTag) {
    console.error(`Error: el tag "${tag}" no coincide con la versión "${expectedTag}".`);
    process.exit(1);
  }

  // Coherencia con src-tauri si existen
  for (const path of [CARGO_TOML, TAURI_CONF]) {
    try {
      const text = await readFile(path, 'utf8');
      if (text.includes(`version = "${ver}"`) || text.includes(`"version": "${ver}"`)) {
        console.log(`OK: ${path} sincronizado con ${ver}`);
      } else {
        console.warn(`Aviso: ${path} puede no estar sincronizado con ${ver}. Ejecuta 'set ${ver}' para corregir.`);
      }
    } catch {
      // No existe aún: se crea con 'set'
    }
  }

  // Android exige un versionCode monotónico y distinto por release.
  try {
    const conf = await readJson(TAURI_CONF);
    const expectedCode = mapVersion(ver).android.versionCode;
    const actualCode = conf.bundle?.android?.versionCode;
    if (actualCode !== expectedCode) {
      console.error(
        `Error: Android versionCode ${actualCode} ≠ ${expectedCode} para ${ver}. Ejecuta 'set ${ver}' para corregir.`
      );
      process.exit(1);
    } else {
      console.log(`OK: Android versionCode ${actualCode}`);
    }
  } catch {
    // Sin tauri.conf.json no hay nada que validar.
  }

  console.log('check: OK');
}

async function set(newVerRaw) {
  gitClean();

  const parsed = parseSemver(newVerRaw);
  if (!parsed) {
    console.error(`Error: "${newVerRaw}" no es una versión SemVer válida (ej: 1.2.3 o 1.2.3-beta.1).`);
    process.exit(1);
  }
  const newVer = formatSemver(parsed);

  const pkg = await readJson(PKG_JSON);
  const oldVer = pkg.version;

  if (oldVer === newVer) {
    console.error(`Error: la versión ya es ${newVer}.`);
    process.exit(1);
  }

  if (!semverGt(newVer, oldVer)) {
    console.error(`Error: la nueva versión ${newVer} no es estrictamente mayor que la actual ${oldVer}.`);
    process.exit(1);
  }

  const mapped = mapVersion(newVer);
  console.log(`Release ${oldVer} → ${newVer}`);
  console.log(`  Android versionName=${mapped.android.versionName} versionCode=${mapped.android.versionCode}`);
  console.log(`  Windows ${mapped.windows.installer} ${mapped.windows.version}`);
  console.log(`  Linux ${mapped.linux.version}`);

  // --- Actualizar package.json ---
  pkg.version = newVer;
  await writeJson(PKG_JSON, pkg);

  // --- Actualizar package-lock.json (versión raíz) ---
  try {
    const lockText = await readFile(PKG_LOCK);
    const newLock = replaceVersionInText(lockText, oldVer, newVer);
    if (newLock !== lockText) await writeFile(PKG_LOCK, newLock, 'utf8');
  } catch {
    /* package-lock.json puede no existir */
  }

  // --- Actualizar src/core/version.ts ---
  await writeFile(
    VERSION_TS,
    `/* Generado por scripts/version.mjs. No editar manualmente. */\n\nexport const APP_VERSION = '${newVer}';\nexport const APP_VERSION_PARSED = ${JSON.stringify(parsed)};\n`,
    'utf8'
  );

  // --- Actualizar src-tauri si existen (o crear mínimos) ---
  const tauriExists = await fileExists(CARGO_TOML);
  if (tauriExists) {
    let toml = await readFile(CARGO_TOML, 'utf8');
    toml = toml.replace(/^version = "[^"]*"$/m, `version = "${newVer}"`);
    await writeFile(CARGO_TOML, toml, 'utf8');
    console.log(`OK: ${CARGO_TOML} → ${newVer}`);
  } else {
    await writeFile(
      CARGO_TOML,
      `[package]\nname = \"inventario-tienda\"\nversion = \"${newVer}\"\nedition = \"2021\"\n\n[dependencies]\n\n[target.'cfg(target_os = \"android\")'.dependencies]\n`,
      'utf8'
    );
    console.log(`Creado (mínimo): ${CARGO_TOML} → ${newVer}`);
  }

  if (await fileExists(TAURI_CONF)) {
    const conf = await readJson(TAURI_CONF);
    conf.version = newVer;
    if (conf.bundle?.android) {
      conf.bundle.android.versionCode = mapped.android.versionCode;
    }
    await writeJson(TAURI_CONF, conf);
    console.log(
      `OK: ${TAURI_CONF} → ${newVer} (Android versionCode ${mapped.android.versionCode})`
    );
  } else {
    await writeFile(
      TAURI_CONF,
      JSON.stringify({
        version: newVer,
        identifier: 'com.inventariotienda.app',
        build: { frontendDist: '../dist', beforeDevCommand: 'npm run dev', beforeBuildCommand: 'npm run build' },
        app: { windows: [{ title: 'Inventario Tienda' }] },
      },
      null,
      2
    ) + '\n',
      'utf8'
    );
    console.log(`Creado (mínimo): ${TAURI_CONF} → ${newVer}`);
  }

  // Cargo.lock y gen/android: avisar que se regeneran con tauri/android init
  console.log(`Nota: ${CARGO_LOCK} y src-tauri/gen/android se regeneran con 'cargo build' / 'tauri android init'.`);

  // --- Commit y tag ---
  const branch = currentBranch();
  const files = [PKG_JSON, PKG_LOCK, VERSION_TS, CARGO_TOML, TAURI_CONF].filter(await fileExists);
  if (files.length > 0) {
    sh(`git add ${files.join(' ')}`);
    sh(`git commit -m "chore(release): v${newVer}"`);
    sh(`git tag -a v${newVer} -m "Release v${newVer}"`);
    console.log(`\n✓ Commit y tag v${newVer} creados en rama "${branch}".`);
    console.log(`  Empuja con: git push origin ${branch} --tags`);
  } else {
    console.warn('No hubo archivos para commitear.');
  }
}

async function fileExists(path) {
  try {
    await readFile(path, 'utf8');
    return true;
  } catch {
    return false;
  }
}

const cmd = process.argv[2];
if (cmd === 'check') {
  void check();
} else if (cmd === 'set') {
  const target = process.argv[3];
  if (!target) {
    console.error('Uso: node scripts/version.mjs set <x.y.z>');
    process.exit(1);
  }
  void set(target);
} else {
  console.error('Uso: node scripts/version.mjs [check|set <x.y.z>]');
  process.exit(1);
}
