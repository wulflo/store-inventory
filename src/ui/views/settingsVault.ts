import { el } from '../dom';
import { card } from './common';
import { showError } from '../components/toast';
import { confirmDialog } from '../components/modal';
import type { Shell } from '../app';
import type { VaultStatus } from './vaultSetup';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Tarjeta de la bóveda activa dentro de Ajustes.
 *
 * Cambiar de bóveda reinicia la app: el store, la clave en memoria y el
 * watcher están atados a la raíz anterior.
 */
export function settingsVaultCard(shell: Shell): HTMLElement {
  const host = el('div');

  async function refresh(): Promise<void> {
    if (!isTauri()) {
      host.replaceChildren(
        card({
          title: 'Carpeta bóveda',
          content: el('p', { class: 'muted' }, 'La bóveda solo está disponible en la app nativa.'),
        }),
      );
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<VaultStatus>('vault_status');
      const label =
        status.kind === 'saf'
          ? `${status.vaultName ?? 'Bóveda'} (Android SAF)`
          : status.vaultRoot ?? status.vaultName ?? 'Sin carpeta';

      host.replaceChildren(
        card({
          title: 'Carpeta bóveda',
          content: el('div', { class: 'stack' }, [
            el('div', { class: 'row-between' }, [
              el('span', { class: 'small muted' }, 'Bóveda activa'),
              el('span', { class: 'small strong mono' }, label),
            ]),
            el('div', { class: 'row-between' }, [
              el('span', { class: 'small muted' }, 'Datos vivos'),
              el('span', { class: 'small mono' }, status.kind === 'saf' ? 'omega/ (SAF)' : status.dataRoot ?? '-'),
            ]),
            status.error
              ? el('p', { class: 'small', style: { color: 'var(--danger)' } }, status.error)
              : el('p', {
                  class: 'small muted',
                  text: 'Todo se lee y escribe en <bóveda>/omega. Las copias diarias viven en <bóveda>/longlife.',
                }),
            el('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, [
              el('button', {
                class: 'btn btn-sm',
                type: 'button',
                text: 'Ver copias longlife',
                on: { click: () => shell.router.navigate('/respaldos') },
              }),
              el('button', {
                class: 'btn btn-sm btn-ghost',
                type: 'button',
                text: 'Cambiar carpeta',
                on: {
                  click: async () => {
                    const ok = await confirmDialog({
                      title: 'Cambiar carpeta bóveda',
                      message:
                        'La app se reiniciará y abrirá la carpeta nueva. Los datos actuales no se mueven solos: copiá omega/ manualmente si querés llevarlos.',
                      confirmLabel: 'Elegir otra carpeta',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      const next = await invoke<VaultStatus>('vault_pick');
                      if (!next.dataRoot) throw new Error('No se eligió una carpeta válida.');
                      window.location.reload();
                    } catch (err) {
                      showError(err);
                    }
                  },
                },
              }),
            ]),
          ]),
        }),
      );
    } catch (err) {
      host.replaceChildren(
        card({
          title: 'Carpeta bóveda',
          content: el('p', { class: 'muted' }, err instanceof Error ? err.message : String(err)),
        }),
      );
    }
  }

  void refresh();
  return host;
}
