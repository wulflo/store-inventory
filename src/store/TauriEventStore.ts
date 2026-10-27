import type { Domain, DomainEvent } from '../core/types';
import {
  type EventStore,
  type ExportBundle,
  dedupeEvents,
  domainFile,
  parseEventLine,
  serializeEvents,
  sortEvents,
} from './EventStore';

/**
 * Store respaldado por archivos .jsonl en el sistema de archivos.
 * Se usa dentro de Tauri (desktop y móvil nativo).
 *
 * Escribe vía `invoke` a comandos Rust que hacen append real al archivo.
 */
export class TauriEventStore implements EventStore {
  readonly kind = 'tauri' as const;

  private root: string | null = null;
  private listeners: Array<(domain: Domain) => void> = [];
  private pollTimer: number | null = null;
  private lastSeen: Map<string, number> = new Map();

  constructor(private rootPath?: string) {}

  async init(): Promise<void> {
    if (!this.root) {
      this.root = this.rootPath ?? (await this.invoke<string>('store_default_root'));
    }
    await this.invoke<void>('store_ensure_layout', { root: this.root });
    this.startPolling();
  }

  setRoot(root: string): void {
    this.root = root;
  }

  getRoot(): string | null {
    return this.root;
  }

  async append(domain: Domain, events: DomainEvent[]): Promise<void> {
    if (!this.root) throw new Error('Store no inicializado');
    if (events.length === 0) return;
    const lines = serializeEvents(events)
      .split('\n')
      .filter((l) => l.length > 0);
    await this.invoke<void>('store_append', {
      root: this.root,
      domain,
      lines,
    });
    this.lastSeen.set(domain, Date.now());
    this.emit(domain);
    // Disparar sync automático (debounce)
    try {
      const { onStoreAppended } = await import('../sync/autoSync');
      onStoreAppended();
    } catch {
      // ignore
    }
  }

  async read(domain: Domain): Promise<DomainEvent[]> {
    if (!this.root) return [];
    const raw = await this.invoke<string>('store_read', { root: this.root, domain });
    const events: DomainEvent[] = [];
    for (const line of raw.split('\n')) {
      const ev = parseEventLine(line);
      if (ev) events.push(ev);
    }
    return sortEvents(events);
  }

  async readAll(): Promise<DomainEvent[]> {
    const all: DomainEvent[] = [];
    for (const domain of DOMAIN_LIST) {
      all.push(...(await this.read(domain)));
    }
    return sortEvents(all);
  }

  async watch(callback: (domain: Domain) => void): Promise<void> {
    this.listeners.push(callback);
  }

  async unwatch(): Promise<void> {
    this.listeners = [];
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  location(): string {
    return this.root ?? '(sin carpeta)';
  }

  async exportAll(): Promise<ExportBundle> {
    const events = await this.readAll();
    const deviceId = await this.invoke<string>('store_device_id', { root: this.root! });
    return {
      format: 'inventario-tienda/events',
      version: 1,
      exportedAt: Date.now(),
      deviceId,
      events,
    };
  }

  async importBundle(bundle: ExportBundle): Promise<{ imported: number; skipped: number }> {
    const existing = await this.readAll();
    const existingIds = new Set(existing.map((e) => e.id));
    const toImport = bundle.events.filter((e) => !existingIds.has(e.id));
    const skipped = bundle.events.length - toImport.length;

    // Agrupar por dominio según el prefijo del tipo de evento.
    const byDomain = new Map<Domain, DomainEvent[]>();
    for (const ev of toImport) {
      const domain = domainForEventType(ev.type);
      const list = byDomain.get(domain) ?? [];
      list.push(ev);
      byDomain.set(domain, list);
    }
    for (const [domain, list] of byDomain) {
      await this.append(domain, list);
    }
    return { imported: toImport.length, skipped };
  }

  /* ---------------------------------------------------------------- */
  /* Observación de cambios externos (Syncthing/Drive)                 */
  /* ---------------------------------------------------------------- */

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(async () => {
      if (!this.root) return;
      try {
        const stamps = await this.invoke<Record<string, number>>('store_mtimes', { root: this.root });
        for (const [domain, mtime] of Object.entries(stamps)) {
          const prev = this.lastSeen.get(domain);
          if (prev !== undefined && mtime > prev) {
            this.lastSeen.set(domain, mtime);
            this.emit(domain as Domain);
          } else if (prev === undefined) {
            this.lastSeen.set(domain, mtime);
          }
        }
      } catch {
        /* la carpeta puede estar brevemente inaccesible (sync en curso) */
      }
    }, 3000);
  }

  private emit(domain: Domain): void {
    for (const l of this.listeners) {
      try {
        l(domain);
      } catch (err) {
        console.error('watcher error', err);
      }
    }
  }

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(cmd, args);
  }
}

/* ------------------------------------------------------------------ */

export const DOMAIN_LIST: Domain[] = [
  'collections',
  'products',
  'colors',
  'variants',
  'customers',
  'orders',
  'order_lines',
  'payments',
  'production_orders',
  'production_lines',
  'stock_movements',
  'expenses',
  'settings',
  'device_info',
];

/** Mapea el prefijo del tipo de evento al dominio (archivo) correspondiente. */
export function domainForEventType(type: string): Domain {
  const prefix = type.split('.')[0];
  switch (prefix) {
    case 'Collection':
      return 'collections';
    case 'Product':
      return 'products';
    case 'Color':
      return 'colors';
    case 'Variant':
      return 'variants';
    case 'Customer':
      return 'customers';
    case 'Order':
      return 'orders';
    case 'OrderLine':
      return 'order_lines';
    case 'Payment':
      return 'payments';
    case 'ProductionOrder':
      return 'production_orders';
    case 'ProductionLine':
      return 'production_lines';
    case 'Stock':
      return 'stock_movements';
    case 'Expense':
      return 'expenses';
    case 'Setting':
      return 'settings';
    case 'Device':
      return 'device_info';
    default:
      return 'settings';
  }
}

export { dedupeEvents, domainFile, parseEventLine, serializeEvents, sortEvents };
