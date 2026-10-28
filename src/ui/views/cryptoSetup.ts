import { el } from '../dom';
import { showRecoveryCodeModal } from './settingsCrypto';

interface EnableResult {
  recovery_code: string;
  kid: string;
  files: number;
  events: number;
  backup_dir: string;
}

/**
 * Configuración inicial obligatoria del cifrado.
 *
 * Crea el llavero (Argon2id + XChaCha20-Poly1305) y muestra el código de
 * recuperación una única vez. No se puede omitir: sin llavero la app no lee
 * ni escribe eventos.
 */
export async function showCryptoSetupScreen(host: HTMLElement, root: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  document.getElementById('boot')?.remove();

  return new Promise<void>((resolve) => {
    const password = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'Contraseña maestra (mínimo 8 caracteres)',
      autocomplete: 'new-password',
      'aria-label': 'Contraseña maestra',
    });
    const repeat = el('input', {
      class: 'input',
      type: 'password',
      placeholder: 'Repetí la contraseña maestra',
      autocomplete: 'new-password',
      'aria-label': 'Repetir contraseña maestra',
      style: { marginTop: '8px' },
    });

    const error = el('p', {
      class: 'muted',
      role: 'alert',
      style: { color: 'var(--danger)', marginTop: '10px', display: 'none' },
    });

    const button = el('button', {
      class: 'btn btn-primary',
      type: 'submit',
      text: 'Crear bóveda cifrada',
      style: { width: '100%', marginTop: '12px' },
    });

    const setError = (message: string) => {
      error.textContent = message;
      error.style.display = message ? 'block' : 'none';
    };

    const setBusy = (busy: boolean) => {
      button.disabled = busy;
      password.disabled = busy;
      repeat.disabled = busy;
      button.textContent = busy ? 'Cifrando…' : 'Crear bóveda cifrada';
    };

    const submit = async (event?: Event) => {
      event?.preventDefault();
      setError('');
      const value = password.value;
      if (value.trim().length < 8) {
        setError('La contraseña debe tener al menos 8 caracteres.');
        password.focus();
        return;
      }
      if (value !== repeat.value) {
        setError('Las contraseñas no coinciden.');
        repeat.select();
        return;
      }
      setBusy(true);
      try {
        const result = await invoke<EnableResult>('crypto_enable', {
          root,
          password: value,
        });
        password.value = '';
        repeat.value = '';
        await showRecoveryCodeModal(
          result.recovery_code,
          'Guardá este código fuera de este equipo. Es la única forma de abrir la bóveda si olvidás la contraseña.',
        );
        overlay.remove();
        resolve();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    };

    const form = el(
      'form',
      {
        on: {
          submit: (event) => {
            void submit(event);
          },
        },
      },
      password,
      repeat,
      button,
    );

    const card = el(
      'div',
      { class: 'card unlock-card' },
      el('h2', { text: 'Protegé tu bóveda' }),
      el('p', {
        class: 'muted mt-1',
        text:
          'Creá una contraseña maestra. Se usa para derivar la clave que envuelve la clave de datos: no se guarda en ningún lado y no se puede recuperar si la olvidás.',
      }),
      el(
        'ul',
        { class: 'muted small mt-3', style: { paddingLeft: '20px', lineHeight: '1.7' } },
        el('li', {}, 'Algoritmo estándar: Argon2id + XChaCha20-Poly1305.'),
        el('li', {}, 'El mismo llavero abre los datos en otro equipo con la misma contraseña.'),
        el('li', {}, 'Vas a recibir un código de recuperación de un solo uso para emergencias.'),
      ),
      el('div', { class: 'mt-3' }, form),
      error,
      el('p', {
        class: 'muted mt-3',
        style: { fontSize: '12px' },
        text:
          'Sin la contraseña ni el código de recuperación, los datos cifrados no se pueden abrir. Guardá el código en un lugar seguro antes de continuar.',
      }),
    );

    const overlay = el('div', { class: 'boot' }, card);
    host.appendChild(overlay);
    if (!window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => password.focus(), 60);
    }
  });
}
