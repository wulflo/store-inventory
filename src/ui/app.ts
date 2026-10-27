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

  // ---- Bottom nav (mobile) ----
  const bottomButtons = new Map<string, HTMLElement>();
  const bottomNav = el('nav', { class: 'bottom-nav', 'aria-label': 'Navegación principal' });
  const mobileItems = NAV_ITEMS.filter((i) => i.primary);
  for (const item of mobileItems) {
    const btn = el(
      'button',
      {
        type: 'button',
        dataset: { path: item.path },
        on: {
          click: () => router.navigate(item.path),
        },
      },
      icon(item.icon, 22),
      el('span', { text: item.label }),
    );
    bottomButtons.set(item.path, btn);
    bottomNav.appendChild(btn);
  }
  const moreBtn = el(
    'button',
    {
      type: 'button',
      on: {
        click: () => {
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
              ...NAV_ITEMS.filter((i) => !i.primary).map((item) =>
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
        },
      },
    },
    icon('menu', 22),
    el('span', { text: 'Menú' }),
  );
  bottomNav.appendChild(moreBtn);

  const main = el('div', { class: 'main' }, topbar, outlet);
  mount(root, el('div', { class: 'layout' }, sidebar, main), bottomNav);

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
    // El botón "Más" queda activo en las pantallas que no están en la barra inferior.
    const inBottomNav = mobileItems.some((i) => i.path === best);
    moreBtn.classList.toggle('active', best !== '' && !inBottomNav);
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

  app.subscribe((event) => {
    if (event.type === 'state') refresh();
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
