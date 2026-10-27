import { invoke } from '@tauri-apps/api/core';
import { APP_VERSION } from '../../core/version';
import { showError, toastSuccess } from '../components/toast';
import { el, icon, mount } from '../dom';
import { card } from './common';

/* ------------------------------------------------------------------ */
/* Actualizaciones                                                    */
/* ------------------------------------------------------------------ */

interface UpdateCheck {
  available: boolean;
  current_version: string;
  version: string | null;
  notes: string | null;
  date: string | null;
  target: string | null;
  kind: 'desktop' | 'android';
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function isAndroid(): boolean {
  return /Android/i.test(navigator.userAgent);
}

export function settingsUpdatesCard(): HTMLElement {
  const body = el('div');
  let checking = false;
  let installing = false;
  let check: UpdateCheck | null = null;
  let message = '';

  function render(): void {
    if (!isTauri()) {
      mount(
        body,
        el('p', {
          class: 'small muted',
          text: 'Las actualizaciones solo están disponibles en la app instalada.',
        }),
        versionRow(),
      );
      return;
    }

    const android = isAndroid();
    mount(
      body,
      versionRow(),
      check
        ? el(
            'div',
            { class: 'update-result' },
            el(
              'div',
              { class: 'row', style: { gap: '8px', alignItems: 'center' } },
              el('span', {
                class: check.available ? 'sync-dot on' : 'sync-dot',
              }),
              el('span', {
                class: 'small strong',
                text: check.available
                  ? `Nueva versión ${check.version} disponible`
                  : 'Tenés la última versión',
              }),
            ),
            check.notes
              ? el('p', { class: 'small muted mt-3', text: check.notes })
              : null,
            check.date
              ? el('p', { class: 'xsmall dim', text: `Publicada: ${check.date}` })
              : null,
            check.available
              ? el(
                  'button',
                  {
                    class: 'btn btn-primary mt-4',
                    type: 'button',
                    disabled: installing,
                    on: { click: () => void install() },
                  },
                  icon('download', 18),
                  installing
                    ? 'Descargando…'
                    : android
                      ? 'Descargar APK a Descargas'
                      : 'Descargar e instalar',
                )
              : null,
          )
        : null,
      message
        ? el('p', { class: 'small sync-message', role: 'status', text: message })
        : null,
      el(
        'div',
        { class: 'btn-group', style: { marginTop: '12px' } },
        el(
          'button',
          {
            class: 'btn btn-sm',
            type: 'button',
            disabled: checking || installing,
            on: { click: () => void runCheck() },
          },
          icon('download', 16),
          checking ? 'Buscando…' : 'Buscar actualizaciones',
        ),
      ),
      el('p', {
        class: 'small muted mt-3',
        text: android
          ? 'El APK se verifica con la firma oficial y se guarda en la carpeta Descargas. Después abrilo para instalar la nueva versión.'
          : 'La actualización se firma digitalmente y se instala sobre la versión actual. Puede pedir reiniciar la app.',
      }),
    );
  }

  function versionRow(): HTMLElement {
    return el(
      'div',
      { class: 'row-between', style: { padding: '8px 0', borderBottom: '1px solid var(--border)' } },
      el('span', { class: 'small muted', text: 'Versión actual' }),
      el('span', { class: 'small strong mono', text: APP_VERSION }),
    );
  }

  async function runCheck(): Promise<void> {
    checking = true;
    message = '';
    render();
    try {
      check = await Promise.race([
        invoke<UpdateCheck>('cmd_updater_check'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Tiempo agotado al buscar actualizaciones.')), 30000),
        ),
      ]);
      if (!check.available) {
        message = 'No hay actualizaciones disponibles.';
      }
    } catch (err) {
      check = null;
      showError(err);
    } finally {
      checking = false;
      render();
    }
  }

  async function install(): Promise<void> {
    if (!check?.available) return;
    installing = true;
    message = '';
    render();
    try {
      message = await Promise.race([
        invoke<string>('cmd_updater_install'),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Tiempo agotado al descargar la actualización.')), 300000),
        ),
      ]);
      toastSuccess('Actualización descargada.');
      check = null;
    } catch (err) {
      showError(err);
    } finally {
      installing = false;
      render();
    }
  }

  const cardEl = card({
    title: 'Actualizaciones',
    subtitle: 'Firmadas y verificadas',
    content: body,
  });

  render();
  return cardEl;
}
