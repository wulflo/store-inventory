/**
 * scripts/version-map.mjs
 *
 * Convierte una versión SemVer a los identificadores de cada plataforma.
 * Función única y testeada, con tabla de casos.
 *
 * Reglas (documentadas en DECISIONS.md):
 *  - Android: versionName = semver completo; versionCode = major*1_000_000 +
 *    minor*1_000 + patch (enteros estrictamente crecientes, 0-999 para minor/patch).
 *    Prereleases: mismo versionCode del release objetivo (documentada limitación;
 *    no se suben a tracks que requieran versionCode estrictamente único sin ajuste manual).
 *  - Windows: NSIS como instalador único (mismo tipo entre versiones para no romper
 *    el updater). Versión numérica sin sufijo de prerelease (MSI no admite texto).
 *  - Linux: deb/rpm ordenan prereleases con `~` (ej: 1.2.3~beta.1 < 1.2.3).
 *  - Comparación en app: semver real (1.10.0 > 1.9.0; prerelease < release).
 */

export function parseSemver(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(String(version));
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch, prerelease: m[4] ?? undefined, build: m[5] ?? undefined };
}

export function formatSemver(p) {
  let s = `${p.major}.${p.minor}.${p.patch}`;
  if (p.prerelease) s += `-${p.prerelease}`;
  if (p.build) s += `+${p.build}`;
  return s;
}

export function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch;
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
    const aNum = Number.isFinite(na);
    const bNum = Number.isFinite(nb);
    if (aNum && bNum) { if (na !== nb) return na - nb; }
    else if (aNum && !bNum) return -1;
    else if (!aNum && bNum) return 1;
    else { if (ta[i] !== tb[i]) return ta[i] < tb[i] ? -1 : 1; }
  }
  return ta.length - tb.length;
}

/**
 * Mapea una versión SemVer a los identificadores de cada plataforma.
 * Devuelve { windows, android, linux }.
 */
export function mapVersion(version) {
  const p = parseSemver(version);
  if (!p) throw new Error(`Versión SemVer inválida: ${version}`);

  // --- Android ---
  if (p.minor > 999 || p.patch > 999) {
    throw new Error(`minor y patch deben estar entre 0 y 999 (recibido ${p.minor}.${p.patch})`);
  }
  const baseCode = p.major * 1_000_000 + p.minor * 1_000 + p.patch;
  // Prerelease: mismo versionCode del release objetivo (limitación documentada).
  const androidVersionCode = baseCode;
  const androidVersionName = formatSemver(p);

  // --- Windows (NSIS, instalador único entre versiones) ---
  // MSI no admite texto de prerelease; NSIS es más flexible. Usamos NSIS siempre.
  // Para prereleases se quita el sufijo de texto en la versión numérica del instalador.
  const windowsVersion = `${p.major}.${p.minor}.${p.patch}.0`;
  const windowsInstaller = 'NSIS';

  // --- Linux (deb/rpm: ~ ordena prereleases antes del release) ---
  const linuxVersion = p.prerelease ? `${p.major}.${p.minor}.${p.patch}~${p.prerelease}` : formatSemver(p);

  return {
    windows: { installer: windowsInstaller, version: windowsVersion, prerelease: p.prerelease ?? undefined },
    android: { versionName: androidVersionName, versionCode: androidVersionCode, prerelease: p.prerelease ?? undefined },
    linux: { version: linuxVersion, prerelease: p.prerelease ?? undefined },
  };
}

/** Tabla de casos para pruebas de versión-mapa. */
export const VERSION_MAP_CASES = [
  { input: '1.0.0', expect: { android: { versionName: '1.0.0', versionCode: 1000000 }, windows: { version: '1.0.0.0', installer: 'NSIS' }, linux: { version: '1.0.0' } } },
  { input: '1.2.3', expect: { android: { versionName: '1.2.3', versionCode: 1002003 }, windows: { version: '1.2.3.0', installer: 'NSIS' }, linux: { version: '1.2.3' } } },
  { input: '1.10.0', expect: { android: { versionName: '1.10.0', versionCode: 1010000 }, windows: { version: '1.10.0.0', installer: 'NSIS' }, linux: { version: '1.10.0' } } },
  { input: '1.2.3-beta.1', expect: { android: { versionName: '1.2.3-beta.1', versionCode: 1002003 }, windows: { version: '1.2.3.0', installer: 'NSIS', prerelease: 'beta.1' }, linux: { version: '1.2.3~beta.1', prerelease: 'beta.1' } } },
  { input: '2.0.0-rc.1', expect: { android: { versionName: '2.0.0-rc.1', versionCode: 2000000 }, windows: { version: '2.0.0.0', installer: 'NSIS', prerelease: 'rc.1' }, linux: { version: '2.0.0~rc.1', prerelease: 'rc.1' } } },
  { input: '0.1.0', expect: { android: { versionName: '0.1.0', versionCode: 1000 }, windows: { version: '0.1.0.0', installer: 'NSIS' }, linux: { version: '0.1.0' } } },
];

/** Ejecuta la tabla de casos y lanza si algo falla. */
export function verifyVersionMap() {
  let failed = 0;
  for (const c of VERSION_MAP_CASES) {
    const got = mapVersion(c.input);
    const ok =
      got.android.versionName === c.expect.android.versionName &&
      got.android.versionCode === c.expect.android.versionCode &&
      got.windows.version === c.expect.windows.version &&
      got.windows.installer === c.expect.windows.installer &&
      got.linux.version === c.expect.linux.version;
    if (!ok) {
      console.error(`FALLO version-map: ${c.input}\n  esperado: ${JSON.stringify(c.expect)}\n  obtenido: ${JSON.stringify(got)}`);
      failed++;
    }
  }
  // Comparación semver
  const cmpCases = [
    ['1.10.0', '1.9.0', true],
    ['1.2.3', '1.2.3', false],
    ['1.2.3-beta.1', '1.2.3', false],
    ['1.2.3', '1.2.3-beta.1', true],
    ['1.2.3-beta.2', '1.2.3-beta.1', true],
    ['1.2.3-alpha', '1.2.3-beta.1', false],
  ];
  for (const [a, b, expectGt] of cmpCases) {
    const got = semverGt(a, b);
    if (got !== expectGt) {
      console.error(`FALLO semverGt: ${a} > ${b} ? esperado ${expectGt}, obtenido ${got}`);
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`${failed} caso(s) de version-map fallaron.`);
    process.exit(1);
  }
  console.log(`version-map: ${VERSION_MAP_CASES.length + cmpCases.length} casos OK.`);
}

const cmpCases = [
  ['1.10.0', '1.9.0', true],
  ['1.2.3', '1.2.3', false],
  ['1.2.3-beta.1', '1.2.3', false],
  ['1.2.3', '1.2.3-beta.1', true],
  ['1.2.3-beta.2', '1.2.3-beta.1', true],
  ['1.2.3-alpha', '1.2.3-beta.1', false],
];

if (process.argv[1] && process.argv[1].endsWith('version-map.mjs') && process.argv.includes('--verify')) {
  verifyVersionMap();
}
