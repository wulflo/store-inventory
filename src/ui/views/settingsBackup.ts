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
        el('div', { id: 'backup-errors', class: 'stack' }, []),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn', id: 'backup-run' }, 'Crear/actualizar respaldo de hoy'),
          el('button', { class: 'btn btn-ghost', id: 'backup-run-force' }, 'Forzar nuevo respaldo'),
          el('button', { class: 'btn btn-ghost', id: 'backup-pull' }, 'Restaurar desde la bóveda'),
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
          el('button', { class: 'btn', id: 'vault-pick' }, 'Elegir carpeta de bóveda'),
          el('button', { class: 'btn btn-ghost', id: 'vault-clear' }, 'Quitar bóveda'),
        ]),
        el('p', { class: 'muted', style: { fontSize: '12px' } }, 'Los respaldos se guardan en: <datos>/backups/daily/YYYY-MM-DD/ y, si hay bóveda externa, también en: <bóveda>/inventario-tienda-backup/daily/YYYY-MM-DD/'),
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

      // Mostrar errores del backup anterior si existen
      const errorsEl = document.getElementById('backup-errors');
      if (errorsEl) {
        errorsEl.innerHTML = '';
      }
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
      if (res.errors && res.errors.length > 0) {
        toast(`Respaldo ${res.date} con errores: ${res.errors.join(', ')}`, { kind: 'error' });
      } else {
        toast(`Respaldo ${res.date} creado (${res.files} archivos)`, { kind: 'success' });
      }
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
      if (res.errors && res.errors.length > 0) {
        toast(`Respaldo ${res.date} con errores: ${res.errors.join(', ')}`, { kind: 'error' });
      } else {
        toast(`Respaldo ${res.date} regenerado (${res.files} archivos)`, { kind: 'success' });
      }
      await refresh();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  document.getElementById('vault-pick')?.addEventListener('click', async () => {
    if (!isTauri()) return;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const root = store.getRoot();
      if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
      const picked = await open({ directory: true, multiple: false, title: 'Elegir carpeta de bóveda' });
      if (!picked) return;
      const path = Array.isArray(picked) ? picked[0] : picked;
      if (!path) return;
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('backup_set_vault', { root, vault: path });
      toast('Bóveda guardada', { kind: 'success' });
      await refresh();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  // Verificar accesibilidad al cargar
  const checkVault = async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) return;
      const res: any = await invoke('backup_check_vault', { root });
      const errorsEl = document.getElementById('backup-errors');
      if (errorsEl) {
        errorsEl.innerHTML = '';
        if (res.path && !res.accessible) {
          const warn = el('div', { class: 'card', style: { borderColor: 'var(--danger)', padding: '8px' } }, [
            el('p', { style: { color: 'var(--danger)', margin: '0' } }, res.error || 'La bóveda no es accesible.'),
            el('button', { class: 'btn btn-ghost', style: { marginTop: '4px' }, on: { click: () => document.getElementById('vault-pick')?.click() } }, 'Elegir carpeta de nuevo'),
          ]);
          errorsEl.appendChild(warn);
        }
      }
    } catch {
      // ignore
    }
  };
  void checkVault();

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

  document.getElementById('backup-pull')?.addEventListener('click', async () => {
    if (!isTauri()) return;
    const ok = confirm('¿Restaurar datos desde la bóveda? Se fusionarán los eventos nuevos sin pisar los existentes.');
    if (!ok) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = store.getRoot();
      if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
      const res: any = await invoke('backup_pull_from_vault', { root });
      const skipped = Number(res.skipped_incompatible ?? 0);
      const base = `Restaurados ${res.added_lines} eventos nuevos de ${res.scanned_devices} dispositivo(s)`;
      if (skipped > 0) {
        toast(
          `${base}. ${skipped} evento(s) se omitieron por estar cifrados con otra clave o dañados.`,
          { kind: 'warning', duration: 9000 },
        );
      } else {
        toast(base, { kind: 'success' });
      }
      window.location.reload();
    } catch (e: any) {
      toast(e?.message || String(e), { kind: 'error' });
    }
  });

  void refresh();
}
