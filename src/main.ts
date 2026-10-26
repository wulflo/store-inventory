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

  /* --- Tema --- */
  applyTheme(app.getSetting('theme') ?? localStorage.getItem('theme') ?? 'light');

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

function applyTheme(theme: string): void {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  localStorage.setItem('theme', value);
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
