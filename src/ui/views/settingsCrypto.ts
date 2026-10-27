import { el } from '../dom';
import { card } from './common';
import { toast } from '../components/toast';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function settingsCryptoCard(app: any): HTMLElement {
  const view = el('div');

  view.appendChild(
    card({
      title: 'Cifrado de eventos (Payload Encryption)',
      content: el('div', {}, [
        el('p', { class: 'muted', style: 'margin-bottom: 12px;' }, 'Protege el contenido de los eventos en disco. Los metadatos (id, timestamp, tipo) quedan en texto plano para sincronización y ordenamiento.'),
        el('div', { id: 'crypto-status', class: 'stack', style: 'margin-bottom: 12px;' }, [
          el('p', { class: 'muted' }, 'Cargando estado...'),
        ]),
        el('div', { class: 'field' }, [
          el('label', {}, 'Contraseña maestra'),
          el('input', { type: 'password', id: 'crypto-password', class: 'input', placeholder: 'Ingresá la contraseña maestra' }),
        ]),
        el('div', { class: 'row', style: 'margin-top: 8px;' }, [
          el('button', { class: 'btn', id: 'crypto-unlock' }, 'Desbloquear'),
          el('button', { class: 'btn btn-ghost', id: 'crypto-lock' }, 'Bloquear'),
        ]),
        el('div', { id: 'crypto-test', class: 'stack', style: 'margin-top: 12px;' }, []),
      ]),
    }),
  );

  async function refresh() {
    const statusEl = document.getElementById('crypto-status');
    if (!statusEl) return;
    statusEl.innerHTML = '';
    if (!isTauri()) {
      statusEl.appendChild(el('p', { class: 'muted' }, 'Solo disponible en la app nativa.'));
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const unlocked = await invoke<boolean>('crypto_status');
      statusEl.appendChild(el('p', {}, [
        el('strong', {}, 'Estado: '),
        el('span', { style: unlocked ? 'color: var(--success);' : 'color: var(--danger);' }, unlocked ? 'Desbloqueado (llave en RAM)' : 'Bloqueado'),
      ]));
      if (unlocked) {
        statusEl.appendChild(el('p', { class: 'muted', style: 'font-size: 12px;' }, 'Los eventos se cifran/descifran automáticamente.'));
      } else {
        statusEl.appendChild(el('p', { class: 'muted', style: 'font-size: 12px;' }, 'Ingresá la contraseña para desbloquear el cifrado.'));
      }
    } catch (e: any) {
      statusEl.appendChild(el('p', { class: 'muted', style: 'color: var(--danger);' }, e?.message || String(e)));
    }
  }

  setTimeout(() => {
    document.getElementById('crypto-unlock')?.addEventListener('click', async () => {
      if (!isTauri()) return;
      const input = document.getElementById('crypto-password') as HTMLInputElement;
      const password = input?.value || '';
      if (!password) {
        toast('Ingresá una contraseña', { kind: 'error' });
        return;
      }
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('crypto_unlock', { password });
        toast('Cifrado desbloqueado', { kind: 'success' });
        if (input) input.value = '';
        await refresh();
      } catch (e: any) {
        toast(e?.message || String(e), { kind: 'error' });
      }
    });

    document.getElementById('crypto-lock')?.addEventListener('click', async () => {
      if (!isTauri()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('crypto_lock');
        toast('Cifrado bloqueado (llave limpiada de RAM)', { kind: 'success' });
        await refresh();
      } catch (e: any) {
        toast(e?.message || String(e), { kind: 'error' });
      }
    });

    // Test de cifrado
    const testDiv = document.getElementById('crypto-test');
    if (testDiv) {
      testDiv.appendChild(el('button', { class: 'btn btn-ghost', id: 'crypto-test-btn' }, 'Probar cifrado/descifrado'));
      document.getElementById('crypto-test-btn')?.addEventListener('click', async () => {
        if (!isTauri()) return;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const encrypted = await invoke<string>('crypto_encrypt_text', { plaintext: 'Datos secretos de prueba' });
          const decrypted = await invoke<string>('crypto_decrypt_text', { encrypted });
          toast(`Cifrado OK: "${decrypted}"`, { kind: 'success' });
        } catch (e: any) {
          toast(e?.message || String(e), { kind: 'error' });
        }
      });
    }

    void refresh();
  }, 0);

  return view;
}

