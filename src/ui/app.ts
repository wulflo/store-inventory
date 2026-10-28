import { el, icon, mount } from './dom';
import { Router } from './router';
import { toast } from './components/toast';
import type { App } from '../app/App';
import { dashboard } from '../projection/queries';
import { applyTheme } from './theme';

export interface NavItem {
  path: string;
  label: string;
  icon: string;
  /** Solo en bottom nav (mobile). */
  primary?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { path: '/', label: 'Inicio', icon: 'home', primary: true },
  { path: '/pedidos', label: 'Pedidos', icon: 'orders', primary: true },
  { path: '/produccion', label: 'Producción', icon: 'production', primary: true },
  { path: '/stock', label: 'Stock', icon: 'stock', primary: true },
  { path: '/productos', label: 'Catálogo', icon: 'products' },
  { path: '/clientes', label: 'Clientes', icon: 'customers' },
  { path: '/gastos', label: 'Gastos', icon: 'money' },
  { path: '/reportes', label: 'Reportes', icon: 'reports' },
  { path: '/ajustes', label: 'Ajustes', icon: 'settings' },
];

export interface Shell {
  router: Router;
  outlet: HTMLElement;
  setTitle: (title: string, subtitle?: string) => void;
  refresh: () => void;
}

export function createShell(root: HTMLElement, app: App): Shell {
  const outlet = el('div', { class: 'content', id: 'view' });

  const titleEl = el('h1', { text: 'Inventario' });
  const subtitleEl = el('div', { class: 'sub small dim', style: { display: 'none' } });

  const themeBtn = el('button', {
    class: 'btn-icon',
    type: 'button',
    'aria-label': 'Cambiar tema',
    title: 'Cambiar tema claro/oscuro',
  });

  const refresh = () => {
    const d = dashboard(app.state);
    const badge = sidebar.querySelector<HTMLElement>('[data-badge="orders"]');
    if (badge) {
      const n = d.pendingOrdersCount;
      badge.textContent = String(n);
      badge.style.display = n > 0 ? '' : 'none';
    }
  };

  function applyThemeIcon() {
    mount(themeBtn, icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 20));
  }

  themeBtn.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next, document.documentElement.dataset.accent ?? 'blue');
    void app.setSetting('theme', next);
  });

  // El selector de Ajustes y este botón comparten el mismo estado visual.
  document.addEventListener('inventario:themechange', applyThemeIcon);

  const topbar = el(
    'header',
    { class: 'topbar' },
    el('div', { class: 'grow', style: { minWidth: '0' } }, titleEl, subtitleEl),
    el(
      'div',
      { class: 'topbar-actions' },
      el(
        'button',
        {
          class: 'btn-icon topbar-menu',
          type: 'button',
          'aria-label': 'Menú',
          title: 'Menú',
          on: { click: () => openDrawer() },
        },
        icon('menu', 20),
      ),
      el(
        'button',
        {
          class: 'btn btn-primary btn-sm topbar-new',
          type: 'button',
          on: {
            click: () => {
              router.navigate('/pedidos/nuevo');
            },
          },
        },
        icon('plus', 18),
        el('span', { text: 'Pedido' }),
      ),
      themeBtn,
    ),
  );

  // ---- Sidebar (desktop) ----
  const navButtons = new Map<string, HTMLElement>();
  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el(
      'div',
      { class: 'brand' },
      el('div', { class: 'brand-mark', text: 'IT' }),
      el(
        'div',
        {},
        el('div', { class: 'brand-name', text: 'Inventario' }),
        el('div', { class: 'brand-sub', text: 'Indumentaria' }),
      ),
    ),
  );

  for (const item of NAV_ITEMS) {
    const badge =
      item.path === '/pedidos'
        ? el('span', {
            class: 'badge badge-count',
            dataset: { badge: 'orders' },
            text: '0',
            style: { display: 'none' },
          })
        : null;
    const btn = el(
      'button',
      {
        class: 'nav-link',
        type: 'button',
        dataset: { path: item.path },
        on: {
          click: () => router.navigate(item.path),
        },
      },
      icon(item.icon, 20),
      el('span', { text: item.label }),
      badge,
    );
    navButtons.set(item.path, btn);
    sidebar.appendChild(btn);
  }

  sidebar.appendChild(el('div', { style: { flex: '1' } }));
  const importBtn = el(
    'button',
    {
      class: 'nav-link',
      type: 'button',
      dataset: { path: '/importar' },
      on: {
        click: () => router.navigate('/importar'),
      },
    },
    icon('upload', 20),
    el('span', { text: 'Importar datos' }),
  );
  navButtons.set('/importar', importBtn);
  sidebar.appendChild(importBtn);

  // ---- Drawer (mobile) con todas las funciones ----
  const bottomButtons = new Map<string, HTMLElement>();

  function openDrawer(): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'drawer-backdrop';
    const drawer = el(
      'aside',
      { class: 'drawer' },
      el(
        'div',
        { class: 'drawer-head' },
        el('h3', { text: 'Menú', style: { margin: '0' } }),
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            on: { click: () => backdrop.remove() },
          },
          icon('x', 20),
        ),
      ),
      el(
        'nav',
        { class: 'drawer-nav' },
        ...NAV_ITEMS.map((item) =>
          el(
            'button',
            {
              class: 'nav-link',
              type: 'button',
              on: {
                click: () => {
                  backdrop.remove();
                  router.navigate(item.path);
                },
              },
            },
            icon(item.icon, 20),
            el('span', { text: item.label }),
          ),
        ),
        el(
          'button',
          {
            class: 'nav-link',
            type: 'button',
            on: {
              click: () => {
                backdrop.remove();
                router.navigate('/importar');
              },
            },
          },
          icon('upload', 20),
          el('span', { text: 'Importar datos' }),
        ),
      ),
    );
    backdrop.appendChild(drawer);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('open'));
  }

  const main = el('div', { class: 'main' }, topbar, outlet);
  mount(root, el('div', { class: 'layout' }, sidebar, main));

  applyThemeIcon();

  const router = new Router(outlet);

  function setActive(path: string) {
    // Resuelve el prefijo más largo para "/pedidos/nuevo" -> "/pedidos"
    let best = '';
    for (const key of navButtons.keys()) {
      if (path === key || path.startsWith(`${key}/`)) {
        if (key.length > best.length) best = key;
      }
    }
    for (const [key, btn] of navButtons) btn.classList.toggle('active', key === best);
    for (const [key, btn] of bottomButtons) btn.classList.toggle('active', key === best);
  }

  const originalResolve = router.resolve.bind(router);
  router.resolve = async () => {
    await originalResolve();
    setActive(router.currentPath());
  };

  // ---- Atajos de teclado globales ----
  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target.isContentEditable;
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

    const map: Record<string, string> = {
      n: '/pedidos/nuevo',
      p: '/produccion',
      s: '/stock',
      c: '/clientes',
      i: '/importar',
      g: '/gastos',
      r: '/reportes',
      a: '/ajustes',
    };
    const dest = map[e.key.toLowerCase()];
    if (dest) {
      e.preventDefault();
      router.navigate(dest);
    }
  });

  function isUserEditing(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return (
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLSelectElement ||
      !!active?.isContentEditable ||
      !!document.querySelector('.modal-backdrop')
    );
  }

  // Cuando un cambio externo modifica el estado, la vista actual seguía
  // mostrando datos viejos hasta navegar a otra sección. La repintamos sin
  // cambiar de ruta ni el scroll. Si el usuario está escribiendo o hay un
  // modal abierto, esperamos a que termine para no perder lo que ingresó.
  let pendingViewRefresh = false;
  let viewRefreshTimer: number | null = null;

  function requestViewRefresh(): void {
    if (isUserEditing()) {
      pendingViewRefresh = true;
      return;
    }
    pendingViewRefresh = false;
    const path = router.currentPath();
    // Ajustes e importación manejan sus propios eventos y formularios largos.
    if (
      path.startsWith('/ajustes') ||
      path === '/importar' ||
      path.endsWith('/nuevo') ||
      path.includes('/editar')
    ) {
      return;
    }
    if (viewRefreshTimer !== null) window.clearTimeout(viewRefreshTimer);
    viewRefreshTimer = window.setTimeout(() => {
      viewRefreshTimer = null;
      void router.reload();
    }, 80);
  }

  document.addEventListener('focusout', () => {
    if (!pendingViewRefresh || isUserEditing()) return;
    window.setTimeout(() => {
      if (!isUserEditing()) requestViewRefresh();
    }, 0);
  });

  app.subscribe((event) => {
    if (event.type === 'state') {
      refresh();
      if (event.reason === 'rebuild' || event.reason.startsWith('external:')) {
        requestViewRefresh();
      }
    }
    if (event.type === 'error') toast(event.message, { kind: 'error' });
  });

  /* FAB de acción principal (Material Design 3). En compacto es el punto
     de entrada principal; en medio/expandido coexiste con el topbar. */
  const fab = el(
    'button',
    {
      class: 'fab',
      type: 'button',
      'aria-label': 'Nuevo pedido',
      on: {
        click: () => router.navigate('/pedidos/nuevo'),
      },
    },
    icon('plus', 20),
    'Pedido',
  );
  document.body.appendChild(fab);

  // El FAB "Pedido" solo tiene sentido en las vistas de trabajo. En ajustes,
  // copias, importación o reportes tapaba botones y contenido.
  const fabHiddenPrefixes = ['/ajustes', '/respaldos', '/longlife', '/importar', '/reportes'];
  const updateFabVisibility = () => {
    const path = router.currentPath();
    fab.style.display = fabHiddenPrefixes.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
      ? 'none'
      : '';
  };
  window.addEventListener('hashchange', updateFabVisibility);
  updateFabVisibility();

  return {
    router,
    outlet,
    setTitle(title: string, subtitle?: string) {
      titleEl.textContent = title;
      if (subtitle) {
        subtitleEl.textContent = subtitle;
        subtitleEl.style.display = '';
      } else {
        subtitleEl.style.display = 'none';
      }
    },
    refresh,
  };
}
