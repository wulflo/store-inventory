import './ui/styles.css';

import { App } from './app/App';
import { createShell, type Shell } from './ui/app';
import { el, mount } from './ui/dom';
import { toast } from './ui/components/toast';
import { TauriEventStore } from './store/TauriEventStore';
import { MemoryEventStore, WebEventStore } from './store/WebEventStore';
import type { EventStore } from './store/EventStore';
import { seedIfEmpty } from './seed/seed';
import { uuid7 } from './core/ids';
import { applyTheme } from './ui/theme';

import { dashboardView } from './ui/views/dashboard';
import { ordersView } from './ui/views/orders';
import { newOrderView } from './ui/views/orderNew';
import { orderDetailView } from './ui/views/orderDetail';
import { productionView } from './ui/views/production';
import { newProductionView } from './ui/views/productionNew';
import { stockView } from './ui/views/stock';
import { movementsView } from './ui/views/stockMovements';
import { productsView } from './ui/views/products';
import { newProductView } from './ui/views/productNew';
import { customersView, customerDetailView } from './ui/views/customers';
import { expensesView } from './ui/views/expenses';
import { reportsView } from './ui/views/reports';
import { settingsView } from './ui/views/settings';
import { settingsBackupView } from './ui/views/settingsBackup';
import { importCsvView } from './ui/views/importCsv';

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function boot(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) throw new Error('No se encontró #root');

  /* --- Store --- */
  let store: EventStore;
  if (isTauri()) {
    store = new TauriEventStore();
  } else {
    store = new WebEventStore();
  }

  try {
    await store.init();
  } catch (err) {
    console.error('store init falló', err);
    store = new MemoryEventStore();
    await store.init();
    toast('No se pudo acceder al almacenamiento del navegador: los datos NO se van a guardar.', {
      kind: 'error',
      duration: 10000,
    });
  }

  /* --- Desbloqueo del cifrado (antes de proyectar el estado) --- */
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core');
    const storeRoot =
      typeof (store as any).getRoot === 'function'
        ? ((store as TauriEventStore).getRoot() ?? null)
        : null;
    if (storeRoot) {
      const state = await invoke<{
        enabled: boolean;
        unlocked: boolean;
        kid?: string | null;
      }>('crypto_boot_state', { root: storeRoot });
      if (state.enabled && !state.unlocked) {
        const { showUnlockScreen } = await import('./ui/views/unlock');
        await showUnlockScreen(root, storeRoot);
      }
    }
  }

  /* --- Identidad del dispositivo --- */
  const deviceId = await resolveDeviceId(store);

  /* --- App --- */
  const app = new App(store, deviceId);
  await app.init();

  /* --- Datos de demostración (solo si la base está vacía) --- */
  try {
    const seeded = await seedIfEmpty(app);
    if (seeded) {
      console.info('Datos de demostración cargados.');
    }
  } catch (err) {
    console.error('seed falló', err);
  }

  /* --- Tema y acento --- */
  applyTheme(
    app.getSettingJson<string>('theme', localStorage.getItem('theme') ?? 'light'),
    app.getSettingJson<string>('accent', localStorage.getItem('accent') ?? 'blue'),
  );

  /* --- Idioma --- */
  try {
    const { setLanguage } = await import('./core/i18n');
    setLanguage(app.getSettingJson<string>('language', 'es') === 'en' ? 'en' : 'es');
  } catch {
    /* best-effort */
  }

  /* --- Registro del dispositivo --- */
  if (!app.state.devices.has(deviceId)) {
    await app.emit('Device.Registered', {
      deviceId,
      name: deviceName(),
    });
  }

  /* --- Interfaz --- */
  const shell = createShell(root, app);
  registerRoutes(app, shell);
  shell.router.start();

  /* --- Eventos del backend de sincronización --- */
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('sync-updated', () => {
      void app
        .rebuild()
        .then(() => window.dispatchEvent(new CustomEvent('inventario:sync-updated')))
        .catch((err) => console.error('No se pudo recargar tras sincronizar', err));
    });
    await listen('sync-discovery', (event) => {
      window.dispatchEvent(
        new CustomEvent('inventario:sync-discovery', { detail: event.payload }),
      );
      void import('./sync/autoSync').then((mod) => mod.onPeerDiscovered());
    });
    await listen('sync-peers-updated', (event) => {
      window.dispatchEvent(
        new CustomEvent('inventario:sync-peers-updated', { detail: event.payload }),
      );
    });
    await listen('sync-pairing-completed', (event) => {
      window.dispatchEvent(
        new CustomEvent('inventario:sync-pairing-completed', { detail: event.payload }),
      );
    });

    // Auto-sync
    try {
      const { loadConfig, refreshBattery, startAutoSync } = await import('./sync/autoSync');
      (window as any).__storeRoot = (store as TauriEventStore).getRoot();
      await loadConfig();
      await refreshBattery();
      startAutoSync();

      // La app queda visible en la LAN desde el arranque (como Syncthing), sin
      // que el usuario tenga que pulsar "Activar" en Ajustes.
      const { invoke } = await import('@tauri-apps/api/core');
      const currentName =
        app.state.devices.get(deviceId)?.name?.trim() || deviceName();
      invoke('sync_start', { name: currentName }).catch((err) => {
        console.warn('No se pudo iniciar la sincronización automática', err);
      });

      // Auto-backup al abrir si no hay backup de hoy
      const root = (store as TauriEventStore).getRoot();
      if (root) {
        // backup automático respetando modo
        invoke('backup_run_daily', { root, force: false }).catch(() => {});
      }
    } catch (e) {
      console.warn('Auto-sync init falló', e);
    }
  }

  document.getElementById('boot')?.remove();
}

async function resolveDeviceId(store: EventStore): Promise<string> {
  // En Tauri el id vive junto a los datos (así sobrevive a reinstalar la web).
  if (isTauri()) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = (store as TauriEventStore).getRoot();
      if (root) {
        const id = await invoke<string>('store_device_id', { root });
        if (id) return id;
      }
    } catch {
      /* seguimos con el fallback del navegador */
    }
  }

  const KEY = 'inventario.deviceId';
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = uuid7();
    localStorage.setItem(KEY, id);
  }
  return id;
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Celular Android';
  if (/iPhone|iPad/i.test(ua)) return 'Celular iOS';
  if (/Macintosh/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Este equipo';
}

/* ------------------------------------------------------------------ */
/* Rutas                                                               */
/* ------------------------------------------------------------------ */

function registerRoutes(app: App, shell: Shell): void {
  const r = shell.router;

  const show = (build: () => HTMLElement, title?: string, subtitle?: string) => {
    return () => {
      if (title) shell.setTitle(title, subtitle);
      mount(shell.outlet, build());
    };
  };

  r.add('/', show(() => dashboardView(app, shell), 'Inicio', 'Resumen del negocio'));
  r.add('/pedidos', show(() => ordersView(app, shell), 'Pedidos'));
  r.add('/pedidos/nuevo', show(() => newOrderView(app, shell), 'Nuevo pedido'));
  r.add('/pedidos/:id', (params) => {
    shell.setTitle('Pedido');
    mount(shell.outlet, orderDetailView(app, shell, params));
  });
  r.add('/produccion', show(() => productionView(app, shell), 'Producción'));
  r.add('/produccion/nueva', show(() => newProductionView(app, shell), 'Nueva orden de producción'));
  r.add('/stock', show(() => stockView(app, shell), 'Stock'));
  r.add('/stock/movimientos', show(() => movementsView(app, shell), 'Movimientos de stock'));
  r.add('/productos', show(() => productsView(app, shell), 'Catálogo'));
  r.add('/productos/nuevo', show(() => newProductView(app, shell), 'Nuevo producto'));
  r.add('/clientes', show(() => customersView(app, shell), 'Clientes'));
  r.add('/clientes/:id', (params) => {
    shell.setTitle('Cliente');
    mount(shell.outlet, customerDetailView(app, shell, params));
  });
  r.add('/gastos', show(() => expensesView(app, shell), 'Gastos'));
  r.add('/reportes', show(() => reportsView(app, shell), 'Reportes'));
  r.add('/ajustes', show(() => settingsView(app, shell), 'Ajustes'));
  r.add('/importar', show(() => importCsvView(app, shell), 'Importar datos'));
  r.add('/respaldos', () => {
    const store = (app as any).store;
    shell.setTitle('Respaldos diarios');
    if (store && typeof store.getRoot === 'function') {
      const elHost = el('div');
      mount(shell.outlet, elHost);
      settingsBackupView(elHost, store);
      return;
    }
    mount(shell.outlet, settingsView(app, shell));
  });

  r.notFound(() => {
    shell.setTitle('No encontrado');
    mount(
      shell.outlet,
      el(
        'div',
        { class: 'card' },
        el('h2', { text: 'No encontramos esa pantalla' }),
        el('p', { class: 'muted mt-2', text: 'Volvé al inicio para seguir.' }),
        el(
          'button',
          {
            class: 'btn btn-primary mt-4',
            type: 'button',
            text: 'Ir al inicio',
            on: { click: () => shell.router.navigate('/') },
          },
        ),
      ),
    );
  });
}

/* ------------------------------------------------------------------ */

boot().catch((err) => {
  console.error(err);
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.innerHTML = '';
    const box = document.createElement('div');
    box.style.padding = '24px';
    box.style.textAlign = 'center';
    box.innerHTML =
      '<h2>No se pudo iniciar la aplicación</h2><p style="margin-top:8px"></p>';
    const p = box.querySelector('p');
    if (p) p.textContent = err instanceof Error ? err.message : String(err);
    bootEl.appendChild(box);
  }
});
