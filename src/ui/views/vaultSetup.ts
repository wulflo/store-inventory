import { el } from '../dom';

export interface VaultStatus {
  configured: boolean;
  accessible: boolean;
  kind: string | null;
  vaultRoot: string | null;
  dataRoot: string | null;
  vaultName: string | null;
  error: string | null;
}

/**
 * Pantalla obligatoria para elegir la carpeta bóveda.
 *
 * En escritorio se abre el selector nativo; en Android se usa el selector SAF
 * y se conserva el permiso de lectura/escritura. La app no arranca sin una
 * carpeta accesible.
 */
export function showVaultSetupScreen(
  host: HTMLElement,
  status?: VaultStatus | null,
): Promise<string> {
  document.getElementById('boot')?.remove();

  return new Promise<string>((resolve) => {
    const error = el('p', {
      class: 'muted',
      role: 'alert',
      style: { color: 'var(--danger)', marginTop: '10px', display: 'none' },
    });

    const button = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Elegir carpeta bóveda',
      style: { width: '100%', marginTop: '12px' },
    });

    const setError = (message: string) => {
      error.textContent = message;
      error.style.display = message ? 'block' : 'none';
    };

    const setBusy = (busy: boolean) => {
      button.disabled = busy;
      button.textContent = busy ? 'Abriendo selector…' : 'Elegir carpeta bóveda';
    };

    button.addEventListener('click', async () => {
      setError('');
      setBusy(true);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const next = await invoke<VaultStatus>('vault_pick');
        if (!next.dataRoot) {
          throw new Error(next.error ?? 'La carpeta elegida no es válida.');
        }
        overlay.remove();
        resolve(next.dataRoot);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    });

    const current =
      status?.configured && status.vaultName
        ? el('p', {
            class: 'small muted mt-3',
            text: `Bóveda recordada: ${status.vaultName}. Si la carpeta se movió o el permiso venció, elegila de nuevo.`,
          })
        : null;

    const card = el(
      'div',
      { class: 'card unlock-card' },
      el('h2', { text: 'Elegí tu carpeta bóveda' }),
      el('p', {
        class: 'muted mt-1',
        text:
          'La app guarda todo dentro de la carpeta que elijas. Es una carpeta normal: podés copiarla, moverla o respaldarla con tus herramientas de siempre.',
      }),
      el(
        'ul',
        { class: 'muted small mt-3', style: { paddingLeft: '20px', lineHeight: '1.7' } },
        el('li', {}, [
          el('strong', { text: 'omega/' }),
          ' — datos vivos: eventos, llavero de cifrado y ajustes.',
        ]),
        el('li', {}, [
          el('strong', { text: 'longlife/' }),
          ' — copia diaria, hasta 7 días. La app no la lee sola: solo si vos movés una copia dentro de omega/.',
        ]),
      ),
      current ?? el('span'),
      button,
      error,
      el('p', {
        class: 'muted mt-3',
        style: { fontSize: '12px' },
        text:
          'El cifrado es obligatorio: en el siguiente paso vas a crear la contraseña maestra que protege los datos en este y en cualquier otro equipo.',
      }),
    );

    const overlay = el('div', { class: 'boot' }, card);
    host.appendChild(overlay);

    if (status?.configured && status.error) setError(status.error);
    setTimeout(() => button.focus(), 60);
  });
}
