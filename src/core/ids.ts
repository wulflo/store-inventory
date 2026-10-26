/**
 * UUID v7 — IDs ordenables por tiempo, únicos globalmente, sin coordinación.
 *
 * Layout (RFC 9562):
 *   48 bits  unix_ts_ms
 *   4  bits  version (7)
 *   12 bits  rand_a
 *   2  bits  variant (10)
 *   62 bits  rand_b
 *
 * Implementación en JS puro (sin crypto nativo) para que funcione en
 * cualquier contexto (navegador, worker, node) con el mismo resultado.
 */

const HEX = '0123456789abcdef';

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const g: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
  if (g && typeof g.getRandomValues === 'function') {
    g.getRandomValues(out);
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return out;
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += HEX[b[i] >> 4] + HEX[b[i] & 15];
  }
  return s;
}

/** Genera un UUID v7 con el timestamp dado (o ahora). */
export function uuid7(now: number = Date.now()): string {
  const ts = BigInt(Math.max(0, Math.floor(now)));
  const rand = randomBytes(10);

  // 48 bits de timestamp
  const b = new Uint8Array(16);
  b[0] = Number((ts >> 40n) & 0xffn);
  b[1] = Number((ts >> 32n) & 0xffn);
  b[2] = Number((ts >> 24n) & 0xffn);
  b[3] = Number((ts >> 16n) & 0xffn);
  b[4] = Number((ts >> 8n) & 0xffn);
  b[5] = Number(ts & 0xffn);

  // version 7 + rand_a (12 bits)
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1];
  // variant 10 + rand_b (62 bits)
  b[8] = 0x80 | (rand[2] & 0x3f);
  b[9] = rand[3];
  b[10] = rand[4];
  b[11] = rand[5];
  b[12] = rand[6];
  b[13] = rand[7];
  b[14] = rand[8];
  b[15] = rand[9];

  const h = toHex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Extrae el timestamp (ms) de un UUID v7. */
export function uuid7Timestamp(id: string): number {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return parseInt(hex, 16);
}

/** Extrae los 48 bits de timestamp de un UUID v7 en hex. */
export function uuid7HexTimestamp(id: string): string {
  return id.replace(/-/g, '').slice(0, 12);
}
