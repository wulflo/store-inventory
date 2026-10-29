import type { Domain, DomainEvent } from '../core/types';
import { scheduleLonglifeSnapshot } from '../core/longlifeSnapshots';
import {
  type EventStore,
  type ExportBundle,
  type RepairReport,
  dedupeEvents,
  domainFile,
  parseEventLine,
  serializeEvents,
  sortEvents,
} from './EventStore';

interface FileFingerprint {
  size: number;
  mtime: number | null;
}

const EMPTY_REPAIR: RepairReport = {
  repaired: 0,
  pending: 0,
  stale: 0,
  checked: 0,
  journalPath: null,
  errors: [],
};

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
  /** Huella (tamaño + mtime) por dominio, para detectar cambios externos. */
  private lastFingerprints: Map<string, string> = new Map();
  /** El primer chequeo solo llena la línea base; no dispara recargas. */
  private pollInitialized = false;

  constructor(private rootPath?: string) {}

  async init(): Promise<void> {
    if (!this.root) {
      this.root = this.rootPath ?? (await this.invoke<string>('store_default_root'));
    }
    await this.invoke<void>('store_ensure_layout', { root: this.root });
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
    // Registrar la huella de nuestra propia escritura para que el poller no la
    // confunda con un cambio externo. No se emite al watcher: `App.emit` ya
    // aplicó el evento de forma optimista y una recarga completa aquí podría
    // pisar una edición concurrente.
    await this.rememberFingerprints(domain);
    scheduleLonglifeSnapshot();
  }

  async read(domain: Domain): Promise<DomainEvent[]> {
    if (!this.root) return [];
    const raw = await this.invoke<string>('store_read', { root: this.root, domain });
    const events: DomainEvent[] = [];
    const seen = new Set<string>();
    for (const line of raw.split('\n')) {
      const ev = parseEventLine(line);
      // Un mismo evento puede aparecer duplicado si se fusionó una bóveda
      // cifrada (mismo id, distinto nonce). Se aplica una sola vez.
      if (ev && !seen.has(ev.id)) {
        seen.add(ev.id);
        events.push(ev);
      }
    }
    return sortEvents(events);
  }

  async readAll(): Promise<DomainEvent[]> {
    const all: DomainEvent[] = [];
    const seen = new Set<string>();
    for (const domain of DOMAIN_LIST) {
      for (const ev of await this.read(domain)) {
        if (!seen.has(ev.id)) {
          seen.add(ev.id);
          all.push(ev);
        }
      }
    }
    return sortEvents(all);
  }

  async watch(callback: (domain: Domain) => void): Promise<void> {
    this.listeners.push(callback);
    // Arrancar el poller recién ahora: `App.init` ya reparó y leyó la bóveda,
    // así que las huellas iniciales están registradas y el primer chequeo no
    // se confunde con un cambio externo.
    this.startPolling();
  }

  async unwatch(): Promise<void> {
    this.listeners = [];
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  location(): string {
    if (!this.root) return '(sin carpeta)';
    if (this.root.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(this.root) as { topTreeUri?: string };
        if (parsed?.topTreeUri) return 'Bóveda SAF (omega)';
      } catch {
        /* La ruta local puede empezar con `{` por casualidad. */
      }
    }
    return this.root;
  }

  async exportAll(): Promise<ExportBundle> {
    // Exportamos las líneas tal como están en disco. Con el cifrado activo el
    // payload viaja cifrado; el archivo no se puede leer sin el llavero.
    const raw = await this.invoke<DomainEvent[]>('store_export_raw', { root: this.root! });
    const deviceId = await this.invoke<string>('installation_device_id');
    return {
      format: 'inventario-tienda/events',
      version: 1,
      exportedAt: Date.now(),
      deviceId,
      events: sortEvents(dedupeEvents(raw)),
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

  async clearAll(): Promise<void> {
    if (!this.root) return;
    // Antes de vaciar, actualizamos la copia longlife del día para conservar
    // el estado actual. Si este paso falla, no se borra nada.
    try {
      await this.invoke<void>('longlife_run', { refresh: true });
    } catch (err) {
      throw new Error(
        `No se pudo guardar la copia longlife previa al vaciado: ${
          err instanceof Error ? err.message : String(err)
        }. No se borró ningún dato.`,
      );
    }
    await this.invoke<void>('store_clear', { root: this.root });
    this.lastFingerprints.clear();
    // No se programa un snapshot después del borrado: el refresco automático
    // no debe reemplazar la copia del día con un estado vacío.
  }

  /* ---------------------------------------------------------------- */
  /* Observación de cambios externos en la carpeta                     */
  /* ---------------------------------------------------------------- */

  private startPolling(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = window.setInterval(async () => {
      if (!this.root) return;
      try {
        const stamps = await this.invoke<Record<string, FileFingerprint>>(
          'store_fingerprints',
          { root: this.root },
        );
        const changed: Domain[] = [];
        const seen = new Set<string>();
        for (const [domain, fp] of Object.entries(stamps)) {
          seen.add(domain);
          const key = JSON.stringify(fp);
          const prev = this.lastFingerprints.get(domain);
          // `undefined` = archivo nuevo: también es un cambio que hay que leer.
          if (prev !== key && this.pollInitialized) changed.push(domain as Domain);
          this.lastFingerprints.set(domain, key);
        }
        // Un dominio que desapareció también es un cambio: el agente pudo
        // reemplazar el archivo por una versión anterior.
        for (const domain of [...this.lastFingerprints.keys()]) {
          if (!seen.has(domain)) {
            if (this.pollInitialized) changed.push(domain as Domain);
            this.lastFingerprints.delete(domain);
          }
        }
        this.pollInitialized = true;
        for (const domain of changed) this.emit(domain);
      } catch {
        /* la carpeta puede estar brevemente inaccesible (otra app escribiendo) */
      }
    }, 3000);
  }

  /**
   * Compara el diario local con la bóveda y re-agrega lo que falte.
   *
   * Se llama al arrancar y cada vez que el poller detecta un cambio externo.
   * También refresca las huellas para que la propia reparación no se lea como
   * un cambio externo.
   */
  async repair(): Promise<RepairReport> {
    if (!this.root) return { ...EMPTY_REPAIR };
    try {
      const report = await this.invoke<RepairReport>('journal_repair', { root: this.root });
      // Si se recuperaron eventos, programar una copia longlife para que el
      // estado reparado quede respaldado.
      if (report.repaired > 0) scheduleLonglifeSnapshot();
      return report;
    } finally {
      // Aunque la reparación falle (por ejemplo, bóveda bloqueada), registrar
      // las huellas evita que el poller entre en un bucle de recargas.
      await this.rememberFingerprints();
    }
  }

  private async rememberFingerprints(domain?: Domain): Promise<void> {
    if (!this.root) return;
    try {
      const stamps = await this.invoke<Record<string, FileFingerprint>>(
        'store_fingerprints',
        { root: this.root },
      );
      if (domain) {
        const fp = stamps[domain];
        if (fp) this.lastFingerprints.set(domain, JSON.stringify(fp));
        else this.lastFingerprints.delete(domain);
        return;
      }
      this.lastFingerprints.clear();
      for (const [name, fp] of Object.entries(stamps)) {
        this.lastFingerprints.set(name, JSON.stringify(fp));
      }
    } catch {
      /* best effort: el próximo poll vuelve a intentar */
    }
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
