function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export type SyncAutoConfig = {
  enabled: boolean;
  respect_battery_saver: boolean;
};

export type BatteryStatus = {
  power_save_mode: boolean;
  battery_level: number;
  is_charging: boolean;
  effective_mode: 'normal' | 'ahorro';
};

export type EffectiveMode = 'normal' | 'ahorro';

const DEBOUNCE_NORMAL_MS = 10_000;
const DEBOUNCE_AHORRO_MS = 60_000;
const PERIODIC_NORMAL_MS = 5 * 60 * 1000;
const PERIODIC_AHORRO_MS = 0; // sin periódico en ahorro
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;
const MIN_SYNC_INTERVAL_MS = 60_000;

let config: SyncAutoConfig = { enabled: false, respect_battery_saver: true };
let battery: BatteryStatus = { power_save_mode: false, battery_level: 100, is_charging: true, effective_mode: 'normal' };
let debounceTimer: number | null = null;
let periodicTimer: number | null = null;
let isSyncing = false;
let lastSyncAt = 0;
let consecutiveFailures = 0;
let autoSyncEnabled = false;

export function getEffectiveMode(): EffectiveMode {
  if (!config.respect_battery_saver) return 'normal';
  if (battery.power_save_mode || (battery.battery_level < 15 && !battery.is_charging)) {
    return 'ahorro';
  }
  return 'normal';
}

export function getDebounceMs(): number {
  return getEffectiveMode() === 'ahorro' ? DEBOUNCE_AHORRO_MS : DEBOUNCE_NORMAL_MS;
}

export async function loadConfig(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const root = (window as any).__storeRoot;
    if (!root) return;
    const cfg = await invoke<SyncAutoConfig>('sync_auto_get', { root });
    config = cfg;
    autoSyncEnabled = cfg.enabled;
  } catch {
    // ignore
  }
}

export async function saveConfig(enabled: boolean, respectBatterySaver: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const root = (window as any).__storeRoot;
    if (!root) return;
    await invoke('sync_auto_set', { root, enabled, respect_battery_saver: respectBatterySaver });
    config = { enabled, respect_battery_saver: respectBatterySaver };
    autoSyncEnabled = enabled;
    if (enabled) {
      startAutoSync();
    } else {
      stopAutoSync();
    }
  } catch {
    // ignore
  }
}

export async function refreshBattery(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    battery = await invoke<BatteryStatus>('battery_status');
  } catch {
    // ignore
  }
}

export function scheduleSync(reason: string): void {
  if (!autoSyncEnabled) return;
  if (isSyncing) return;
  const now = Date.now();
  if (now - lastSyncAt < MIN_SYNC_INTERVAL_MS) return;

  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    void runAutoSync(reason);
  }, getDebounceMs());
}

export async function runAutoSync(reason: string): Promise<void> {
  if (!autoSyncEnabled) return;
  if (isSyncing) return;
  const mode = getEffectiveMode();
  if (mode === 'ahorro' && reason === 'periodic') return;

  isSyncing = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // Sync all peers
    const result = await invoke<any>('sync_now');
    lastSyncAt = Date.now();
    consecutiveFailures = 0;
    console.info(`Auto-sync (${reason}): OK`, result);
  } catch (e) {
    consecutiveFailures++;
    const backoff = Math.min(BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures), BACKOFF_MAX_MS);
    console.warn(`Auto-sync (${reason}) falló, reintento en ${backoff}ms`, e);
    setTimeout(() => scheduleSync('retry'), backoff);
  } finally {
    isSyncing = false;
  }
}

export function startAutoSync(): void {
  if (!autoSyncEnabled) return;
  if (periodicTimer !== null) clearInterval(periodicTimer);
  const mode = getEffectiveMode();
  if (mode === 'normal' && PERIODIC_NORMAL_MS > 0) {
    periodicTimer = window.setInterval(() => {
      void runAutoSync('periodic');
    }, PERIODIC_NORMAL_MS);
  }
}

export function stopAutoSync(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (periodicTimer !== null) {
    clearInterval(periodicTimer);
    periodicTimer = null;
  }
}

export function onStoreAppended(): void {
  // Evitar bucle: solo disparar si no estamos en medio de un sync
  if (isSyncing) return;
  scheduleSync('change');
}

/** Un dispositivo apareció en la LAN: intentamos sincronizar sin esperar al periódico. */
export function onPeerDiscovered(): void {
  if (isSyncing) return;
  scheduleSync('discovery');
}

export function getConfig(): SyncAutoConfig {
  return { ...config };
}

export function getBattery(): BatteryStatus {
  return { ...battery };
}