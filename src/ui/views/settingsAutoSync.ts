import { el, mount } from '../dom';
import { toast } from '../components/toast';
import { TauriEventStore } from '../../store/TauriEventStore';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function settingsAutoSyncCard(app: any): HTMLElement {
  const card = el('section', { class: 'card' }, [
    el('div', { class: 'card-header' }, [
      el('div', {}, [
        el('h2', {}, 'Sincronización automática'),
        el('p', { class: 'muted' }, 'Sincroniza con dispositivos emparejados sin intervención manual.'),
      ]),
    ]),
    el('div', { class: 'card-body stack' }, [
      el('div', { class: 'field' }, [
        el('label', { class: 'row', style: { justifyContent: 'space-between' } }, [
          el('span', {}, 'Sincronización automática'),
          el('input', { type: 'checkbox', id: 'auto-sync-enabled' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { class: 'row', style: { justifyContent: 'space-between' } }, [
          el('span', {}, 'Respetar ahorro de batería'),
          el('input', { type: 'checkbox', id: 'auto-sync-battery' }),
        ]),
      ]),
      el('div', { id: 'auto-sync-status', class: 'stack' }, [
        el('p', { class: 'muted' }, 'Cargando...'),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn', id: 'auto-sync-save' }, 'Guardar'),
        el('button', { class: 'btn btn-ghost', id: 'auto-sync-now' }, 'Sincronizar ahora'),
      ]),
    ]),
  ]);

  async function refresh() {
    const statusEl = document.getElementById('auto-sync-status');
    if (!statusEl) return;
    statusEl.innerHTML = '';
    if (!isTauri()) {
      statusEl.appendChild(el('p', { class: 'muted' }, 'Solo disponible en la app nativa.'));
      return;
    }
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const root = (app.store as TauriEventStore)?.getRoot();
      if (!root) return;
      const cfg: any = await invoke('sync_auto_get', { root });
      const battery: any = await invoke('battery_status');
      const enabledEl = document.getElementById('auto-sync-enabled') as HTMLInputElement;
      const batteryEl = document.getElementById('auto-sync-battery') as HTMLInputElement;
      if (enabledEl) enabledEl.checked = cfg.enabled;
      if (batteryEl) batteryEl.checked = cfg.respect_battery_saver;
      const mode = battery.effective_mode === 'ahorro' ? 'Ahorro' : 'Normal';
      const modeText = cfg.respect_battery_saver
        ? `Modo efectivo: ${mode}${battery.power_save_mode ? ' (por ahorro de batería del sistema)' : battery.battery_level < 15 && !battery.is_charging ? ' (batería baja)' : ''}`
        : 'Modo efectivo: Normal (ahorro de batería desactivado)';
      statusEl.appendChild(el('p', { class: 'muted' }, modeText));
      statusEl.appendChild(el('p', { class: 'muted', style: { fontSize: '12px' } }, `Batería: ${battery.battery_level}%${battery.is_charging ? ' (cargando)' : ''}`));
    } catch (e: any) {
      statusEl.appendChild(el('p', { class: 'muted' }, e?.message || String(e)));
    }
  }

  (card as any).__refresh = refresh;

  setTimeout(() => {
    document.getElementById('auto-sync-save')?.addEventListener('click', async () => {
      if (!isTauri()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const root = (app.store as TauriEventStore)?.getRoot();
        if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
        const enabledEl = document.getElementById('auto-sync-enabled') as HTMLInputElement;
        const batteryEl = document.getElementById('auto-sync-battery') as HTMLInputElement;
        await invoke('sync_auto_set', { root, enabled: enabledEl.checked, respect_battery_saver: batteryEl.checked });
        toast('Configuración guardada', { kind: 'success' });
        await refresh();
        // Recargar config en autoSync
        const { loadConfig, startAutoSync, stopAutoSync } = await import('../../sync/autoSync');
        (window as any).__storeRoot = root;
        await loadConfig();
        if (enabledEl.checked) startAutoSync(); else stopAutoSync();
      } catch (e: any) {
        toast(e?.message || String(e), { kind: 'error' });
      }
    });

    document.getElementById('auto-sync-now')?.addEventListener('click', async () => {
      if (!isTauri()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const root = (app.store as TauriEventStore)?.getRoot();
        if (!root) return toast('Sin carpeta de datos', { kind: 'error' });
        await invoke('sync_now');
        toast('Sincronización completada', { kind: 'success' });
      } catch (e: any) {
        toast(e?.message || String(e), { kind: 'error' });
      }
    });

    void refresh();
  }, 0);

  return card;
}