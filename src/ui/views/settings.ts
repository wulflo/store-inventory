import { el, icon } from '../dom';
import { card, emptyState, money } from './common';
import type { Shell } from '../app';
import type { App } from '../../app/App';
import { formatDateTime } from '../../core/dates';
import { showError, toastSuccess } from '../components/toast';
import { confirmDialog, openModal } from '../components/modal';
import { CURRENCIES, getDisplayCurrency, parseMoneyToCents, setDisplayCurrency } from '../../core/money';
import { APP_VERSION } from '../../core/version';
import { ACCENTS, applyTheme, normalizeAccent, normalizeTheme, type AccentId, type ThemeName } from '../theme';
import { settingsUpdatesCard } from './settingsUpdates';
import { settingsCryptoCard } from './settingsCrypto';
import { settingsVaultCard } from './settingsVault';

export function settingsView(app: App, shell: Shell): HTMLElement {
  const view = el('div');

  /* ---------------- Datos ---------------- */
  view.appendChild(
    card({
      title: 'Dispositivo',
      content: el(
        'div',
        {},
        infoRow('Identificador', app.deviceId),
        infoRow('Almacenamiento', app.store.location()),
        infoRow('Tipo de backing store', kindLabel(app.store.kind)),
        infoRow('Eventos en la base', String(app.state.eventCount)),
        infoRow('Último HLC', String(app.state.lastHlc)),
        infoRow('Dispositivos conocidos', String(app.state.devices.size)),
        el('p', {
          class: 'small muted mt-2',
          text:
            'El identificador es de esta instalación y no viaja dentro de la bóveda. Al copiar la carpeta a otro equipo, ese equipo usa un identificador distinto: no escribas en la misma bóveda desde dos equipos a la vez.',
        }),
      ),
    }),
  );

  /* ---------------- Preferencias ---------------- */
  const currentTheme = normalizeTheme(document.documentElement.dataset.theme);
  const currentAccent = normalizeAccent(
    app.getSettingJson<string>('accent', localStorage.getItem('accent') ?? 'blue'),
  );
  const activeAccent = (): AccentId =>
    normalizeAccent(document.documentElement.dataset.accent ?? currentAccent);

  const currentCurrency = app.getSettingJson<string>('currency', 'ARS');
  const currentRate = app.getSettingJson<number>('currency_rate', 1);
  let lastRate = currentRate > 0 ? currentRate : 1;
  const formatRate = (rate: number): string => String(rate).replace('.', ',');

  const rateInput = el('input', {
    class: 'input',
    type: 'text',
    inputmode: 'decimal',
    placeholder: 'Ej. 1250,00',
    value: currentCurrency === 'ARS' ? '' : formatRate(currentRate),
  });
  const rateField = el(
    'div',
    { class: 'field', style: { display: currentCurrency === 'ARS' ? 'none' : '' } },
    el('label', { text: `Cotización (ARS por 1 ${currentCurrency === 'ARS' ? 'USD' : currentCurrency})` }),
    rateInput,
  );

  const syncRateField = (code: string): void => {
    const isArs = code === 'ARS';
    rateField.style.display = isArs ? 'none' : '';
    const label = rateField.querySelector('label');
    if (label) label.textContent = `Cotización (ARS por 1 ${code})`;
    if (isArs) rateInput.value = '';
    else if (!rateInput.value.trim()) rateInput.value = formatRate(lastRate);
  };

  const applyCurrency = async (): Promise<void> => {
    const code = currencySelect.value;
    let rate = 1;
    if (code !== 'ARS') {
      if (!rateInput.value.trim()) rateInput.value = formatRate(lastRate);
      const parsed = parseMoneyToCents(rateInput.value);
      if (!parsed || parsed <= 0) {
        syncRateField(code);
        rateInput.focus();
        throw new Error('Ingresá una cotización mayor a cero en pesos por unidad.');
      }
      rate = parsed / 100;
      lastRate = rate;
    }
    await app.setSetting('currency', code);
    if (code !== 'ARS') await app.setSetting('currency_rate', rate);
    setDisplayCurrency(code, rate);
    syncRateField(code);
    toastSuccess(
      code === 'ARS'
        ? 'Moneda de visualización: ARS.'
        : `Moneda de visualización: ${code} (1 ${code} = ARS ${rate.toLocaleString('es-AR')}).`,
    );
    // Recargar la vista para que todos los importes se reformateen.
    shell.router.navigate('/ajustes');
  };

  const currencySelect = el(
    'select',
    {
      on: {
        change: async () => {
          try {
            await applyCurrency();
          } catch (err) {
            showError(err);
          }
        },
      },
    },
    ...Object.values(CURRENCIES).map((c) =>
      el('option', {
        value: c.code,
        text: `${c.code} (${c.symbol})`,
        selected: currentCurrency === c.code,
      }),
    ),
  );

  rateInput.addEventListener('change', () => {
    if (currencySelect.value === 'ARS') return;
    void applyCurrency().catch(showError);
  });

  const themeButtons = new Map<ThemeName, HTMLButtonElement>();
  const syncThemeButtons = (theme: ThemeName): void => {
    for (const [name, button] of themeButtons) {
      button.setAttribute('aria-pressed', String(name === theme));
    }
  };
  const chooseTheme = (theme: ThemeName): void => {
    applyTheme(theme, activeAccent());
    syncThemeButtons(theme);
    void app.setSetting('theme', theme).catch(showError);
  };

  const themeRow = el('div', { class: 'row', style: { gap: '8px' } });
  for (const [theme, label] of [
    ['light', 'Claro'],
    ['dark', 'Oscuro'],
  ] as const) {
    const button = el('button', {
      class: 'btn btn-sm',
      type: 'button',
      text: label,
      'aria-pressed': String(currentTheme === theme),
      on: { click: () => chooseTheme(theme) },
    });
    themeButtons.set(theme, button);
    themeRow.appendChild(button);
  }

  const accentButtons = new Map<AccentId, HTMLButtonElement>();
  const syncAccentButtons = (accent: AccentId): void => {
    for (const [id, button] of accentButtons) {
      button.setAttribute('aria-pressed', String(id === accent));
    }
  };
  const chooseAccent = (accent: AccentId): void => {
    applyTheme(document.documentElement.dataset.theme ?? currentTheme, accent);
    syncAccentButtons(accent);
    void app.setSetting('accent', accent).catch(showError);
  };

  const accentGrid = el('div', {
    class: 'accent-grid',
    role: 'group',
    'aria-label': 'Color de acento',
  });
  for (const accent of ACCENTS) {
    const button = el('button', {
      class: 'accent-swatch',
      type: 'button',
      title: accent.label,
      'aria-label': `Color de acento ${accent.label}`,
      'aria-pressed': String(currentAccent === accent.id),
      style: { background: accent.light.primary },
      on: { click: () => chooseAccent(accent.id) },
    });
    accentButtons.set(accent.id, button);
    accentGrid.appendChild(button);
  }

  view.appendChild(
    card({
      title: 'Preferencias',
      content: el(
        'div',
        { class: 'form-row' },
        el('div', { class: 'field' }, el('label', { text: 'Moneda de visualización' }), currencySelect, rateField),
        el('div', { class: 'field' }, el('label', { text: 'Tema' }), themeRow),
        el(
          'div',
          { class: 'field', style: { gridColumn: '1 / -1' } },
          el('label', { text: 'Color de acento' }),
          accentGrid,
        ),
        el(
          'div',
          { class: 'field', style: { gridColumn: '1 / -1' } },
          el('label', { text: 'Idioma' }),
          el('p', {
            class: 'small muted',
            text:
              'Español. La traducción al inglés todavía no está implementada: se quitó la opción English para no mostrar un selector que no cambiaba la interfaz.',
          }),
        ),
        el('p', {
          class: 'small muted',
          style: { gridColumn: '1 / -1' },
          text:
            'La contabilidad se guarda siempre en centavos ARS. La moneda elegida solo cambia cómo se muestran los importes; para USD/EUR se usa la cotización manual de arriba. Los formularios siguen ingresando importes en ARS.',
        }),
      ),
    }),
  );

  /* ---------------- Datos y respaldo ---------------- */
  view.appendChild(
    card({
      title: 'Datos y respaldo',
      content: el(
        'div',
        {},
        el('p', {
          class: 'muted mb-4',
          text: 'Tus datos viven en archivos .jsonl (append-only) dentro de <bóveda>/omega. La carpeta la elegís vos y podés copiarla a un disco externo cuando quieras.',
        }),
        el(
          'div',
          { class: 'btn-group' },
          el('button', {
            class: 'btn',
            type: 'button',
            on: { click: () => void exportBackup(app) },
          }, icon('download', 18), 'Exportar copia (.json)'),
          el('button', {
            class: 'btn',
            type: 'button',
            on: { click: () => void importBackup(app, shell) },
          }, icon('upload', 18), 'Restaurar / importar'),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            on: { click: () => shell.router.navigate('/importar') },
          }, icon('orders', 18), 'Importar CSV'),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            on: { click: (e: Event) => { e.preventDefault(); shell.router.navigate('/respaldos'); } },
          }, icon('settings', 18), 'Copias longlife'),
        ),
      ),
    }),
  );

  /* ---------------- Dispositivos conocidos ---------------- */
  const devices = [...app.state.devices.values()];
  view.appendChild(
    card({
      title: 'Dispositivos',
      count: devices.length,
      content:
        devices.length === 0
          ? emptyState({
              icon: 'settings',
              title: 'Sin otros dispositivos',
              message: 'Este es el único dispositivo registrado en esta bóveda.',
            })
          : el(
              'div',
              { class: 'list' },
              ...devices.map((d) =>
                el(
                  'div',
                  { class: 'list-item', style: { cursor: 'default' } },
                  el(
                    'div',
                    { class: 'list-item-main' },
                    el('div', { class: 'list-item-title', text: d.name }),
                    el('div', { class: 'list-item-sub', text: d.id }),
                  ),
                  el('div', {
                    class: 'list-item-value xsmall dim',
                    text: formatDateTime(d.createdAt),
                  }),
                ),
              ),
            ),
    }),
  );

  /* ---------------- Zona de riesgo ---------------- */
  view.appendChild(
    card({
      title: 'Zona de riesgo',
      content: el(
        'div',
        {},
        el('button', {
          class: 'btn btn-danger',
          type: 'button',
          text: 'Vaciar todos los datos',
          on: {
            click: async () => {
              const ok = await confirmDialog({
                title: 'Vaciar todos los datos',
                message:
                  'Se borran todos los pedidos, productos, movimientos y ajustes de este dispositivo. Antes de borrar se actualiza la copia longlife del día; si esa copia falla, no se vacía nada. Esto no se puede deshacer. Exportá una copia antes si tenés dudas.',
                confirmLabel: 'Sí, vaciar todo',
                danger: true,
              });
              if (!ok) return;
              try {
                if (typeof (app.store as any).clearAll === 'function') {
                  await (app.store as any).clearAll();
                }
                await app.rebuild();
                toastSuccess('Todos los datos se vaciaron. La copia longlife previa al vaciado quedó conservada.');
                shell.router.navigate('/');
              } catch (err) {
                showError(err);
              }
            },
          },
        }),
      ),
    }),
  );

  /* ---------------- Acerca de ---------------- */
  view.appendChild(
    card({
      title: 'Acerca de',
      content: el(
        'div',
        {},
        infoRow('Versión', APP_VERSION),
        infoRow('Arquitectura', 'Event Sourcing (JSONL append-only)'),
        infoRow('Stack', 'Tauri 2 + TypeScript vanilla + Vite'),
        infoRow(
          'Moneda',
          getDisplayCurrency().code === 'ARS'
            ? 'ARS (centavos)'
            : `${getDisplayCurrency().code} (visualización; datos en ARS)`,
        ),
        infoRow('Talles', 'XS → 3XL (fijos)'),
        el('p', {
          class: 'small muted mt-4',
          text: '100% local y offline. Tus datos viven en archivos .jsonl (append-only) dentro de una carpeta elegible, sin base SQL .db.',
        }),
      ),
    }),
  );

  /* ---------------- Bóveda y cifrado ---------------- */
  view.appendChild(settingsVaultCard(shell));
  view.appendChild(settingsCryptoCard(app));

  /* ---------------- Actualizaciones ---------------- */
  view.appendChild(settingsUpdatesCard());

  return view;
}

function infoRow(label: string, value: string): HTMLElement {
  return el(
    'div',
    {
      class: 'row-between',
      style: { padding: '8px 0', borderBottom: '1px solid var(--border)', gap: '12px' },
    },
    el('span', { class: 'small muted', text: label }),
    el('span', {
      class: 'small strong mono',
      text: value,
      style: { maxWidth: '62%', textAlign: 'right', overflowWrap: 'anywhere' },
    }),
  );
}

function kindLabel(kind: string): string {
  if (kind === 'tauri') return 'Archivos en disco (.jsonl)';
  if (kind === 'web') return 'Navegador (OPFS)';
  return 'Memoria (volátil)';
}

/* ------------------------------------------------------------------ */

async function exportBackup(app: App): Promise<void> {
  const encrypted = app.store.kind === 'tauri';
  const ok = await confirmDialog({
    title: 'Exportar copia de seguridad',
    message: encrypted
      ? 'El archivo contiene todos los eventos con los payloads cifrados tal como están en disco. Los metadatos (id, tipo, fecha, equipo) siguen en claro. Guardalo en un lugar privado: para leerlo en otro equipo necesitás el mismo llavero y la contraseña maestra.'
      : 'Estás en el modo navegador de desarrollo: los payloads se exportan DESCIFRADOS. No compartas este archivo. En la app nativa el export va cifrado.',
    confirmLabel: 'Exportar',
  });
  if (!ok) return;
  try {
    const bundle = await app.store.exportAll();
    const json = JSON.stringify(bundle, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `inventario-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toastSuccess('Copia exportada.');
  } catch (err) {
    showError(err);
  }
}

async function importBackup(app: App, shell: Shell): Promise<void> {
  const input = el('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const bundle = JSON.parse(text);
      if (!bundle || bundle.format !== 'inventario-tienda/events') {
        throw new Error('El archivo no es una copia válida de Inventario Tienda.');
      }
      const ok = await confirmDialog({
        title: 'Restaurar copia',
        message:
          `Se van a agregar ${bundle.events?.length ?? 0} eventos. Los que ya tenés se ignoran (se fusiona sin duplicar).` +
          (app.store.kind === 'tauri'
            ? ' Si la copia está cifrada, este equipo debe usar el mismo llavero para poder leerla.'
            : ''),
        confirmLabel: 'Importar',
      });
      if (!ok) return;
      const result = await app.store.importBundle(bundle);
      await app.rebuild();
      toastSuccess(`Se importaron ${result.imported} evento(s). ${result.skipped} ya existían.`);
      shell.router.navigate('/');
    } catch (err) {
      showError(err);
    }
  });
  input.click();
}
