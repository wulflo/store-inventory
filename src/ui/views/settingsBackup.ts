import { el, mount } from '../dom';
import { toast } from '../components/toast';
import { TauriEventStore } from '../../store/TauriEventStore';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function settingsBackupView(root: HTMLElement, store: TauriEventStore): void {
  mount(root, el('section', { class: 'view' }, [
    el('header', { class: 'view-header' }, [
      el('div', {}, [
        el('h1', {}, 'Respaldos diarios'),
        el('p', { class: 'muted' }, 'Copia de seguridad de todos los eventos JSONL al final del día, en la bóveda local y en una bóveda externa compartida.'),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h2', {}, 'Estado'),
          el('p', { class: 'muted' }, 'Último respaldo automático'),
        ]),
      ]),
      el('div', { class: 'card-body stack' }, [
        el('div', { id: 'backup-status', class: 'stack' }, [
          el('p', { class: 'muted' }, 'Cargando...'),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', id: 'backup-run' }, 'Crear/actualizar respaldo de hoy'),
          el('button', { class: 'btn btn-ghost', id: 'backup-run-force' }, 'Forzar nuevo respaldo'),
        ]),
      ]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-header' }, [
        el('div', {}, [
          el('h2', {}, 'Bóveda externa compartida'),
          el('p', { class: 'muted' }, 'Ruta de carpeta compartida con el otro equipo (Syncthing, Nextcloud, LocalSend, etc.). Se copiarán los respaldos allí.'),
        ]),
      ]),
      el('div', { class: 'card-body stack' }, [
        el('div', { class: 'field' }, [
          el('label', {}, 'Ruta de la bóveda externa'),
          el('input', { id: 'vault-path', class: 'input', placeholder: '/ruta/a/carpeta-compartida' }),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', id: 'vault-save' }, 'Guardar ruta'),
          el('button', { class: 'btn btn-ghost', id: 'vault-clear' }, 'Quitar bóveda'),
        ]),
        el('p', { class: 'muted', style: 'font-size:12px' }, 'Los respaldos se guardan en: <datos>/backups/daily/YYYY-MM-DD/ y, si hay bóveda externa, también en: <bóveda>/inventario-tienda-backup/daily/YYYY-MM-DD/'),
      ]),
    ]),
  ]));

  async function refresh() {
    const statusEl = document.getElementById('backup-status');
    if (!statusEl) return;
    statusEl.innerHTML = '';
    if (!isTauri()) {
      statusEl.appendChild(el('p', { class: 'muted' }, 'Los respaldos automáticos solo están disponibles en la app de escritorio/móvil con Tauri.'));
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) {
        statusEl.appendChild(el('p', { class: 'muted' }, 'No hay carpeta de datos configurada.'));
        return;
      }
      const st: any = await invoke('backup_status', { root });
      const items = [
        el('div', {}, [el('strong', {}, 'Último respaldo: '), el('span', {}, st.last_backup_date ? st.last_backup_date : 'Nunca')]),
        el('div', {}, [el('strong', {}, 'Fecha/hora: '), el('span', {}, st.last_backup_at ? st.last_backup_at : '-')]),
        el('div', {}, [el('strong', {}, 'Bóveda externa: '), el('span', {}, st.vault_path ? st.vault_path : 'Sin configurar')]),
        el('div', {}, [el('strong', {}, 'Bóveda accesible: '), el('span', {}, st.has_vault ? 'Sí' : st.vault_path ? 'No (ruta no existe)' : 'No')]),
      ];
      items.forEach((i) => statusEl.appendChild(i));
      const input = document.getElementById('vault-path') as HTMLInputElement | null;
      if (input && st.vault_path) input.value = st.vault_path;
    } catch (e: any) {
      statusEl.appendChild(el('p', { class: 'muted' }, e?.message || String(e)));
    }
  }

  document.getElementById('backup-run')?.addEventListener('click', async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
      const res: any = await invoke('backup_run_daily', { root, force: false });
      toast(`Respaldo ${res.date} creado (${res.files} archivos)`, { kind: 'success' });
      await refresh();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  document.getElementById('backup-run-force')?.addEventListener('click', async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
      const res: any = await invoke('backup_run_daily', { root, force: true });
      toast(`Respaldo ${res.date} regenerado (${res.files} archivos)`, { kind: 'success' });
      await refresh();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  document.getElementById('vault-save')?.addEventListener('click', async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
      const input = document.getElementById('vault-path') as HTMLInputElement;
      await invoke('backup_set_vault', { root, vault: input.value.trim() || null });
      toast('Ruta de bóveda guardada', { kind: 'success' });
      await refresh();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  document.getElementById('vault-clear')?.addEventListener('click', async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
      await invoke('backup_set_vault', { root, vault: null });
      const input = document.getElementById('vault-path') as HTMLInputElement;
      if (input) input.value = '';
      toast('Bóveda externa eliminada', { kind: 'success' });
      await refresh();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  void refresh();
}
