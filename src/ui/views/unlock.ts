import { el } from '../dom';

/**
 * Pantalla de desbloqueo previa al arranque.
 *
 * Se muestra cuando el cifrado está activado y la clave no está en memoria.
 * No hay forma de saltarla: sin la contraseña (o el código de recuperación)
 * los eventos no se pueden descifrar.
 */
export async function showUnlockScreen(host: HTMLElement, root: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  document.getElementById('boot')?.remove();

  return new Promise<void>((resolve) => {
    let usingRecovery = false;

    const input = el('input', {
      class: 'input',
      type: 'password',
      id: 'unlock-secret',
      placeholder: 'Contraseña maestra',
      autocomplete: 'current-password',
      'aria-label': 'Contraseña maestra',
    });

    const error = el('p', {
      class: 'muted',
      style: { color: 'var(--danger)', marginTop: '10px', display: 'none' },
      role: 'alert',
    });

    const submit = el('button', {
      class: 'btn btn-primary',
      type: 'submit',
      text: 'Desbloquear',
      style: { width: '100%', marginTop: '12px' },
    });

    const toggle = el('button', {
      class: 'btn btn-ghost',
      type: 'button',
      text: 'Usar código de recuperación',
      style: { width: '100%', marginTop: '6px' },
    });

    const setError = (message: string) => {
      error.textContent = message;
      error.style.display = message ? 'block' : 'none';
    };

    const setBusy = (busy: boolean) => {
      submit.disabled = busy;
      toggle.disabled = busy;
      submit.textContent = busy ? 'Desbloqueando…' : 'Desbloquear';
    };

    const doUnlock = async () => {
      const secret = input.value.trim();
      if (!secret) {
        setError(
          usingRecovery
            ? 'Ingresá tu código de recuperación.'
            : 'Ingresá tu contraseña maestra.',
        );
        input.focus();
        return;
      }
      setError('');
      setBusy(true);
      try {
        await invoke('crypto_unlock', { root, secret });
        overlay.remove();
        resolve();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        input.select();
      } finally {
        setBusy(false);
      }
    };

    toggle.addEventListener('click', () => {
      usingRecovery = !usingRecovery;
      input.type = usingRecovery ? 'text' : 'password';
      input.placeholder = usingRecovery
        ? 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX'
        : 'Contraseña maestra';
      input.autocomplete = usingRecovery ? 'off' : 'current-password';
      input.setAttribute(
        'aria-label',
        usingRecovery ? 'Código de recuperación' : 'Contraseña maestra',
      );
      toggle.textContent = usingRecovery
        ? 'Usar contraseña'
        : 'Usar código de recuperación';
      setError('');
      input.focus();
    });

    const form = el(
      'form',
      {
        on: {
          submit: (event) => {
            event.preventDefault();
            void doUnlock();
          },
        },
      },
      input,
      submit,
    );

    const card = el(
      'div',
      { class: 'card unlock-card' },
      el('h2', { text: 'Inventario cifrado' }),
      el('p', {
        class: 'muted mt-1',
        text: 'Ingresá tu contraseña maestra para desbloquear los datos de este equipo.',
      }),
      el('div', { class: 'mt-3' }, form),
      error,
      toggle,
      el('p', {
        class: 'muted mt-3',
        style: { fontSize: '12px' },
        text:
          'Si olvidaste la contraseña, usá el código de recuperación que guardaste al activar el cifrado. Sin ninguno de los dos, los datos no se pueden recuperar.',
      }),
    );

    const overlay = el('div', { class: 'boot' }, card);
    host.appendChild(overlay);
    if (!window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => input.focus(), 60);
    }
  });
}
