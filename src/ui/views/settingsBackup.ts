import { el, mount } from '../dom';
import { toast, showError } from '../components/toast';
import { confirmDialog } from '../components/modal';
import { formatDateTime } from '../../core/dates';
import type { TauriEventStore } from '../../store/TauriEventStore';
import type { VaultStatus } from './vaultSetup';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface LonglifeStatus {
  hasVault: boolean;
  vaultPath: string | null;
  lastDate: string | null;
  lastCreatedAt: string | null;
  count: number;
  maxDays: number;
}

interface LonglifeEntry {
  date: string;
  createdAt: string | null;
  files: number;
  totalBytes: number;
  valid: boolean;
}

interface LonglifeResult {
  date: string;
  path: string;
  files: number;
  totalBytes: number;
  reused: boolean;
}

function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function vaultLabel(status: VaultStatus | null): string {
  if (!status?.configured) return 'Sin carpeta elegida';
  if (status.kind === 'saf') return `${status.vaultName ?? 'Bóveda'} (Android SAF)`;
  return status.vaultRoot ?? status.vaultName ?? 'Bóveda';
}

/**
 * Vista de la bóveda y sus copias diarias "longlife".
 *
 * La app nunca lee `longlife` automáticamente. Restaurar es una operación
 * manual: el usuario copia una fecha dentro de `omega` con la app cerrada.
 */
export function settingsBackupView(host: HTMLElement, _store?: TauriEventStore): void {
  const statusHost = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Cargando…'));
  const listHost = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Cargando…'));

  const changeVault = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Cambiar carpeta bóveda',
    on: {
      click: async () => {
        if (!isTauri()) return;
        const ok = await confirmDialog({
          title: 'Cambiar carpeta bóveda',
          message:
            'La app va a dejar de usar la carpeta actual y se reiniciará para abrir la nueva. Los datos actuales NO se mueven solos: si querés conservarlos, copiá primero omega/ a la nueva carpeta.',
          confirmLabel: 'Elegir otra carpeta',
          danger: true,
        });
        if (!ok) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const next = await invoke<VaultStatus>('vault_pick');
          if (!next.dataRoot) throw new Error('No se eligió una carpeta válida.');
          window.location.reload();
        } catch (err) {
          showError(err);
        }
      },
    },
  });

  const runToday = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: 'Crear copia de hoy',
    on: {
      click: async () => {
        if (!isTauri()) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const result = await invoke<LonglifeResult>('longlife_run', { force: false });
          toast(
            result.reused
              ? `La copia de ${result.date} ya existía (${result.files} archivos).`
              : `Copia de ${result.date} creada: ${result.files} archivos, ${bytesLabel(result.totalBytes)}.`,
            { kind: 'success' },
          );
          await refresh();
        } catch (err) {
          showError(err);
        }
      },
    },
  });

  const forceToday = el('button', {
    class: 'btn btn-ghost',
    type: 'button',
    text: 'Regenerar copia de hoy',
    on: {
      click: async () => {
        if (!isTauri()) return;
        const ok = await confirmDialog({
          title: 'Regenerar la copia de hoy',
          message:
            'Se reemplaza el snapshot de hoy con el estado actual de omega/. Las copias de días anteriores no se tocan.',
          confirmLabel: 'Regenerar',
        });
        if (!ok) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const result = await invoke<LonglifeResult>('longlife_run', { force: true });
          toast(
            `Copia de ${result.date} regenerada: ${result.files} archivos, ${bytesLabel(result.totalBytes)}.`,
            { kind: 'success' },
          );
          await refresh();
        } catch (err) {
          showError(err);
        }
      },
    },
  });

  const deleteAll = el('button', {
    class: 'btn btn-danger',
    type: 'button',
    text: 'Borrar todas las copias longlife',
    on: {
      click: async () => {
        if (!isTauri()) return;
        const first = await confirmDialog({
          title: 'Borrar todas las copias longlife',
          message:
            'Se eliminan TODAS las copias diarias guardadas en <bóveda>/longlife. Los datos vivos de omega/ no se tocan.',
          confirmLabel: 'Continuar',
          danger: true,
        });
        if (!first) return;
        const second = await confirmDialog({
          title: 'Confirmación final',
          message:
            'Esta acción no se puede deshacer. ¿Seguro que querés borrar todas las copias longlife?',
          confirmLabel: 'Sí, borrar todo',
          danger: true,
        });
        if (!second) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('longlife_delete');
          toast('Copias longlife eliminadas.', { kind: 'success' });
          await refresh();
        } catch (err) {
          showError(err);
        }
      },
    },
  });

  mount(
    host,
    el('section', { class: 'view' }, [
      el('header', { class: 'view-header' }, [
        el('div', {}, [
          el('h1', {}, 'Copias longlife'),
          el('p', {
            class: 'muted',
            text:
              'Cada día se guarda una copia de <bóveda>/omega en <bóveda>/longlife/YYYY-MM-DD. Se conservan las 7 fechas más recientes. La app no lee estas copias automáticamente.',
          }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [el('h2', {}, 'Carpeta bóveda'), el('p', { class: 'muted' }, 'Datos vivos')]),
        ]),
        el('div', { class: 'card-body stack' }, [
          statusHost,
          el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
            changeVault,
            el('button', {
              class: 'btn btn-ghost',
              type: 'button',
              text: 'Actualizar',
              on: { click: () => void refresh() },
            }),
          ]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [
            el('h2', {}, 'Estado de las copias'),
            el('p', { class: 'muted' }, 'Snapshot automático diario'),
          ]),
        ]),
        el('div', { class: 'card-body stack' }, [
          listHost,
          el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px', marginTop: '12px' } }, [
            runToday,
            forceToday,
          ]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [
            el('h2', {}, 'Cómo restaurar'),
            el('p', { class: 'muted' }, 'Operación manual y deliberada'),
          ]),
        ]),
        el('div', { class: 'card-body stack' }, [
          el('p', {
            class: 'muted',
            text:
              'La app no restaura sola: así una copia vieja nunca pisa los datos vivos por accidente. Para volver a una fecha:',
          }),
          el('ol', { class: 'muted small', style: { paddingLeft: '20px', lineHeight: '1.8' } }, [
            el('li', {}, 'Cerrá la app por completo.'),
            el('li', {}, 'Hacé una copia de seguridad de la carpeta omega/ actual.'),
            el('li', {}, 'Copiá el contenido de longlife/YYYY-MM-DD/ dentro de omega/, reemplazando los archivos.'),
            el('li', {}, 'Abrí la app y desbloqueá con la contraseña que corresponda a esa copia.'),
          ]),
          el('p', {
            class: 'small muted',
            text:
              'Si la copia se hizo con otra contraseña maestra, necesitás esa contraseña o su código de recuperación. El llavero viaja dentro de la copia.',
          }),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [
            el('h2', {}, 'Zona de riesgo'),
            el('p', { class: 'muted' }, 'Borrar copias longlife'),
          ]),
        ]),
        el('div', { class: 'card-body stack' }, [
          el('p', {
            class: 'muted',
            text:
              'Borra las copias diarias, no los datos vivos. Usalo solo si ya no necesitás recuperar una versión anterior.',
          }),
          deleteAll,
        ]),
      ]),
    ]),
  );

  async function refresh(): Promise<void> {
    if (!isTauri()) {
      statusHost.replaceChildren(
        el('p', { class: 'muted' }, 'La bóveda y sus copias solo están disponibles en la app nativa.'),
      );
      listHost.replaceChildren();
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const [vault, status, entries] = await Promise.all([
        invoke<VaultStatus>('vault_status'),
        invoke<LonglifeStatus>('longlife_status'),
        invoke<LonglifeEntry[]>('longlife_list'),
      ]);

      statusHost.replaceChildren(
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Bóveda'),
          el('span', { class: 'small strong' }, vaultLabel(vault)),
        ]),
        vault.error
          ? el('p', { class: 'small', style: { color: 'var(--danger)' } }, vault.error)
          : el('span'),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Última copia'),
          el('span', { class: 'small strong' }, status.lastDate ?? 'Todavía ninguna'),
        ]),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Creada'),
          el('span', { class: 'small' }, status.lastCreatedAt ? formatDateTime(Date.parse(status.lastCreatedAt)) : '-'),
        ]),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Copias conservadas'),
          el('span', { class: 'small strong' }, `${status.count} / ${status.maxDays}`),
        ]),
        el('p', {
          class: 'small muted mt-2',
          text: status.hasVault
            ? 'Se guarda una copia por día. Al llegar a 7, se elimina la fecha más vieja.'
            : 'Elegí una carpeta bóveda para activar las copias.',
        }),
      );

      if (entries.length === 0) {
        listHost.replaceChildren(
          el('p', { class: 'muted' }, 'Todavía no hay copias longlife. Se crea una al iniciar la app cada día.'),
        );
      } else {
        listHost.replaceChildren(
          el(
            'div',
            { class: 'list' },
            ...entries.map((entry) =>
              el(
                'div',
                { class: 'list-item', style: { cursor: 'default' } },
                el(
                  'div',
                  { class: 'list-item-main' },
                  el('div', { class: 'list-item-title' }, [
                    entry.date,
                    entry.valid ? '' : ' (manifiesto ausente)',
                  ]),
                  el('div', { class: 'list-item-sub' }, [
                    `${entry.files} archivo(s) · ${bytesLabel(entry.totalBytes)}`,
                    entry.createdAt ? ` · ${formatDateTime(Date.parse(entry.createdAt))}` : '',
                  ]),
                ),
              ),
            ),
          ),
          el('p', {
            class: 'small muted',
            text: 'Ruta: <bóveda>/longlife/<fecha>/ dentro de la carpeta elegida.',
          }),
        );
      }
    } catch (err) {
      statusHost.replaceChildren(
        el('p', { class: 'muted' }, err instanceof Error ? err.message : String(err)),
      );
      listHost.replaceChildren();
    }
  }

  void refresh();
}
