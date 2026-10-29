import { el, mount } from '../dom';
import { toast, showError } from '../components/toast';
import { confirmDialog } from '../components/modal';
import { formatDateTime } from '../../core/dates';
import type { App } from '../../app/App';
import type { TauriEventStore } from '../../store/TauriEventStore';
import type { VaultStatus } from './vaultSetup';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface LonglifeStatus {
  hasVault: boolean;
  vaultPath: string | null;
  deviceId: string | null;
  deviceName: string | null;
  lastDate: string | null;
  lastCreatedAt: string | null;
  count: number;
  totalCount: number;
  maxDays: number;
}

type SnapshotKind = 'daily' | 'pre-restore' | 'legacy';

interface LonglifeEntry {
  deviceId: string | null;
  deviceName: string | null;
  kind: SnapshotKind;
  date: string;
  createdAt: string | null;
  files: number;
  totalBytes: number;
  valid: boolean;
  encrypted: boolean;
  relativePath: string;
}

interface LonglifeResult {
  deviceId: string;
  deviceName: string;
  kind: SnapshotKind;
  date: string;
  path: string;
  files: number;
  totalBytes: number;
  reused: boolean;
  protected?: boolean;
}

interface LonglifeRestoreResult {
  restoredFrom: string;
  preRestore: string;
  files: number;
  totalBytes: number;
  encrypted: boolean;
  requiresUnlock: boolean;
  journalRepaired: number;
  journalPending: number;
  journalStale: number;
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
 * Cada dispositivo guarda sus copias en su propia carpeta. La copia del día se
 * refresca automáticamente después de los cambios. Restaurar desde acá es una
 * operación deliberada: se valida la copia, se guarda una copia previa del
 * estado actual, se descarta el diario y la app se bloquea para desbloquear el
 * llavero restaurado.
 */
export function settingsBackupView(
  host: HTMLElement,
  _store?: TauriEventStore,
  app?: App,
): void {
  const statusHost = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Cargando…'));
  const listHost = el('div', { class: 'stack' }, el('p', { class: 'muted' }, 'Cargando…'));
  let restoring = false;

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
    text: 'Actualizar copia de hoy',
    on: {
      click: async () => {
        if (!isTauri()) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const result = await invoke<LonglifeResult>('longlife_run', { refresh: true });
          toast(
            result.protected
              ? `Se conservó la copia de ${result.date}: los datos vivos están vacíos y no se sobrescribió el snapshot. Usá "Regenerar desde cero" si querés reemplazarla.`
              : result.reused
                ? `La copia de ${result.date} ya estaba al día (${result.files} archivos).`
                : `Copia de ${result.date} actualizada: ${result.files} archivos, ${bytesLabel(result.totalBytes)}.`,
            { kind: result.protected ? 'warning' : 'success', duration: result.protected ? 9000 : undefined },
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
    text: 'Regenerar desde cero',
    on: {
      click: async () => {
        if (!isTauri()) return;
        const ok = await confirmDialog({
          title: 'Regenerar la copia de hoy',
          message:
            'Se borra y se vuelve a crear el snapshot de hoy con el estado actual de omega/. Las copias de días anteriores no se tocan.',
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
            'Se eliminan TODAS las copias guardadas en <bóveda>/longlife, de TODOS los dispositivos. Los datos vivos de omega/ no se tocan.',
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

  async function restoreEntry(entry: LonglifeEntry): Promise<void> {
    if (!isTauri() || !entry.valid || restoring) return;
    restoring = true;
    const device = entry.deviceName ?? entry.deviceId ?? 'copia anterior';
    const when =
      entry.kind === 'pre-restore'
        ? 'la copia previa a una restauración'
        : `la copia del ${entry.date}`;
    const first = await confirmDialog({
      title: `Restaurar ${device}`,
      message:
        `Se reemplazarán los datos vivos de omega/ por ${when}. ` +
        'Antes se guarda una copia del estado actual y se descarta el diario local. ' +
        (entry.encrypted
          ? 'Si la copia está cifrada con otra contraseña, necesitarás esa contraseña o su código de recuperación.'
          : 'Esta copia no tiene llavero: después de restaurar, la app quedará sin cifrado y habrá que configurarlo de nuevo.'),
      confirmLabel: 'Continuar',
      danger: true,
    });
    if (!first) {
      restoring = false;
      return;
    }
    const second = await confirmDialog({
      title: 'Confirmación final',
      message: entry.encrypted
        ? 'La app se bloqueará y tendrás que desbloquear con la contraseña de la copia restaurada. ¿Restaurar ahora?'
        : 'La app se reiniciará sin cifrado y tendrás que configurar una contraseña maestra. ¿Restaurar ahora?',
      confirmLabel: 'Restaurar y bloquear',
      danger: true,
    });
    if (!second) {
      restoring = false;
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<LonglifeRestoreResult>('longlife_restore', {
        deviceId: entry.deviceId,
        date: entry.date,
      });
      const pending = result.journalPending + result.journalStale;
      toast(
        `Restauración completa: ${result.files} archivo(s), ${bytesLabel(result.totalBytes)}. ` +
          `Copia previa en ${result.preRestore}.` +
          (pending > 0
            ? ` Quedaron ${pending} entrada(s) del diario sin recuperar; no están en la copia previa.`
            : ''),
        { kind: pending > 0 ? 'warning' : 'success', duration: pending > 0 ? 12000 : 6000 },
      );
      // La clave en memoria se borró: detener el poller y recargar para
      // mostrar el desbloqueo del llavero restaurado.
      await _store?.unwatch();
      window.setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      restoring = false;
      showError(err);
    }
  }

  mount(
    host,
    el('section', { class: 'view' }, [
      el('header', { class: 'view-header' }, [
        el('div', {}, [
          el('h1', {}, 'Copias longlife'),
          el('p', {
            class: 'muted',
            text:
              'Cada dispositivo guarda sus copias en <bóveda>/longlife/<dispositivo>/<YYYY-MM-DD>. La copia del día se actualiza sola unos minutos después de un cambio, al pasar a segundo plano o al cerrar. Se conservan las 7 fechas más recientes por dispositivo y hasta 3 copias previas a una restauración.',
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
            el('p', { class: 'muted' }, 'Snapshot automático diario y después de cambios'),
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
            el('h2', {}, 'Salud de la bóveda'),
            el('p', { class: 'muted' }, 'Sincronización externa y eventos faltantes'),
          ]),
        ]),
        el('div', { class: 'card-body stack' }, [
          el('p', {
            class: 'muted',
            text:
              'La app guarda un diario local fuera de la bóveda con cada evento escrito. Si un agente de sincronización externo reemplaza un archivo y borra eventos, esta verificación los vuelve a agregar. También se ejecuta sola al arrancar y cuando se detecta un cambio externo.',
          }),
          el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              text: 'Verificar/Reparar bóveda',
              on: {
                click: async () => {
                  if (!isTauri()) return;
                  if (!_store) {
                    toast('El store de la bóveda no está disponible.', { kind: 'error' });
                    return;
                  }
                  try {
                    const report = await _store.repair();
                    const parts: string[] = [];
                    if (report.repaired > 0) parts.push(`${report.repaired} evento(s) recuperado(s)`);
                    if (report.pending > 0) parts.push(`${report.pending} pendiente(s)`);
                    if (report.stale > 0) parts.push(`${report.stale} con otra clave`);
                    if (parts.length === 0) {
                      toast(`Bóveda verificada: no faltan eventos (${report.checked} revisados).`, {
                        kind: 'success',
                      });
                    } else {
                      toast(`Reparación: ${parts.join(', ')}.`, {
                        kind: report.pending > 0 || report.stale > 0 ? 'warning' : 'success',
                        duration: 12000,
                      });
                    }
                    if (report.errors.length > 0) console.warn('journal repair', report.errors);
                    // Refrescar la UI para que aparezcan los eventos recuperados.
                    await app?.rebuild();
                  } catch (err) {
                    showError(err);
                  }
                },
              },
            }),
            el('button', {
              class: 'btn btn-ghost',
              type: 'button',
              text: 'Descartar diario local',
              on: {
                click: async () => {
                  if (!isTauri() || !_store) return;
                  const ok = await confirmDialog({
                    title: 'Descartar diario local',
                    message:
                      'Se borra el diario de recuperación de esta bóveda. Usalo solo si vas a restaurar una copia longlife o si ya verificaste que no falta nada. Antes se actualiza la copia longlife del día; los datos vivos no se tocan.',
                    confirmLabel: 'Descartar diario',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    const { invoke } = await import('@tauri-apps/api/core');
                    await invoke('longlife_run', { refresh: true });
                    const root = _store.getRoot();
                    if (!root) throw new Error('La bóveda no está inicializada.');
                    await invoke('journal_clear', { root });
                    toast(
                      'Diario local descartado. La copia longlife del día quedó actualizada.',
                      { kind: 'success' },
                    );
                  } catch (err) {
                    showError(err);
                  }
                },
              },
            }),
          ]),
        ]),
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'card-header' }, [
          el('div', {}, [
            el('h2', {}, 'Restauración manual (avanzado)'),
            el('p', { class: 'muted' }, 'Alternativa si la app no puede restaurar'),
          ]),
        ]),
        el('div', { class: 'card-body stack' }, [
          el('p', {
            class: 'muted',
            text:
              'La forma recomendada es el botón "Restaurar" de cada copia: valida el manifiesto y los hashes, guarda una copia previa, descarta el diario y bloquea la app. Si preferís hacerlo a mano:',
          }),
          el('ol', { class: 'muted small', style: { paddingLeft: '20px', lineHeight: '1.8' } }, [
            el(
              'li',
              {},
              'En "Salud de la bóveda", pulsá "Descartar diario local" y confirmá. Así la app no vuelve a agregar eventos posteriores a la copia cuando arranque.',
            ),
            el('li', {}, 'Cerrá la app por completo.'),
            el('li', {}, 'Hacé una copia de seguridad de la carpeta omega/ actual.'),
            el('li', {}, 'Copiá el contenido de longlife/<dispositivo>/<fecha>/ dentro de omega/, reemplazando los archivos.'),
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

      const currentDevice = status.deviceName ?? 'Este dispositivo';
      const currentId = status.deviceId ? status.deviceId.slice(0, 8) : '';
      statusHost.replaceChildren(
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Bóveda'),
          el('span', { class: 'small strong' }, vaultLabel(vault)),
        ]),
        vault.error
          ? el('p', { class: 'small', style: { color: 'var(--danger)' } }, vault.error)
          : el('span'),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Dispositivo actual'),
          el('span', { class: 'small strong' }, currentId ? `${currentDevice} · ${currentId}` : currentDevice),
        ]),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Última copia de este dispositivo'),
          el('span', { class: 'small strong' }, status.lastDate ?? 'Todavía ninguna'),
        ]),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Actualizada'),
          el('span', { class: 'small' }, status.lastCreatedAt ? formatDateTime(Date.parse(status.lastCreatedAt)) : '-'),
        ]),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Copias de este dispositivo'),
          el('span', { class: 'small strong' }, `${status.count} / ${status.maxDays}`),
        ]),
        el('div', { class: 'row-between' }, [
          el('span', { class: 'small muted' }, 'Copias totales (todos los dispositivos)'),
          el('span', { class: 'small strong' }, String(status.totalCount)),
        ]),
        el('p', {
          class: 'small muted mt-2',
          text: status.hasVault
            ? 'Se guarda una copia por día y por dispositivo, y se refresca tras los cambios. Se conservan 7 fechas por dispositivo y hasta 3 copias previas a restauraciones.'
            : 'Elegí una carpeta bóveda para activar las copias.',
        }),
      );

      if (entries.length === 0) {
        listHost.replaceChildren(
          el('p', { class: 'muted' }, 'Todavía no hay copias longlife. Se crea una al iniciar la app y se actualiza después de los cambios.'),
        );
      } else {
        const groups = new Map<
          string,
          { deviceId: string | null; deviceName: string; entries: LonglifeEntry[] }
        >();
        for (const entry of entries) {
          const key = entry.deviceId ?? '__legacy__';
          const group = groups.get(key);
          if (group) {
            group.entries.push(entry);
          } else {
            groups.set(key, {
              deviceId: entry.deviceId,
              deviceName:
                entry.deviceName ??
                (entry.deviceId ? `Dispositivo ${entry.deviceId.slice(0, 8)}` : 'Copias anteriores'),
              entries: [entry],
            });
          }
        }
        const ordered = [...groups.values()].sort((a, b) => {
          if (a.deviceId === status.deviceId) return -1;
          if (b.deviceId === status.deviceId) return 1;
          if (a.deviceId === null) return 1;
          if (b.deviceId === null) return -1;
          return a.deviceName.localeCompare(b.deviceName);
        });

        listHost.replaceChildren(
          ...ordered.map((group) =>
            el('div', { class: 'stack', style: { gap: '6px' } }, [
              el('div', { class: 'row-between', style: { marginTop: '8px' } }, [
                el('div', {}, [
                  el('strong', {}, group.deviceName),
                  group.deviceId === status.deviceId
                    ? el('span', { class: 'badge badge-info', style: { marginLeft: '8px' } }, 'Este dispositivo')
                    : null,
                  group.deviceId === null
                    ? el('span', { class: 'badge', style: { marginLeft: '8px' } }, 'Formato anterior')
                    : null,
                ]),
                el('span', { class: 'small muted' }, group.deviceId ? group.deviceId.slice(0, 8) : ''),
              ]),
              el(
                'div',
                { class: 'list' },
                ...group.entries.map((entry) =>
                  el(
                    'div',
                    { class: 'list-item', style: { cursor: 'default', alignItems: 'center' } },
                    el(
                      'div',
                      { class: 'list-item-main' },
                      el('div', { class: 'list-item-title' }, [
                        entry.kind === 'pre-restore' ? 'Antes de restaurar' : entry.date,
                        entry.encrypted
                          ? el('span', { class: 'badge badge-info', style: { marginLeft: '8px' } }, 'Cifrada')
                          : el('span', { class: 'badge', style: { marginLeft: '8px' } }, 'Sin cifrar'),
                        entry.valid
                          ? null
                          : el('span', { class: 'badge badge-danger', style: { marginLeft: '8px' } }, 'Inválida'),
                      ]),
                      el('div', { class: 'list-item-sub' }, [
                        `${entry.files} archivo(s) · ${bytesLabel(entry.totalBytes)}`,
                        entry.createdAt ? ` · ${formatDateTime(Date.parse(entry.createdAt))}` : '',
                      ]),
                    ),
                    el(
                      'div',
                      { class: 'btn-group' },
                      el('button', {
                        class: 'btn btn-ghost',
                        type: 'button',
                        text: 'Restaurar',
                        disabled: !entry.valid,
                        on: { click: () => void restoreEntry(entry) },
                      }),
                    ),
                  ),
                ),
              ),
            ]),
          ),
          el('p', {
            class: 'small muted',
            text: 'Ruta: <bóveda>/longlife/<dispositivo>/<fecha>/ dentro de la carpeta elegida.',
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
