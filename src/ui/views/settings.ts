import { el, icon } from '../dom';
import { card, emptyState, money } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { formatDateTime } from '../../core/dates';
import { showError, toastSuccess } from '../components/toast';
import { confirmDialog, openModal } from '../components/modal';
import { CURRENCIES } from '../../core/money';
import { APP_VERSION } from '../../core/version';
import { invoke } from '@tauri-apps/api/core';

export function settingsView(app: App, shell: Shell): HTMLElement {
  const view = el('div');

  /* ---------------- Datos ---------------- */
  view.appendChild(
    card({
      title: 'Dispositivo',
      content: el(
        'div',
        {},
        infoRow('Identificador', app.deviceId),
        infoRow('Almacenamiento', app.store.location()),
        infoRow('Tipo de backing store', kindLabel(app.store.kind)),
        infoRow('Eventos en la base', String(app.state.eventCount)),
        infoRow('Último HLC', String(app.state.lastHlc)),
        infoRow('Dispositivos conocidos', String(app.state.devices.size)),
      ),
    }),
  );

  /* ---------------- Preferencias ---------------- */
  const currencySelect = el(
    'select',
    {
      on: {
        change: async () => {
          try {
            await app.setSetting('currency', currencySelect.value);
            toastSuccess('Moneda actualizada.');
          } catch (err) {
            showError(err);
          }
        },
      },
    },
    ...Object.values(CURRENCIES).map((c) =>
      el('option', {
        value: c.code,
        text: `${c.code} (${c.symbol})`,
        selected: app.getSetting('currency') === c.code,
      }),
    ),
  );

  view.appendChild(
    card({
      title: 'Preferencias',
      content: el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Moneda' }), currencySelect),
        el(
          'div',
          { class: 'field' },
          el('label', { text: 'Tema' }),
          el(
            'div',
            { class: 'row', style: { gap: '8px' } },
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: 'Claro',
              on: {
                click: () => {
                  document.documentElement.dataset.theme = 'light';
                  localStorage.setItem('theme', 'light');
                  void app.setSetting('theme', 'light');
                },
              },
            }),
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              text: 'Oscuro',
              on: {
                click: () => {
                  document.documentElement.dataset.theme = 'dark';
                  localStorage.setItem('theme', 'dark');
                  void app.setSetting('theme', 'dark');
                },
              },
            }),
          ),
        ),
      ),
    }),
  );

  /* ---------------- Datos y respaldo ---------------- */
  view.appendChild(
    card({
      title: 'Datos y respaldo',
      content: el(
        'div',
        {},
        el('p', {
          class: 'muted mb-4',
          text: 'Tus datos viven en archivos .jsonl (append-only) dentro de una carpeta común. Podés copiar esa carpeta a un disco externo o a un servicio de sincronización: nunca se corrompe.',
        }),
        el(
          'div',
          { class: 'btn-group' },
          el('button', {
            class: 'btn',
            type: 'button',
            on: { click: () => void exportBackup(app) },
          }, icon('download', 18), 'Exportar copia (.json)'),
          el('button', {
            class: 'btn',
            type: 'button',
            on: { click: () => void importBackup(app, shell) },
          }, icon('upload', 18), 'Restaurar / importar'),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            on: { click: () => shell.router.navigate('/importar') },
          }, icon('orders', 18), 'Importar CSV'),
        ),
      ),
    }),
  );

  /* ---------------- Dispositivos conocidos ---------------- */
  const devices = [...app.state.devices.values()];
  view.appendChild(
    card({
      title: 'Dispositivos',
      count: devices.length,
      content:
        devices.length === 0
          ? emptyState({
              icon: 'settings',
              title: 'Sin otros dispositivos',
              message: 'Cuando sincronices con el celular, aparecerán acá.',
            })
          : el(
              'div',
              { class: 'list' },
              ...devices.map((d) =>
                el(
                  'div',
                  { class: 'list-item', style: { cursor: 'default' } },
                  el(
                    'div',
                    { class: 'list-item-main' },
                    el('div', { class: 'list-item-title', text: d.name }),
                    el('div', { class: 'list-item-sub', text: d.id }),
                  ),
                  el('div', {
                    class: 'list-item-value xsmall dim',
                    text: formatDateTime(d.createdAt),
                  }),
                ),
              ),
            ),
    }),
  );

  /* ---------------- Zona de riesgo ---------------- */
  view.appendChild(
    card({
      title: 'Zona de riesgo',
      content: el(
        'div',
        {},
        el('button', {
          class: 'btn btn-danger',
          type: 'button',
          text: 'Vaciar todos los datos',
          on: {
            click: async () => {
              const ok = await confirmDialog({
                title: 'Vaciar todos los datos',
                message:
                  'Se borran todos los pedidos, productos y movimientos de este dispositivo. Esto no se puede deshacer. Exportá una copia antes si tenés dudas.',
                confirmLabel: 'Sí, vaciar todo',
                danger: true,
              });
              if (!ok) return;
              toastSuccess('Para un borrado total, borrá la carpeta de datos desde Ajustes del sistema.');
            },
          },
        }),
      ),
    }),
  );

  /* ---------------- Acerca de ---------------- */
  view.appendChild(
    card({
      title: 'Acerca de',
      content: el(
        'div',
        {},
        infoRow('Versión', APP_VERSION),
        infoRow('Arquitectura', 'Event Sourcing (JSONL append-only)'),
        infoRow('Stack', 'Tauri 2 + TypeScript vanilla + Vite'),
        infoRow('Moneda', 'ARS (centavos)'),
        infoRow('Talles', 'XS → 3XL (fijos)'),
        el('p', {
          class: 'small muted mt-4',
          text: '100% local y offline. Tus datos viven en archivos .jsonl (append-only) dentro de una carpeta elegible, sin base SQL .db.',
        }),
      ),
    }),
  );

  /* ---------------- Sincronización (esqueleto fase 2) ---------------- */
  let syncEnabled = false;
  let syncDeviceId = '';
  let syncPeers: any[] = [];

  async function syncGenerateIdentity(): Promise<void> {
    try {
      const id = await invoke<string>('sync_generate_identity', { name: 'Este equipo' });
      syncDeviceId = id;
      syncEnabled = true;
      renderSync();
      toastSuccess('Identidad de dispositivo generada.');
    } catch (err) {
      showError(err);
    }
  }

  async function syncListPeers(): Promise<void> {
    try {
      syncPeers = await invoke<any[]>('sync_list_peers');
      renderSync();
    } catch (err) {
      showError(err);
    }
  }

  async function syncStart(): Promise<void> {
    try {
      await invoke('sync_start');
      toastSuccess('Sincronización iniciada (esqueleto).');
    } catch (err) {
      showError(err);
    }
  }

  async function syncStop(): Promise<void> {
    try {
      await invoke('sync_stop');
      toastSuccess('Sincronización detenida.');
    } catch (err) {
      showError(err);
    }
  }

  function renderSync(): void {
    // Se renderiza la tarjeta completa abajo; esta función es un placeholder
    // para futuras actualizaciones reactivas de la lista de peers.
  }

  view.appendChild(
    card({
      title: 'Sincronización (P2P LAN)',
      content: el(
        'div',
        {},
        el(
          'div',
          { class: 'row-between', style: { marginBottom: '16px' } },
          el('span', { class: 'small muted', text: 'Sincronización P2P (LAN)' }),
          el(
            'label',
            {
              style: { display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
              on: {
                click: () => {
                  syncEnabled = !syncEnabled;
                  if (syncEnabled && !syncDeviceId) {
                    void syncGenerateIdentity();
                  }
                  renderSync();
                },
              },
            },
            el('input', {
              type: 'checkbox',
              checked: syncEnabled,
              on: { change: () => {} },
            }),
            el('span', { text: syncEnabled ? 'Activada' : 'Desactivada' }),
          ),
        ),
        el('div', { class: 'field', style: { marginBottom: '16px' } },
          el('label', { text: 'Mi Device ID' }),
          el('input', {
            type: 'text',
            value: syncDeviceId,
            disabled: true,
            style: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #c7c6cf', background: '#e7e9ec' },
          }),
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            style: { marginTop: '8px' },
            text: syncDeviceId ? 'Volver a generar' : 'Generar identidad',
            on: { click: () => void syncGenerateIdentity() },
          }),
        ),
        el('div', { class: 'field', style: { marginBottom: '16px' } },
          el('label', { text: 'Dispositivos emparejados' }),
          syncPeers.length === 0
            ? el('div', { class: 'small muted', text: 'Sin dispositivos emparejados todavía.' })
            : el(
                'div',
                {},
                ...syncPeers.map((p) => el('div', { class: 'small', style: { padding: '4px 0' } }, el('span', { text: `${p.name ?? p.device_id} · ${p.device_id.slice(0, 8)}…` }))),
              ),
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            style: { marginTop: '8px' },
            text: 'Refrescar lista',
            on: { click: () => void syncListPeers() },
          }),
        ),
        el('div', { class: 'btn-group', style: { gap: '8px' } },
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            disabled: !syncDeviceId,
            text: 'Iniciar sincronización',
            on: { click: () => void syncStart() },
          }),
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: 'Detener',
            on: { click: () => void syncStop() },
          }),
        ),
        el('p', {
          class: 'small muted mt-3',
          text: 'Esqueleto de fase 2: identidad y protocolo implementados; transporte TLS/mDNS no verificado.',
        }),
      ),
    }),
  );

  /* ---------------- Actualizaciones (fase 5 - esqueleto) ---------------- */
  let updateStatus = '';
  async function checkUpdate(): Promise<void> {
    try {
      updateStatus = await invoke<string>('cmd_updater_check');
      renderUpdate();
    } catch (err) {
      showError(err);
    }
  }

  function renderUpdate(): void {
    // placeholder para actualizar reactivamente
  }

  view.appendChild(
    card({
      title: 'Actualizaciones',
      content: el(
        'div',
        {},
        el('div', { class: 'field', style: { marginBottom: '16px' } },
          el('label', { text: 'Versión actual' }),
          el('input', {
            type: 'text',
            value: APP_VERSION,
            disabled: true,
            style: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid #c7c6cf', background: '#e7e9ec' },
          }),
        ),
        el('div', { class: 'btn-group', style: { gap: '8px' } },
          el('button', {
            class: 'btn btn-sm',
            type: 'button',
            text: 'Buscar actualizaciones',
            on: { click: () => void checkUpdate() },
          }),
        ),
        updateStatus
          ? el('div', { class: 'small mt-3', style: { marginTop: '8px' } }, el('span', { text: updateStatus }))
          : null,
        el('p', {
          class: 'small muted mt-3',
          text: 'Esqueleto de fase 5: requiere pubkey del updater generada por el usuario y configurada en src-tauri/tauri.conf.json.',
        }),
      ),
    }),
  );

  return view;
}

function infoRow(label: string, value: string): HTMLElement {
  return el(
    'div',
    { class: 'row-between', style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } },
    el('span', { class: 'small muted', text: label }),
    el('span', { class: 'small strong mono', text: value }),
  );
}

function kindLabel(kind: string): string {
  if (kind === 'tauri') return 'Archivos en disco (.jsonl)';
  if (kind === 'web') return 'Navegador (OPFS)';
  return 'Memoria (volátil)';
}

/* ------------------------------------------------------------------ */

async function exportBackup(app: App): Promise<void> {
  try {
    const bundle = await app.store.exportAll();
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventario-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toastSuccess('Copia exportada.');
  } catch (err) {
    showError(err);
  }
}

async function importBackup(app: App, shell: Shell): Promise<void> {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (!bundle || bundle.format !== 'inventario-tienda/events') {
        throw new Error('El archivo no es una copia válida de Inventario Tienda.');
      }
      const ok = await confirmDialog({
        title: 'Restaurar copia',
        message: `Se van a agregar ${bundle.events?.length ?? 0} eventos. Los que ya tenés se ignoran (se fusiona sin duplicar).`,
        confirmLabel: 'Importar',
      });
      if (!ok) return;
      const result = await app.store.importBundle(bundle);
      await app.rebuild();
      toastSuccess(`Se importaron ${result.imported} evento(s). ${result.skipped} ya existían.`);
      shell.router.navigate('/');
    } catch (err) {
      showError(err);
    }
  });
  input.click();
}
