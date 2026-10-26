/**
 * Hybrid Logical Clock (HLC).
 *
 * Resuelve "last-write-wins" sin depender de que los relojes de los dispositivos
 * estén sincronizados (ni de NTP).
 *
 * Encoding (exacto dentro del safe integer de JS):
 *     hlc = wall_ms * COUNTER_SPAN + counter
 *   - wall_ms: tiempo físico de pared en ms epoch (ocupa hasta ~2^41).
 *   - counter: desempate intra-milisegundo, 0..999.
 *   - Max representable: 9.007e15 / 1000 = 9.007e12 ms ≈ año 2255.
 *
 * Garantías:
 *   1. hlc es estrictamente monotónico dentro de un dispositivo.
 *   2. Si A causa a B (A aplicado antes que B), entonces hlc(A) < hlc(B).
 *   3. Ante empate de tiempo físico, gana el counter más alto.
 *
 * Al recibir un evento remoto: hlc = max(local, remoto) + 1 (con la regla de
 * counter del paper original de Kulkarni et al.).
 */

const COUNTER_SPAN = 1000;
const MAX_COUNTER = COUNTER_SPAN - 1;

export class HybridLogicalClock {
  private wall = 0;
  private counter = 0;

  constructor(initial?: number) {
    if (initial !== undefined && initial > 0) {
      this.wall = Math.floor(initial / COUNTER_SPAN);
      this.counter = initial % COUNTER_SPAN;
    }
  }

  /** Emite un nuevo HLC. */
  now(): number {
    const physical = Date.now();
    if (physical > this.wall) {
      this.wall = physical;
      this.counter = 0;
    } else {
      this.counter += 1;
      if (this.counter > MAX_COUNTER) {
        this.wall += 1;
        this.counter = 0;
      }
    }
    return this.encode();
  }

  /**
   * Fusiona un HLC remoto. Devuelve el siguiente HLC local, que es
   * estrictamente mayor que el remoto y que el anterior local.
   */
  observe(remote: number): number {
    const rWall = Math.floor(remote / COUNTER_SPAN);
    const rCounter = remote % COUNTER_SPAN;
    const physical = Date.now();

    const wall = Math.max(this.wall, rWall, physical);
    let counter: number;
    if (wall === this.wall && wall === rWall) {
      counter = Math.max(this.counter, rCounter) + 1;
    } else if (wall === this.wall) {
      counter = this.counter + 1;
    } else if (wall === rWall) {
      counter = rCounter + 1;
    } else {
      counter = 0;
    }
    if (counter > MAX_COUNTER) {
      this.wall = wall + 1;
      this.counter = 0;
    } else {
      this.wall = wall;
      this.counter = counter;
    }
    return this.encode();
  }

  /** HLC actual, sin avanzar el reloj. */
  current(): number {
    return this.encode();
  }

  /** Restaura el reloj desde un HLC persistido (al reabrir la app). */
  resetTo(hlc: number): void {
    if (hlc > this.current()) {
      this.wall = Math.floor(hlc / COUNTER_SPAN);
      this.counter = hlc % COUNTER_SPAN;
    }
  }

  private encode(): number {
    return this.wall * COUNTER_SPAN + this.counter;
  }
}

/** Timestamp físico (ms) de un HLC. */
export function hlcToWall(hlc: number): number {
  return Math.floor(hlc / COUNTER_SPAN);
}

/** Compara dos HLC. */
export function hlcCompare(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
