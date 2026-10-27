import type { Domain, DomainEvent } from '../core/types';

/**
 * Contrato del almacenamiento de eventos.
 *
 * Implementaciones:
 *  - `TauriEventStore` : archivos .jsonl en una carpeta del disco (desktop/móvil nativo).
 *  - `WebEventStore`    : OPFS / IndexedDB (modo navegador, para desarrollo y tests).
 *
 * Garantías que debe cumplir cualquier implementación:
 *  1. `append` solo AGREGA líneas al final. Nunca reescribe historia.
 *  2. `read` puede devolver líneas parciales si el proceso murió a mitad de
 *     escritura: el lector debe descartar la última línea inválida.
 *  3. `read` no garantiza orden. El consumidor ordena por `metadata.hlc`.
 */
export interface EventStore {
  /** Nombre legible del backend ("Disco", "Navegador", "Memoria"). */
  readonly kind: 'tauri' | 'web' | 'memory';

  /** Prepara el store. Idempotente. */
  init(): Promise<void>;

  /** Agrega eventos a un dominio. */
  append(domain: Domain, events: DomainEvent[]): Promise<void>;

  /** Lee todos los eventos de un dominio (ordenados por HLC). */
  read(domain: Domain): Promise<DomainEvent[]>;

  /** Lee todos los dominios. */
  readAll(): Promise<DomainEvent[]>;

  /** Notifica cuando cambia el contenido de un dominio (para sync externo). */
  watch(callback: (domain: Domain) => void): Promise<void>;

  /** Deja de observar. */
  unwatch(): Promise<void>;

  /** Ruta/base legible del backing store (para mostrar en Ajustes). */
  location(): string;

  /** Exporta todo como un JSON serializable. */
  exportAll(): Promise<ExportBundle>;

  /** Importa un bundle exportado (merge por eventId: ignora duplicados). */
  importBundle(bundle: ExportBundle): Promise<{ imported: number; skipped: number }>;

  /** Borra todos los eventos persistidos (deja el store vacío). */
  clearAll(): Promise<void>;
}

export interface ExportBundle {
  format: 'inventario-tienda/events';
  version: number;
  exportedAt: number;
  deviceId: string;
  events: DomainEvent[];
}

/** Nombre de archivo para un dominio. */
export function domainFile(domain: Domain): string {
  return `${domain}.jsonl`;
}

/** Ordena eventos por HLC y luego por eventId (desempate determinista). */
export function sortEvents(events: DomainEvent[]): DomainEvent[] {
  return [...events].sort((a, b) => {
    if (a.metadata.hlc !== b.metadata.hlc) return a.metadata.hlc - b.metadata.hlc;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Dedup por eventId, conservando el primero (el que tenga mayor HLC si hay conflicto). */
export function dedupeEvents(events: DomainEvent[]): DomainEvent[] {
  const byId = new Map<string, DomainEvent>();
  for (const e of events) {
    const prev = byId.get(e.id);
    if (!prev) {
      byId.set(e.id, e);
    } else if (e.metadata.hlc > prev.metadata.hlc) {
      byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

/** Parsea una línea JSONL. Devuelve null si está corrupta (línea parcial). */
export function parseEventLine(line: string): DomainEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') return null;
    if (!parsed.metadata || typeof parsed.metadata.hlc !== 'number') return null;
    return parsed as DomainEvent;
  } catch {
    return null;
  }
}

/** Serializa eventos a líneas JSONL (sin salto final, se agrega al escribir). */
export function serializeEvents(events: DomainEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join('\n');
}
