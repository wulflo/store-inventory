export type Language = 'es' | 'en';

const STORAGE_KEY = 'language';

let current: Language = 'es';
if (typeof localStorage !== 'undefined') {
  const stored = localStorage.getItem(STORAGE_KEY) as Language | null;
  if (stored === 'es' || stored === 'en') current = stored;
}

const dictionaries: Record<Language, Record<string, string>> = {
  es: {},
  en: {},
};

// Sync-related strings (the recently added P2P flow).
const syncStrings: Record<string, { es: string; en: string }> = {
  'sync.title': { es: 'Sincronización entre dispositivos', en: 'Device synchronization' },
  'sync.subtitle': { es: 'LAN, cifrada y sin nube', en: 'LAN, encrypted, no cloud' },
  'sync.status.active': { es: 'Activa', en: 'Active' },
  'sync.status.stopped': { es: 'Detenida', en: 'Stopped' },
  'sync.activate': { es: 'Activar', en: 'Start' },
  'sync.stop': { es: 'Detener', en: 'Stop' },
  'sync.paired': { es: 'Dispositivos emparejados', en: 'Paired devices' },
  'sync.syncAll': { es: 'Sincronizar todo', en: 'Sync all' },
  'sync.discovered': { es: 'Dispositivos en la red', en: 'Devices on the network' },
  'sync.pairedLabel': { es: 'Ya emparejado', en: 'Already paired' },
  'sync.ready': { es: 'Listo para emparejar', en: 'Ready to pair' },
  'sync.available': { es: 'Disponible', en: 'Available' },
  'sync.pair': { es: 'Emparejar', en: 'Pair' },
  'sync.scanFile': { es: 'Escanear QR (archivo)', en: 'Scan QR (file)' },
  'sync.scanCamera': { es: 'Escanear QR (cámara)', en: 'Scan QR (camera)' },
  'sync.showCode': { es: 'Mostrar mi código y esperar', en: 'Show my code and wait' },
  'sync.waiting': {
    es: 'Esperando a que el otro dispositivo se conecte. Mostrá este código QR. El código de 6 dígitos se genera al conectar.',
    en: 'Waiting for the other device to connect. Show this QR code or the 6-digit code.',
  },
  'sync.noQr': { es: 'No se encontró un código QR en la imagen.', en: 'No QR code found in the image.' },
};

for (const [key, value] of Object.entries(syncStrings)) {
  dictionaries.es[key] = value.es;
  dictionaries.en[key] = value.en;
}

export function getLanguage(): Language {
  return current;
}

export function setLanguage(lang: Language): void {
  current = lang === 'en' ? 'en' : 'es';
  localStorage.setItem(STORAGE_KEY, current);
  if (typeof document !== 'undefined') document.documentElement.lang = current;
}

export function t(key: string): string {
  return dictionaries[current][key] ?? dictionaries.es[key] ?? key;
}

// Apply on load.
if (typeof document !== 'undefined') document.documentElement.lang = current;
