import { invoke } from '@tauri-apps/api/core';
import type { App } from '../../app/App';
import { formatDateTime } from '../../core/dates';
import { openModal } from '../components/modal';
import { confirmDialog } from '../components/modal';
import { showError, toastSuccess } from '../components/toast';
import { el, icon, mount } from '../dom';
import { card, emptyState } from './common';

/* ------------------------------------------------------------------ */
/* Sincronización P2P (LAN, TLS mutuo + emparejamiento por SAS)        */
/* ------------------------------------------------------------------ */

interface IdentityInfo {
  device_id: string;
  name: string;
  fingerprint: string;
}

interface SyncLocalInfo {
  identity: IdentityInfo | null;
  addresses: string[];
  sync_port: number;
  pairing_port: number;
  running: boolean;
  peer_count: number;
}

interface Peer {
  device_id: string;
  name: string;
  fingerprint: string;
  trusted: boolean;
  paired_at: number;
  last_seen: number | null;
  address: string | null;
  cert_pem: string;
}

interface PendingPairing {
  device_id: string;
  name: string;
  fingerprint: string;
  sas: string;
  address: string;
  cert_pem: string;
  created_at: number;
  expires_at: number;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function localName(app: App): string {
  const device = app.state.devices.get(app.deviceId);
  return device?.name?.trim() || 'Este equipo';
}

function shortFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 20) return fingerprint;
  return `${fingerprint.slice(0, 10)}…${fingerprint.slice(-6)}`;
}

function formatSas(sas: string): string {
  const digits = sas.replace(/\D/g, '');
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : sas;
}

export function settingsSyncCard(app: App): HTMLElement {
  let info: SyncLocalInfo | null = null;
  let peers: Peer[] = [];
  let pending: PendingPairing | null = null;
  let busy = false;
  let listening = false;
  let addressDraft = '';
  let pollTimer: number | null = null;
  let message = '';

  const body = el('div');

  const stopPolling = (): void => {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const startPolling = (): void => {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => {
      if (!body.isConnected) {
        stopPolling();
        return;
      }
      void refreshPending();
    }, 1200);
  };

  const setBusy = (value: boolean): void => {
    busy = value;
    render();
  };

  async function load(): Promise<void> {
    if (!isTauri()) return;
    info = await invoke<SyncLocalInfo>('sync_local_info', { name: localName(app) });
    peers = await invoke<Peer[]>('sync_list_peers');
    pending = await invoke<PendingPairing | null>('sync_pair_pending');
    listening = Boolean(pending) || listening;
  }

  async function refreshPending(): Promise<void> {
    if (!isTauri() || busy) return;
    try {
      pending = await invoke<PendingPairing | null>('sync_pair_pending');
      if (pending) {
        listening = false;
        stopPolling();
      } else if (info?.running === false) {
        listening = false;
        stopPolling();
      }
      render();
    } catch (err) {
      stopPolling();
      showError(err);
    }
  }

  async function refreshAll(): Promise<void> {
    try {
      await load();
      render();
    } catch (err) {
      showError(err);
    }
  }

  function setMessage(text: string): void {
    message = text;
    render();
  }

  async function ensureServer(): Promise<boolean> {
    if (info?.running) return true;
    setBusy(true);
    try {
      info = await invoke<SyncLocalInfo>('sync_start', { name: localName(app) });
      message = 'Sincronización activada. Este dispositivo ya puede recibir conexiones.';
      return true;
    } catch (err) {
      showError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function toggleServer(): Promise<void> {
    if (!isTauri()) return;
    setBusy(true);
    message = '';
    try {
      if (info?.running) {
        await invoke('sync_stop');
        stopPolling();
        listening = false;
        message = 'Sincronización detenida.';
      } else {
        info = await invoke<SyncLocalInfo>('sync_start', { name: localName(app) });
        message = 'Sincronización activada.';
      }
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function startListen(): Promise<void> {
    if (!(await ensureServer())) return;
    setBusy(true);
    try {
      const result = await invoke<{ info: SyncLocalInfo; expires_at: number }>(
        'sync_pair_listen_start',
        { name: localName(app) },
      );
      info = result.info;
      listening = true;
      message = 'Esperando a que el otro dispositivo se conecte…';
      startPolling();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function stopListen(): Promise<void> {
    try {
      await invoke('sync_pair_listen_stop');
    } catch {
      /* best-effort */
    }
    listening = false;
    pending = null;
    stopPolling();
    message = '';
    render();
  }

  async function connectTo(address: string): Promise<void> {
    const clean = address.trim();
    if (!clean) {
      showError(new Error('Ingresá la IP del otro dispositivo.'));
      return;
    }
    if (!(await ensureServer())) return;
    setBusy(true);
    message = 'Conectando con el otro dispositivo…';
    try {
      pending = await invoke<PendingPairing>('sync_pair_connect', {
        name: localName(app),
        address: clean,
      });
      listening = false;
      message = '';
    } catch (err) {
      pending = null;
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPairing(): Promise<void> {
    if (!pending) return;
    setBusy(true);
    try {
      const peer = await invoke<Peer>('sync_pair_confirm', { deviceId: pending.device_id });
      pending = null;
      listening = false;
      stopPolling();
      try {
        await invoke('sync_pair_listen_stop');
      } catch {
        /* best-effort */
      }
      message = `${peer.name} quedó emparejado.`;
      toastSuccess('Dispositivo emparejado.');
      await load();
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function cancelPairing(): Promise<void> {
    if (pending) {
      try {
        await invoke('sync_pair_cancel', { deviceId: pending.device_id });
      } catch {
        /* best-effort */
      }
    }
    pending = null;
    await stopListen();
  }

  async function syncPeer(peer: Peer): Promise<void> {
    setBusy(true);
    message = `Sincronizando con ${peer.name}…`;
    try {
      const result = await invoke<{ reports: any[]; errors: string[] }>('sync_now', {
        deviceId: peer.device_id,
      });
      const report = result.reports[0];
      if (result.errors.length > 0) {
        message = result.errors.join(' · ');
        showError(new Error(message));
      } else if (report) {
        message = `${peer.name}: ${report.received} recibidos, ${report.sent} enviados.`;
        toastSuccess('Sincronización completada.');
      }
      await load();
    } catch (err) {
      message = '';
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  async function syncAll(): Promise<void> {
    setBusy(true);
    message = 'Sincronizando con todos los dispositivos…';
    try {
      const result = await invoke<{ reports: any[]; errors: string[] }>('sync_now', {});
      const received = result.reports.reduce((sum, r) => sum + r.received, 0);
      const sent = result.reports.reduce((sum, r) => sum + r.sent, 0);
      message =
        result.reports.length === 0
          ? 'No se pudo sincronizar con ningún dispositivo.'
          : `Listo: ${received} recibidos y ${sent} enviados.`;
      if (result.errors.length > 0) {
        showError(new Error(result.errors.join('\n')));
      } else {
        toastSuccess('Sincronización completada.');
      }
      await load();
    } catch (err) {
      message = '';
      showError(err);
    } finally {
      setBusy(false);
    }
  }

  function editAddress(peer: Peer): void {
    const input = el('input', {
      type: 'text',
      value: peer.address ?? '',
      placeholder: '192.168.1.20',
      autocomplete: 'off',
    });
    const form = el(
      'div',
      { class: 'field' },
      el('label', { text: 'Dirección IP del dispositivo' }),
      input,
      el('p', {
        class: 'small muted mt-3',
        text: 'Se usa el puerto de sincronización 14242. La IP puede cambiar si el router asigna otra.',
      }),
    );
    const modal = openModal({
      title: `Dirección de ${peer.name}`,
      body: form,
      actions: [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Cancelar',
          on: { click: () => modal.close() },
        }),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          text: 'Guardar',
          on: {
            click: async () => {
              try {
                await invoke('sync_set_peer_address', {
                  deviceId: peer.device_id,
                  address: input.value.trim() || null,
                });
                modal.close();
                await load();
                toastSuccess('Dirección actualizada.');
              } catch (err) {
                showError(err);
              }
            },
          },
        }),
      ],
    });
  }

  async function removePeer(peer: Peer): Promise<void> {
    const ok = await confirmDialog({
      title: `Quitar ${peer.name}`,
      message:
        'Se olvida el certificado de este dispositivo. Para volver a sincronizar vas a tener que emparejarlos de nuevo.',
      confirmLabel: 'Quitar dispositivo',
      danger: true,
    });
    if (!ok) return;
    try {
      await invoke('sync_remove_peer', { deviceId: peer.device_id });
      await load();
      toastSuccess('Dispositivo quitado.');
    } catch (err) {
      showError(err);
    }
  }

  const onSyncUpdated = (): void => {
    if (!isTauri() || busy) return;
    void load().then(render).catch(() => {});
  };
  window.addEventListener('inventario:sync-updated', onSyncUpdated);

  function identityBlock(current: IdentityInfo): HTMLElement {
    return el(
      'div',
      { class: 'sync-identity' },
      el(
        'div',
        { class: 'sync-identity-row' },
        el('span', { class: 'small muted', text: 'Este dispositivo' }),
        el('span', { class: 'small strong', text: current.name }),
      ),
      el(
        'div',
        { class: 'sync-identity-row' },
        el('span', { class: 'small muted', text: 'ID' }),
        el('span', { class: 'small mono sync-wrap', text: current.device_id }),
      ),
      el(
        'div',
        { class: 'sync-identity-row' },
        el('span', { class: 'small muted', text: 'Huella' }),
        el('span', { class: 'small mono', text: shortFingerprint(current.fingerprint) }),
      ),
      info && info.addresses.length > 0
        ? el(
            'div',
            { class: 'sync-identity-row' },
            el('span', { class: 'small muted', text: 'IP LAN' }),
            el(
              'span',
              { class: 'small mono sync-wrap' },
              info.addresses.join(' · '),
            ),
          )
        : null,
    );
  }

  function pendingBlock(): HTMLElement {
    if (!pending) return el('div');
    return el(
      'div',
      { class: 'sync-pending' },
      el('div', { class: 'small muted', text: 'Código de seguridad' }),
      el('div', { class: 'sync-sas', text: formatSas(pending.sas) }),
      el('p', {
        class: 'small',
        text: `Compará este código con el que muestra “${pending.name}”. Deben ser idénticos.`,
      }),
      el(
        'div',
        { class: 'sync-pending-meta' },
        el('span', { class: 'small muted', text: pending.name }),
        el('span', { class: 'small mono', text: pending.address }),
      ),
      el(
        'div',
        { class: 'btn-group', style: { marginTop: '12px' } },
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          disabled: busy,
          on: { click: () => void confirmPairing() },
        }, icon('check', 18), 'Los códigos coinciden'),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          disabled: busy,
          text: 'Cancelar',
          on: { click: () => void cancelPairing() },
        }),
      ),
    );
  }

  function pairingIdleBlock(): HTMLElement {
    const input = el('input', {
      type: 'text',
      value: addressDraft,
      placeholder: '192.168.1.20',
      inputmode: 'decimal',
      autocomplete: 'off',
      'aria-label': 'IP del otro dispositivo',
      on: {
        input: () => {
          addressDraft = input.value;
        },
      },
    });
    return el(
      'div',
      { class: 'sync-pair-actions' },
      el(
        'div',
        { class: 'field' },
        el('label', { text: 'Emparejar con otro dispositivo' }),
        el(
          'p',
          {
            class: 'small muted',
            text: 'Poné la IP del otro dispositivo en la misma red. Ambos tienen que confirmar el mismo código de 6 dígitos.',
          },
        ),
        el(
          'div',
          { class: 'sync-inline' },
          input,
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            disabled: busy,
            text: 'Conectar',
            on: { click: () => void connectTo(input.value) },
          }),
        ),
      ),
      el('div', { class: 'sync-or' }, el('span', { text: 'o' })),
      el('button', {
        class: 'btn',
        type: 'button',
        disabled: busy,
        on: { click: () => void startListen() },
      }, icon('download', 18), 'Mostrar mi código y esperar'),
    );
  }

  function listeningBlock(): HTMLElement {
    return el(
      'div',
      { class: 'sync-pending' },
      el('div', { class: 'sync-waiting' }, el('span', { class: 'sync-spinner' })),
      el('p', {
        class: 'small',
        text: 'Esperando a que el otro dispositivo se conecte. Mantené esta pantalla abierta.',
      }),
      el(
        'button',
        {
          class: 'btn btn-ghost',
          type: 'button',
          disabled: busy,
          text: 'Cancelar espera',
          on: { click: () => void stopListen() },
        },
      ),
    );
  }

  function peersBlock(): HTMLElement {
    if (peers.length === 0) {
      return emptyState({
        icon: 'customers',
        title: 'Sin dispositivos emparejados',
        message: 'Emparejá dos dispositivos en la misma red para compartir pedidos, stock y ventas.',
      });
    }
    return el(
      'div',
      { class: 'sync-peers' },
      ...peers.map((peer) =>
        el(
          'div',
          { class: 'sync-peer' },
          el(
            'div',
            { class: 'sync-peer-main' },
            el('div', { class: 'sync-peer-name', text: peer.name }),
            el('div', {
              class: 'small mono muted sync-wrap',
              text: peer.address ?? 'Sin dirección',
            }),
            el('div', {
              class: 'xsmall dim',
              text: peer.last_seen
                ? `Última conexión: ${formatDateTime(peer.last_seen)}`
                : 'Todavía sin conexiones',
            }),
          ),
          el(
            'div',
            { class: 'sync-peer-actions' },
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              disabled: busy || !peer.address,
              text: 'Sincronizar',
              on: { click: () => void syncPeer(peer) },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              disabled: busy,
              text: 'IP',
              title: 'Editar dirección IP',
              on: { click: () => editAddress(peer) },
            }),
            el('button', {
              class: 'btn btn-sm btn-ghost',
              type: 'button',
              disabled: busy,
              'aria-label': `Quitar ${peer.name}`,
              title: 'Quitar dispositivo',
              on: { click: () => void removePeer(peer) },
            }, icon('trash', 16)),
          ),
        ),
      ),
    );
  }

  function render(): void {
    if (!isTauri()) {
      mount(
        body,
        el('p', {
          class: 'small muted',
          text: 'La sincronización P2P solo está disponible en la app instalada (Android, Linux o Windows), no en el navegador.',
        }),
      );
      return;
    }

    const current = info?.identity ?? null;
    const statusText = info?.running ? 'Activa' : 'Detenida';
    const statusClass = info?.running ? 'sync-dot on' : 'sync-dot';

    mount(
      body,
      el(
        'div',
        { class: 'sync-status-row' },
        el(
          'div',
          { class: 'sync-status' },
          el('span', { class: statusClass }),
          el('span', { class: 'small strong', text: statusText }),
          info ? el('span', { class: 'xsmall dim', text: `Puerto ${info.sync_port}` }) : null,
        ),
        el('button', {
          class: info?.running ? 'btn btn-sm btn-ghost' : 'btn btn-sm btn-primary',
          type: 'button',
          disabled: busy,
          text: info?.running ? 'Detener' : 'Activar',
          on: { click: () => void toggleServer() },
        }),
      ),
      current ? identityBlock(current) : null,
      el('p', {
        class: 'small muted',
        text: 'Los datos viajan cifrados con TLS mutuo y certificados fijados. Nada sale de tu red local.',
      }),
      el('div', { class: 'sync-divider' }),
      pending ? pendingBlock() : listening ? listeningBlock() : pairingIdleBlock(),
      message
        ? el('p', {
            class: 'small sync-message',
            role: 'status',
            text: message,
          })
        : null,
      peers.length > 0
        ? el(
            'div',
            { class: 'sync-peers-head' },
            el('span', { class: 'small strong', text: 'Dispositivos emparejados' }),
            el('button', {
              class: 'btn btn-sm',
              type: 'button',
              disabled: busy || peers.length === 0,
              text: 'Sincronizar todo',
              on: { click: () => void syncAll() },
            }),
          )
        : null,
      peersBlock(),
    );
  }

  const cardEl = card({
    title: 'Sincronización entre dispositivos',
    subtitle: 'LAN, cifrada y sin nube',
    content: body,
  });

  if (isTauri()) {
    void refreshAll();
  } else {
    render();
  }

  // Detenemos el polling si el usuario navega fuera de Ajustes.
  const observer = new MutationObserver(() => {
    if (!body.isConnected) {
      stopPolling();
      observer.disconnect();
      window.removeEventListener('inventario:sync-updated', onSyncUpdated);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return cardEl;
}
