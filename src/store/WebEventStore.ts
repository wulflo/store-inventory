import type { Domain, DomainEvent } from '../core/types';
import {
  type EventStore,
  type ExportBundle,
  parseEventLine,
  serializeEvents,
  sortEvents,
} from './EventStore';
import { DOMAIN_LIST, domainForEventType } from './TauriEventStore';

/**
 * Store en modo navegador, usando la File System Access API (OPFS).
 *
 * Sirve para:
 *  - desarrollo de la UI en `vite dev` sin necesidad de compilar Tauri;
 *  - fallback cuando el plugin de fs no está disponible;
 *  - tests en Node (con un backend en memoria).
 *
 * OPFS (`navigator.storage.getDirectory()`) da un directorio real y persistente,
 * con las mismas semánticas de append que el filesystem nativo.
 */
export class WebEventStore implements EventStore {
  readonly kind = 'web' as const;

  private dir: any = null;
  private listeners: Array<(domain: Domain) => void> = [];

  async init(): Promise<void> {
    if (this.dir) return;
    const storage = (navigator as any).storage;
    if (!storage?.getDirectory) {
      throw new Error('Este navegador no soporta OPFS. Usá la app de escritorio.');
    }
    this.dir = await storage.getDirectory();
    // Subcarpeta "events" para no ensuciar la raíz.
    this.dir = await this.dir.getDirectoryHandle('events', { create: true });
  }

  private async fileHandle(domain: Domain, create = true): Promise<any> {
    return this.dir.getFileHandle(`${domain}.jsonl`, { create });
  }

  async append(domain: Domain, events: DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    const handle = await this.fileHandle(domain, true);
    const existing = await (await handle.getFile()).text();
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    const body = serializeEvents(events);
    const writable = await handle.createWritable();
    await writable.write(prefix + body + '\n');
    await writable.close();
    this.emit(domain);
  }

  async read(domain: Domain): Promise<DomainEvent[]> {
    try {
      const handle = await this.fileHandle(domain, false);
      const text = await (await handle.getFile()).text();
      const events: DomainEvent[] = [];
      for (const line of text.split('\n')) {
        const ev = parseEventLine(line);
        if (ev) events.push(ev);
      }
      return sortEvents(events);
    } catch {
      return [];
    }
  }

  async readAll(): Promise<DomainEvent[]> {
    const all: DomainEvent[] = [];
    for (const domain of DOMAIN_LIST) all.push(...(await this.read(domain)));
    return sortEvents(all);
  }

  async watch(callback: (domain: Domain) => void): Promise<void> {
    this.listeners.push(callback);
  }

  async unwatch(): Promise<void> {
    this.listeners = [];
  }

  location(): string {
    return 'Almacenamiento del navegador (OPFS)';
  }

  async exportAll(): Promise<ExportBundle> {
    return {
      format: 'inventario-tienda/events',
      version: 1,
      exportedAt: Date.now(),
      deviceId: 'web',
      events: await this.readAll(),
    };
  }

  async importBundle(bundle: ExportBundle): Promise<{ imported: number; skipped: number }> {
    const existing = await this.readAll();
    const ids = new Set(existing.map((e) => e.id));
    const fresh = bundle.events.filter((e) => !ids.has(e.id));
    const byDomain = new Map<Domain, DomainEvent[]>();
    for (const ev of fresh) {
      const d = domainForEventType(ev.type);
      byDomain.set(d, [...(byDomain.get(d) ?? []), ev]);
    }
    for (const [d, list] of byDomain) await this.append(d, list);
    return { imported: fresh.length, skipped: bundle.events.length - fresh.length };
  }

  private emit(domain: Domain): void {
    for (const l of this.listeners) l(domain);
  }
}

/**
 * Store en memoria. Para tests y como último recurso.
 */
export class MemoryEventStore implements EventStore {
  readonly kind = 'memory' as const;
  private data = new Map<Domain, DomainEvent[]>();
  private listeners: Array<(domain: Domain) => void> = [];

  async init(): Promise<void> {}

  async append(domain: Domain, events: DomainEvent[]): Promise<void> {
    const list = this.data.get(domain) ?? [];
    list.push(...events);
    this.data.set(domain, list);
    this.emit(domain);
  }

  async read(domain: Domain): Promise<DomainEvent[]> {
    return sortEvents([...(this.data.get(domain) ?? [])]);
  }

  async readAll(): Promise<DomainEvent[]> {
    const all: DomainEvent[] = [];
    for (const list of this.data.values()) all.push(...list);
    return sortEvents(all);
  }

  async watch(callback: (domain: Domain) => void): Promise<void> {
    this.listeners.push(callback);
  }

  async unwatch(): Promise<void> {
    this.listeners = [];
  }

  location(): string {
    return 'Memoria (volátil)';
  }

  async exportAll(): Promise<ExportBundle> {
    return {
      format: 'inventario-tienda/events',
      version: 1,
      exportedAt: Date.now(),
      deviceId: 'memory',
      events: await this.readAll(),
    };
  }

  async importBundle(bundle: ExportBundle): Promise<{ imported: number; skipped: number }> {
    const existing = await this.readAll();
    const ids = new Set(existing.map((e) => e.id));
    const fresh = bundle.events.filter((e) => !ids.has(e.id));
    const byDomain = new Map<Domain, DomainEvent[]>();
    for (const ev of fresh) {
      const d = domainForEventType(ev.type);
      byDomain.set(d, [...(byDomain.get(d) ?? []), ev]);
    }
    for (const [d, list] of byDomain) await this.append(d, list);
    return { imported: fresh.length, skipped: bundle.events.length - fresh.length };
  }

  private emit(domain: Domain): void {
    for (const l of this.listeners) l(domain);
  }
}
