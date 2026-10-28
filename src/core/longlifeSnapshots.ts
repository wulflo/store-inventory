/**
 * Disparadores del snapshot longlife.
 *
 * La copia del día no se regenera en cada evento: se espera un breve periodo
 * de calma después del último cambio. Así se evita copiar `omega` completo
 * muchas veces seguidas y, en Android, se reduce el tráfico de Foldersync.
 *
 * También se fuerza el refresco al iniciar, cada 24 h, al pasar la app a
 * segundo plano y al cerrar la ventana de escritorio.
 */

const DEBOUNCE_MS = 3 * 60 * 1000;
const DAILY_MS = 24 * 60 * 60 * 1000;

let debounceTimer: number | null = null;
let active: Promise<void> | null = null;
let rerun = false;
let initialized = false;

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function cancelTimer(): void {
  if (debounceTimer !== null) {
    window.clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

async function refreshSnapshot(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('longlife_run', { refresh: true });
  } catch (err) {
    console.warn('No se pudo actualizar la copia longlife:', err);
  }
}

async function runRefreshLoop(): Promise<void> {
  do {
    rerun = false;
    await refreshSnapshot();
  } while (rerun);
}

/**
 * Marca una escritura local. El debounce se reinicia con cada cambio para que
 * el snapshot se haga cuando la actividad se estabiliza.
 */
export function scheduleLonglifeSnapshot(): void {
  if (!isTauri()) return;
  cancelTimer();
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void flushLonglifeSnapshot();
  }, DEBOUNCE_MS);
}

/**
 * Fuerza el snapshot ahora. Si ya hay uno en curso, pide una segunda pasada y
 * devuelve la promesa actual, para que el cierre espere a que termine.
 */
export function flushLonglifeSnapshot(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  cancelTimer();
  if (active) {
    rerun = true;
    return active;
  }
  active = runRefreshLoop().finally(() => {
    active = null;
  });
  return active;
}

/** Registra los disparadores de ciclo de vida. Idempotente. */
export async function initLonglifeSnapshots(): Promise<void> {
  if (!isTauri() || initialized) return;
  initialized = true;

  window.setInterval(() => {
    void flushLonglifeSnapshot();
  }, DAILY_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushLonglifeSnapshot();
    }
  });

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const currentWindow = getCurrentWindow();
    let closing = false;
    await currentWindow.onCloseRequested(async (event) => {
      if (closing) return;
      event.preventDefault();
      closing = true;
      try {
        await flushLonglifeSnapshot();
      } finally {
        try {
          await currentWindow.destroy();
        } catch (err) {
          console.warn('No se pudo cerrar la ventana después del snapshot:', err);
        }
      }
    });
  } catch (err) {
    console.warn('No se pudo registrar el snapshot al cerrar:', err);
  }

  void flushLonglifeSnapshot();
}
