import { afterEach, describe, expect, it } from 'vitest';
import { WebEventStore } from '../src/store/WebEventStore';
import type { DomainEvent } from '../src/core/types';

/**
 * Regresión: `WebEventStore.append` usaba `createWritable()` sin
 * `keepExistingData`, así que cada escritura truncaba el .jsonl y se perdía
 * todo el historial anterior. Estos tests simulan OPFS en memoria.
 */

class FakeFile {
  data = new Uint8Array();

  get size(): number {
    return this.data.length;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }
}

class FakeFileHandle {
  readonly file = new FakeFile();

  async getFile(): Promise<{ size: number; text: () => Promise<string> }> {
    return { size: this.file.size, text: () => this.file.text() };
  }

  async createWritable(options?: { keepExistingData?: boolean }) {
    const file = this.file;
    let buffer = options?.keepExistingData ? new Uint8Array(file.data) : new Uint8Array();

    return {
      async write(chunk: string | { type: 'write'; position: number; data: string }) {
        const text = typeof chunk === 'string' ? chunk : chunk.data;
        const start = typeof chunk === 'string' ? buffer.length : chunk.position;
        const bytes = new TextEncoder().encode(text);
        const needed = start + bytes.length;
        if (needed > buffer.length) {
          const next = new Uint8Array(needed);
          next.set(buffer);
          buffer = next;
        }
        buffer.set(bytes, start);
        file.data = buffer;
      },
      async close() {},
    };
  }
}

class FakeDirectory {
  files = new Map<string, FakeFileHandle>();

  async getDirectoryHandle(_name: string, _options?: { create?: boolean }) {
    return this;
  }

  async getFileHandle(name: string, _options?: { create?: boolean }) {
    let handle = this.files.get(name);
    if (!handle) {
      handle = new FakeFileHandle();
      this.files.set(name, handle);
    }
    return handle;
  }
}

function event(n: number): DomainEvent {
  return {
    id: `evt-${n}`,
    type: 'Customer.Created',
    aggregateId: `customer-${n}`,
    payload: { name: `Cliente ${n}` },
    metadata: {
      deviceId: 'test-device',
      hlc: n,
      seq: n,
      wallMs: n,
    },
  } as unknown as DomainEvent;
}

const originalNavigator = globalThis.navigator;

afterEach(() => {
  Object.defineProperty(globalThis, 'navigator', {
    value: originalNavigator,
    configurable: true,
  });
});

function useFakeOpfs(): FakeDirectory {
  const directory = new FakeDirectory();
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage: { getDirectory: async () => directory } },
    configurable: true,
  });
  return directory;
}

describe('WebEventStore', () => {
  it('conserva los eventos anteriores al hacer append', async () => {
    const dir = useFakeOpfs();
    const store = new WebEventStore();
    await store.init();

    await store.append('customers', [event(1)]);
    await store.append('customers', [event(2)]);
    await store.append('customers', [event(3)]);

    const stored = await store.read('customers');
    expect(stored.map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);

    const file = dir.files.get('customers.jsonl');
    expect(file).toBeDefined();
    expect((await file!.file.text()).split('\n').filter(Boolean)).toHaveLength(3);
  });

  it('agrega un lote completo sin pisar lo previo', async () => {
    useFakeOpfs();
    const store = new WebEventStore();
    await store.init();

    await store.append('orders', [event(1)]);
    await store.append('orders', [event(2), event(3)]);

    expect((await store.read('orders')).map((e) => e.id)).toEqual(['evt-1', 'evt-2', 'evt-3']);
  });

  it('repair es no-op en OPFS y no altera los eventos', async () => {
    useFakeOpfs();
    const store = new WebEventStore();
    await store.init();
    await store.append('customers', [event(1)]);

    const report = await store.repair();

    expect(report).toMatchObject({ repaired: 0, pending: 0, stale: 0, errors: [] });
    expect((await store.read('customers')).map((e) => e.id)).toEqual(['evt-1']);
  });
});
