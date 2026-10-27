import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLatestJson, platformFor, walkFiles } from '../scripts/latest-json.mjs';

const dirs: string[] = [];

function makeArtifacts(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'latest-json-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('latest-json', () => {
  it('reconoce las plataformas del updater', () => {
    expect(platformFor('app_1.0.0_amd64.AppImage.tar.gz')).toBe('linux-x86_64');
    expect(platformFor('app_1.0.0_amd64.AppImage')).toBe('linux-x86_64');
    expect(platformFor('app_1.0.0_x64-setup.nsis.zip')).toBe('windows-x86_64');
    expect(platformFor('app_1.0.0_x64-setup.exe')).toBe('windows-x86_64');
    expect(platformFor('app_1.0.0_x64_en-US.msi')).toBe('windows-x86_64');
    expect(platformFor('app_1.0.0_x64_en-US.msi.zip')).toBe('windows-x86_64');
    expect(platformFor('app-release.apk')).toBeNull();
  });

  it('arma Linux y Windows con firma y URL reales', () => {
    const dir = makeArtifacts({
      'app_1.2.3_amd64.AppImage.tar.gz': 'tar',
      'app_1.2.3_amd64.AppImage.tar.gz.sig': '  firma-linux  \n',
      'app_1.2.3_x64-setup.nsis.zip': 'zip',
      'app_1.2.3_x64-setup.nsis.zip.sig': 'firma-windows\n',
      'app_1.2.3_x64-setup.exe': 'exe',
    });

    const json = buildLatestJson({
      version: '1.2.3',
      tag: 'v1.2.3',
      repo: 'wulflo/store-inventory',
      artifactsDir: dir,
      notes: 'Notas',
      pubDate: '2026-10-27T00:00:00.000Z',
    });

    expect(json.version).toBe('1.2.3');
    expect(json.notes).toBe('Notas');
    expect(json.pub_date).toBe('2026-10-27T00:00:00.000Z');
    expect(json.platforms['linux-x86_64']).toEqual({
      signature: 'firma-linux',
      url: 'https://github.com/wulflo/store-inventory/releases/download/v1.2.3/app_1.2.3_amd64.AppImage.tar.gz',
    });
    expect(json.platforms['windows-x86_64']).toEqual({
      signature: 'firma-windows',
      url: 'https://github.com/wulflo/store-inventory/releases/download/v1.2.3/app_1.2.3_x64-setup.nsis.zip',
    });
  });

  it('usa los artefactos directos de Tauri v2 (AppImage, exe, msi)', () => {
    const dir = makeArtifacts({
      'app_2.0.0_amd64.AppImage.sig': 'firma-appimage',
      'app_2.0.0_x64-setup.exe.sig': 'firma-exe',
      'app_2.0.0_x64_en-US.msi.sig': 'firma-msi',
      'app_2.0.0_amd64.AppImage': 'binario',
    });

    const json = buildLatestJson({
      version: '2.0.0',
      tag: 'v2.0.0',
      repo: 'owner/repo',
      artifactsDir: dir,
    });

    expect(json.platforms['linux-x86_64']).toEqual({
      signature: 'firma-appimage',
      url: 'https://github.com/owner/repo/releases/download/v2.0.0/app_2.0.0_amd64.AppImage',
    });
    expect(json.platforms['windows-x86_64']).toEqual({
      signature: 'firma-exe',
      url: 'https://github.com/owner/repo/releases/download/v2.0.0/app_2.0.0_x64-setup.exe',
    });
  });

  it('prefiere el AppImage directo sobre el .tar.gz de v1Compatible', () => {
    const dir = makeArtifacts({
      'app_3.0.0_amd64.AppImage.sig': 'directo',
      'app_3.0.0_amd64.AppImage.tar.gz.sig': 'tar',
      'app_3.0.0_x64-setup.exe.sig': 'exe',
    });

    const json = buildLatestJson({
      version: '3.0.0',
      tag: 'v3.0.0',
      repo: 'owner/repo',
      artifactsDir: dir,
    });

    expect(json.platforms['linux-x86_64'].signature).toBe('directo');
    expect(json.platforms['linux-x86_64'].url).toMatch(/\.AppImage$/);
  });

  it('prefiere NSIS sobre MSI en Windows', () => {
    const dir = makeArtifacts({
      'app_1.0.0_x64_en-US.msi.zip.sig': 'msi',
      'app_1.0.0_x64-setup.nsis.zip.sig': 'nsis',
      'app_1.0.0_amd64.AppImage.tar.gz.sig': 'linux',
    });

    const json = buildLatestJson({
      version: '1.0.0',
      tag: 'v1.0.0',
      repo: 'owner/repo',
      artifactsDir: dir,
    });

    expect(json.platforms['windows-x86_64'].signature).toBe('nsis');
  });

  it('falla si no hay firmas', () => {
    const dir = makeArtifacts({ 'app_1.0.0_amd64.AppImage.tar.gz': 'sin firmar' });
    expect(() =>
      buildLatestJson({ version: '1.0.0', tag: 'v1.0.0', repo: 'owner/repo', artifactsDir: dir })
    ).toThrow(/No se encontraron artefactos/);
  });

  it('walkFiles recorre subdirectorios', () => {
    const dir = makeArtifacts({ 'a/b/c.sig': 'x', 'd.txt': 'y' });
    expect(walkFiles(dir).map((f) => f.split('/').pop()).sort()).toEqual(['c.sig', 'd.txt']);
  });
});
