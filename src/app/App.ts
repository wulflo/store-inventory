import { HybridLogicalClock } from '../core/hlc';
import { uuid7 } from '../core/ids';
import type { Domain, DomainEvent } from '../core/types';
import { Projector } from '../projection/Projector';
import { type AppState, createEmptyState, recomputeReservations, reindexAll } from '../projection/state';
import { type EventStore, sortEvents } from '../store/EventStore';
import { domainForEventType } from '../store/TauriEventStore';

export type AppEvent =
  | { type: 'state'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'status'; message: string };

/**
 * Núcleo de la aplicación: mantiene el estado derivado, escribe eventos
 * y notifica a la UI.
 *
 * Flujo de escritura:
 *   1. Se construye el evento (id, type, payload, metadata con HLC).
 *   2. Se hace append al store (disco / OPFS).
 *   3. Se aplica al proyector (optimista) → la UI ya puede pintar.
 *   4. Se notifica a los suscriptores.
 */
export class App {
  state: AppState;
  projector: Projector;
  readonly clock = new HybridLogicalClock();

  private listeners = new Set<(e: AppEvent) => void>();
  private reloading = false;
  private reloadAgain = false;
  /** Aviso de reparación ocurrido antes de que la UI se suscriba. */
  startupNotice: string | null = null;

  constructor(public readonly store: EventStore, deviceId: string) {
    this.state = createEmptyState(deviceId);
    this.projector = new Projector(this.state);
  }

  get deviceId(): string {
    return this.state.deviceId;
  }

  /* -------------------------------------------------------------- */
  /* Ciclo de vida                                                  */
  /* -------------------------------------------------------------- */

  async init(): Promise<void> {
    await this.store.init();
    await this.reloadAll('rebuild');

    // Observar cambios externos (otra app o equipo escribe en la carpeta).
    await this.store.watch(() => {
      void this.reloadAll('external');
    });
  }

  /**
   * Repara el diario local y reconstruye TODO el estado desde los archivos.
   *
   * Se usa al arrancar, tras restaurar un backup y cuando el watcher detecta
   * un cambio externo. Reconstruir desde cero (en vez de aplicar el dominio
   * sobre el estado actual) hace que las entidades que desaparecieron del
   * archivo también desaparezcan de la UI; antes quedaban cacheadas y
   * ocultaban la pérdida.
   */
  async reloadAll(reason = 'external'): Promise<void> {
    if (this.reloading) {
      this.reloadAgain = true;
      return;
    }
    this.reloading = true;
    try {
      do {
        this.reloadAgain = false;
        await this.rebuildFromDisk(reason);
      } while (this.reloadAgain);
    } finally {
      this.reloading = false;
    }
  }

  private async rebuildFromDisk(reason: string): Promise<void> {
    let repaired = 0;
    try {
      const report = await this.store.repair();
      repaired = report.repaired;
      if (report.errors.length > 0) console.warn('journal repair', report.errors);
    } catch (err) {
      // Un fallo de reparación no debe impedir mostrar la bóveda.
      console.warn('journal repair', err);
    }

    const events = await this.store.readAll();
    this.state = createEmptyState(this.state.deviceId);
    this.projector = new Projector(this.state);
    this.projector.applyAll(sortEvents(events));
    this.clock.resetTo(this.state.lastHlc);
    reindexAll(this.state);
    recomputeReservations(this.state);

    if (repaired > 0) {
      const message = `Se recuperaron ${repaired} evento(s) que habían desaparecido de la carpeta de datos.`;
      if (this.listeners.size === 0) this.startupNotice = message;
      else this.notify({ type: 'status', message });
    }
    this.notify({ type: 'state', reason });
  }

  /** Compatibilidad: recarga completa al detectar un dominio externo. */
  async reloadDomain(domain: Domain): Promise<void> {
    await this.reloadAll(`external:${domain}`);
  }

  /* -------------------------------------------------------------- */
  /* Escritura                                                      */
  /* -------------------------------------------------------------- */

  /** Notifica a los suscriptores (no es un evento de dominio). */
  notify(e: AppEvent): void {
    for (const l of this.listeners) l(e);
  }

  /** Construye un evento con HLC y metadata del device actual. */
  makeEvent<P>(type: string, payload: P): DomainEvent<P> {
    const hlc = this.clock.now();
    return {
      id: uuid7(),
      type,
      payload,
      metadata: {
        hlc,
        deviceId: this.state.deviceId,
        timestamp: Date.now(),
        version: 1,
      },
    };
  }

  /**
   * Escribe un evento: append + aplicación optimista + notificación.
   * Devuelve el evento creado (con su id) para poder referenciarlo.
   */
  async emit<P>(type: string, payload: P): Promise<DomainEvent<P>> {
    const event = this.makeEvent(type, payload);
    const domain = domainForEventType(type);
    await this.store.append(domain, [event as DomainEvent]);
    this.projector.apply(event as DomainEvent);
    this.notify({ type: 'state', reason: type });
    return event;
  }

  /** Escribe varios eventos del mismo dominio en una sola operación. */
  async emitMany<P>(type: string, payloads: P[]): Promise<DomainEvent<P>[]> {
    if (payloads.length === 0) return [];
    const events = payloads.map((p) => this.makeEvent(type, p));
    const domain = domainForEventType(type);
    await this.store.append(
      domain,
      events as DomainEvent[],
    );
    for (const e of events) this.projector.apply(e as DomainEvent);
    this.notify({ type: 'state', reason: type });
    return events;
  }

  /* -------------------------------------------------------------- */
  /* Ajustes                                                        */
  /* -------------------------------------------------------------- */

  getSetting(key: string): string | undefined {
    return this.state.settings.get(key);
  }

  getSettingJson<T>(key: string, fallback: T): T {
    const raw = this.state.settings.get(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    await this.emit('Setting.Set', { key, value: JSON.stringify(value) });
  }

  /* -------------------------------------------------------------- */
  /* Suscripciones                                                  */
  /* -------------------------------------------------------------- */

  subscribe(fn: (e: AppEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Reconstruye todo el estado desde cero (usado tras restaurar un backup). */
  async rebuild(): Promise<void> {
    await this.reloadAll('rebuild');
  }
}
