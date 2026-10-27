import { describe, expect, it } from 'vitest';
// @ts-ignore (scripts de versión sin declaración de tipos; probados por verifyVersionMap)
import * as vm from '../scripts/version-map.mjs';

describe('parseSemver', () => {
  it('parsea una versión simple', () => {
    expect(vm.parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: undefined,
      build: undefined,
    });
  });
  it('parsea con prerelease y build', () => {
    expect(vm.parseSemver('1.2.3-beta.1+abc')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: 'beta.1',
      build: 'abc',
    });
  });
  it('devuelve null para inválidas', () => {
    expect(vm.parseSemver('no-es-semver')).toBeNull();
    expect(vm.parseSemver('1.2')).toBeNull();
    expect(vm.parseSemver('v1.2.3')).toBeNull();
  });
});

describe('formatSemver', () => {
  it('reconstruye la versión', () => {
    const p = vm.parseSemver('1.10.0-beta.2+build');
    expect(vm.formatSemver(p!)).toBe('1.10.0-beta.2+build');
  });
});

describe('mapVersion', () => {
  for (const c of vm.VERSION_MAP_CASES) {
    it(`mapea ${c.input} correctamente`, () => {
      const got = vm.mapVersion(c.input);
      expect(got.android.versionName).toBe(c.expect.android.versionName);
      expect(got.android.versionCode).toBe(c.expect.android.versionCode);
      expect(got.windows.version).toBe(c.expect.windows.version);
      expect(got.windows.installer).toBe('NSIS');
      expect(got.linux.version).toBe(c.expect.linux.version);
    });
  }
  it('Android versionCode crece estrictamente', () => {
    expect(vm.mapVersion('1.9.0').android.versionCode).toBeLessThan(
      vm.mapVersion('1.10.0').android.versionCode,
    );
    expect(vm.mapVersion('1.2.999').android.versionCode).toBeLessThan(
      vm.mapVersion('1.3.0').android.versionCode,
    );
  });
  it('rechaza minor/patch fuera de 0-999', () => {
    expect(() => vm.mapVersion('1.1000.0')).toThrow();
    expect(() => vm.mapVersion('1.0.1000')).toThrow();
  });
  it('Linux ordena prereleases con ~', () => {
    expect(vm.mapVersion('1.2.3-beta.1').linux.version).toBe('1.2.3~beta.1');
    expect(vm.mapVersion('1.2.3').linux.version).toBe('1.2.3');
  });
  it('Windows usa NSIS y versión numérica', () => {
    expect(vm.mapVersion('1.2.3-beta.1').windows.installer).toBe('NSIS');
    expect(vm.mapVersion('1.2.3-beta.1').windows.version).toBe('1.2.3.0');
  });
});

describe('semverGt (comparación real, no string)', () => {
  it('1.10.0 > 1.9.0', () => {
    expect(vm.semverGt('1.10.0', '1.9.0')).toBe(true);
  });
  it('versión igual no es mayor', () => {
    expect(vm.semverGt('1.2.3', '1.2.3')).toBe(false);
  });
  it('prerelease < release', () => {
    expect(vm.semverGt('1.2.3-beta.1', '1.2.3')).toBe(false);
    expect(vm.semverGt('1.2.3', '1.2.3-beta.1')).toBe(true);
  });
  it('entre prereleases compara identificadores', () => {
    expect(vm.semverGt('1.2.3-beta.2', '1.2.3-beta.1')).toBe(true);
    expect(vm.semverGt('1.2.3-alpha', '1.2.3-beta.1')).toBe(false);
  });
});

describe('verifyVersionMap', () => {
  it('no lanza (todos los casos pasan)', () => {
    expect(() => vm.verifyVersionMap()).not.toThrow();
  });
});
