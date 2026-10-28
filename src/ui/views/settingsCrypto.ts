import { el } from '../dom';
import { card } from './common';
import { toast } from '../components/toast';
import { confirmDialog, openModal } from '../components/modal';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

interface BootState {
  enabled: boolean;
  unlocked: boolean;
  kid?: string | null;
}

interface MigrationReport {
  files: number;
  events: number;
  backup_dir: string;
}

interface MigrationResult extends MigrationReport {
  recovery_code: string;
  kid: string;
}

async function invokeCmd<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function warnBox(...children: Array<HTMLElement | string>): HTMLElement {
  return el(
    'div',
    {
      class: 'crypto-warning',
      style: {
        border: '1px solid var(--warning, #b45309)',
        background: 'rgba(180, 83, 9, 0.08)',
        borderRadius: '8px',
        padding: '10px 12px',
        marginBottom: '12px',
        fontSize: '13px',
      },
    },
    ...children,
  );
}

function passwordField(label: string, placeholder: string): {
  wrap: HTMLElement;
  input: HTMLInputElement;
} {
  const input = el('input', {
    class: 'input',
    type: 'password',
    placeholder,
    autocomplete: 'new-password',
  });
  const wrap = el(
    'div',
    { class: 'field', style: { marginBottom: '10px' } },
    el('label', { text: label }),
    input,
  );
  return { wrap, input };
}

function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.resolve().then(() => {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  });
}

function downloadText(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Refresca la copia longlife del día después de un cambio de clave.
 *
 * Así la bóveda no conserva el snapshot de hoy con la clave vieja. Si falla,
 * no se oculta: el cifrado ya está activo y solo se avisa que la copia quedó
 * desactualizada.
 */
async function refreshDailyBackup(): Promise<void> {
  try {
    await invokeCmd('longlife_run', { force: true });
  } catch (err) {
    toast(
      `El cifrado quedó activo, pero no se pudo actualizar la copia longlife del día: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { kind: 'error', duration: 10000 },
    );
  }
}

/** Muestra el código de recuperación una única vez, con copiar y descargar. */
export function showRecoveryCodeModal(code: string, note?: string): Promise<void> {
  return new Promise((resolve) => {
    const copyBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Copiar',
    on: {
      click: async () => {
        try {
          await copyToClipboard(code);
          toast('Código copiado', { kind: 'success' });
        } catch {
          toast('No se pudo copiar. Seleccionalo a mano.', { kind: 'error' });
        }
      },
    },
  });

  const downloadBtn = el('button', {
    class: 'btn',
    type: 'button',
    text: 'Descargar .txt',
    on: {
      click: () => {
        downloadText(
          'inventario-tienda-codigo-recuperacion.txt',
          [
            'Inventario Tienda — Código de recuperación',
            '',
            code,
            '',
            'Guardá este código en un lugar seguro.',
            'Sirve para abrir tus datos si olvidás la contraseña maestra.',
            'Sin la contraseña ni este código, los datos cifrados no se pueden recuperar.',
            '',
            `Generado: ${new Date().toLocaleString()}`,
          ].join('\n'),
        );
      },
    },
  });

  const modal = openModal({
    title: 'Código de recuperación',
    subtitle: 'Guardalo ahora: no se vuelve a mostrar.',
    body: [
      warnBox(
        el('strong', { text: 'Importante: ' }),
        'si olvidás la contraseña y perdés este código, los datos cifrados no se pueden recuperar. No hay forma de saltarlo.',
      ),
      el(
        'div',
        {
          style: {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '15px',
            letterSpacing: '0.04em',
            padding: '12px',
            borderRadius: '8px',
            background: 'var(--surface-2, rgba(127,127,127,0.12))',
            wordBreak: 'break-all',
            textAlign: 'center',
          },
        },
        code,
      ),
      note
        ? el('p', { class: 'muted', style: { marginTop: '10px' } }, note)
        : el('p'),
      el('p', {
        class: 'muted',
        style: { marginTop: '10px', fontSize: '12px' },
        text:
          'Podés pegar este código en la pantalla de desbloqueo con la opción "Usar código de recuperación".',
      }),
    ],
    actions: [
      copyBtn,
      downloadBtn,
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        text: 'Ya lo guardé',
        on: { click: () => modal.close() },
      }),
    ],
    onClose: () => resolve(),
  });
  });
}

export function settingsCryptoCard(app: any): HTMLElement {
  const host = el('div');
  const store = app?.store;
  const root: string | null =
    typeof store?.getRoot === 'function' ? store.getRoot() : null;

  let state: BootState | null = null;

  function renderUnavailable(message: string): void {
    host.replaceChildren(
      card({
        title: 'Cifrado de datos',
        content: el('p', { class: 'muted' }, message),
      }),
    );
  }

  async function refresh(): Promise<void> {
    if (!isTauri() || !root) {
      renderUnavailable('El cifrado de datos solo está disponible en la app nativa.');
      return;
    }
    try {
      state = await invokeCmd<BootState>('crypto_boot_state', { root });
      render();
    } catch (err) {
      renderUnavailable(
        `No se pudo leer el estado del cifrado: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /* ---------------------------------------------------------------- */
  /* Activar / importar                                               */
  /* ---------------------------------------------------------------- */

  function fileField(label: string): { wrap: HTMLElement; input: HTMLInputElement } {
    const input = el('input', {
      class: 'input',
      type: 'file',
      accept: '.json,application/json',
    });
    const wrap = el(
      'div',
      { class: 'field', style: { marginBottom: '10px' } },
      el('label', { text: label }),
      input,
    );
    return { wrap, input };
  }

  async function readPickedFile(
    input: HTMLInputElement,
  ): Promise<string | null> {
    const file = input.files?.[0];
    if (!file) return null;
    return file.text();
  }

  function openImportModal(): void {
    if (!root) return;
    const file = fileField('Archivo del llavero (keyring.json)');
    const secret = passwordField(
      'Contraseña maestra o código de recuperación del otro equipo',
      'Contraseña o código',
    );
    const error = el('p', {
      class: 'muted',
      style: { color: 'var(--danger)', marginTop: '6px', display: 'none' },
    });
    const submit = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Importar y desbloquear',
    });

    const modal = openModal({
      title: 'Importar llavero',
      subtitle: 'Para usar la misma clave que otro equipo.',
      body: [
        el('p', { class: 'muted' }, [
          'Elegí el archivo ',
          el('code', { text: 'keyring.json' }),
          ' exportado desde el otro equipo (Ajustes > Cifrado > Exportar llavero) o incluido en un respaldo. El archivo no contiene tu contraseña.',
        ]),
        el('div', { style: { marginTop: '12px' } }, file.wrap, secret.wrap),
        error,
      ],
      actions: [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Cancelar',
          on: { click: () => modal.close() },
        }),
        submit,
      ],
    });

    submit.addEventListener('click', async () => {
      const showError = (message: string) => {
        error.textContent = message;
        error.style.display = 'block';
      };
      if (!file.input.files?.length) {
        showError('Elegí el archivo keyring.json.');
        return;
      }
      if (!secret.input.value.trim()) {
        showError('Ingresá la contraseña o el código de recuperación.');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Importando…';
      try {
        const keyringJson = await readPickedFile(file.input);
        if (!keyringJson) {
          showError('No se pudo leer el archivo elegido.');
          return;
        }
        const result = await invokeCmd<MigrationReport>(
          'crypto_import_keyring',
          {
            root,
            keyringJson,
            secret: secret.input.value.trim(),
          },
        );
        modal.close();
        toast(
          result.events > 0
            ? `Cifrado importado y desbloqueado. Se cifraron ${result.events} eventos existentes en ${result.files} archivos.`
            : 'Cifrado importado y desbloqueado',
          { kind: 'success', duration: result.events > 0 ? 8000 : undefined },
        );
        await refresh();
        void refreshDailyBackup();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
      } finally {
        submit.disabled = false;
        submit.textContent = 'Importar y desbloquear';
      }
    });
  }

  function openAdoptModal(): void {
    if (!root) return;
    const file = fileField('Archivo del llavero nuevo (keyring.json)');
    const current = passwordField(
      'Contraseña actual de este equipo o código de recuperación',
      'Contraseña actual',
    );
    const next = passwordField(
      'Contraseña del llavero importado',
      'Contraseña nueva (la del otro equipo)',
    );
    const error = el('p', {
      class: 'muted',
      style: { color: 'var(--danger)', marginTop: '6px', display: 'none' },
    });
    const adopt = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Adoptar llavero y migrar',
    });

    const modal = openModal({
      title: 'Adoptar llavero de otro equipo',
      subtitle: 'Para volver a abrir los datos en otro equipo después de una rotación.',
      wide: true,
      body: [
        el('p', { class: 'muted' }, [
          'Elegí el ',
          el('code', { text: 'keyring.json' }),
          ' exportado por el equipo que rotó la clave. Este equipo descifrará sus eventos con la clave vieja y los volverá a cifrar con la nueva.',
        ]),
        el('div', { style: { marginTop: '12px' } }, file.wrap, current.wrap, next.wrap),
        error,
      ],
      actions: [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Cancelar',
          on: { click: () => modal.close() },
        }),
        adopt,
      ],
    });

    adopt.addEventListener('click', async () => {
      const showError = (message: string) => {
        error.textContent = message;
        error.style.display = 'block';
      };
      if (!file.input.files?.length) {
        showError('Elegí el archivo keyring.json.');
        return;
      }
      if (!current.input.value.trim() || !next.input.value.trim()) {
        showError('Completá las dos contraseñas.');
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Adoptar llavero',
        message:
          'Se guardará un respaldo y se re-cifrarán los eventos locales con la clave nueva. ¿Continuar?',
        confirmLabel: 'Adoptar llavero',
        danger: true,
      });
      if (!confirmed) return;

      adopt.disabled = true;
      adopt.textContent = 'Migrando…';
      try {
        const keyringJson = await readPickedFile(file.input);
        if (!keyringJson) {
          showError('No se pudo leer el archivo elegido.');
          return;
        }
        const result = await invokeCmd<MigrationReport>(
          'crypto_adopt_keyring',
          {
            root,
            keyringJson,
            currentSecret: current.input.value.trim(),
            newSecret: next.input.value.trim(),
          },
        );
        modal.close();
        toast(
          `Llavero adoptado: ${result.events} eventos re-cifrados en ${result.files} archivos.`,
          { kind: 'success', duration: 8000 },
        );
        await refresh();
        void refreshDailyBackup();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        await refresh().catch(() => undefined);
      } finally {
        adopt.disabled = false;
        adopt.textContent = 'Adoptar llavero y migrar';
      }
    });
  }

  function renderEnable(): HTMLElement {
    const password = passwordField('Contraseña maestra', 'Mínimo 8 caracteres');
    const repeat = passwordField('Repetir contraseña', 'Repetí la contraseña');
    const enableBtn = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Activar cifrado',
    });

    enableBtn.addEventListener('click', async () => {
      if (!root) return;
      const value = password.input.value;
      if (value.length < 8) {
        toast('La contraseña debe tener al menos 8 caracteres.', { kind: 'error' });
        password.input.focus();
        return;
      }
      if (value !== repeat.input.value) {
        toast('Las contraseñas no coinciden.', { kind: 'error' });
        repeat.input.focus();
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Activar cifrado',
        message:
          'Se respaldarán y cifrarán todos los eventos existentes. A partir de ahora, este equipo pedirá la contraseña al abrir. La operación no se puede deshacer sola: para volver atrás hay que restaurar un respaldo.',
        confirmLabel: 'Cifrar mis datos',
        danger: true,
      });
      if (!confirmed) return;

      enableBtn.disabled = true;
      enableBtn.textContent = 'Cifrando…';
      try {
        const result = await invokeCmd<MigrationResult>('crypto_enable', {
          root,
          password: value,
        });
        password.input.value = '';
        repeat.input.value = '';
        showRecoveryCodeModal(
          result.recovery_code,
          `Se cifraron ${result.events} eventos en ${result.files} archivos. Respaldo previo dentro de omega/: ${result.backup_dir}`,
        );
        await refresh();
        void refreshDailyBackup();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
        await refresh().catch(() => undefined);
        enableBtn.disabled = false;
        enableBtn.textContent = 'Activar cifrado';
      }
    });

    return card({
      title: 'Cifrado de datos',
      subtitle: 'Protege el contenido de los eventos en disco.',
      content: [
        el('p', {
          class: 'muted',
          style: { marginBottom: '12px' },
          text:
            'Los payloads se cifran con XChaCha20-Poly1305. Los metadatos (id, tipo, fecha, equipo) quedan en claro para poder ordenar y deduplicar.',
        }),
        warnBox(
          el('strong', { text: 'Antes de activar: ' }),
          'guardá el código de recuperación que se muestra al final. Sin la contraseña ni el código, los datos no se pueden abrir. Las copias longlife anteriores a la activación pueden seguir conteniendo texto plano.',
        ),
        password.wrap,
        repeat.wrap,
        el('div', { class: 'row', style: { marginTop: '4px' } }, enableBtn),
        el('hr', { style: { margin: '18px 0', opacity: '0.3' } }),
        el('p', {
          class: 'muted',
          style: { marginBottom: '8px' },
          text:
            '¿Ya usás el cifrado en otro equipo? Importá su llavero para compartir la misma clave. Si en cambio activás acá, se crea una clave nueva y los datos del otro equipo no se podrán abrir con esta contraseña hasta que importes el llavero del otro lado.',
        }),
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Importar llavero de otro equipo',
          on: { click: () => openImportModal() },
        }),
      ],
    });
  }

  /* ---------------------------------------------------------------- */
  /* Cambiar contraseña / rotar                                       */
  /* ---------------------------------------------------------------- */

  function openChangePasswordModal(): void {
    if (!root) return;
    const current = passwordField(
      'Contraseña actual o código de recuperación',
      'Contraseña actual',
    );
    const next = passwordField('Nueva contraseña', 'Mínimo 8 caracteres');
    const repeat = passwordField('Repetir nueva contraseña', 'Repetí la contraseña');
    const error = el('p', {
      class: 'muted',
      style: { color: 'var(--danger)', marginTop: '6px', display: 'none' },
    });
    const save = el('button', {
      class: 'btn btn-primary',
      type: 'button',
      text: 'Cambiar contraseña',
    });

    const modal = openModal({
      title: 'Cambiar contraseña',
      subtitle: 'No se vuelven a cifrar los eventos: solo cambia la protección de la clave.',
      body: [
        current.wrap,
        next.wrap,
        repeat.wrap,
        error,
        el('p', {
          class: 'muted',
          style: { fontSize: '12px' },
          text:
            'Si olvidaste la contraseña, podés usar el código de recuperación en el primer campo y fijar una contraseña nueva.',
        }),
      ],
      actions: [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Cancelar',
          on: { click: () => modal.close() },
        }),
        save,
      ],
    });

    save.addEventListener('click', async () => {
      const showError = (message: string) => {
        error.textContent = message;
        error.style.display = 'block';
      };
      if (!current.input.value.trim()) {
        showError('Ingresá tu contraseña actual o el código de recuperación.');
        return;
      }
      if (next.input.value.length < 8) {
        showError('La nueva contraseña debe tener al menos 8 caracteres.');
        return;
      }
      if (next.input.value !== repeat.input.value) {
        showError('Las contraseñas nuevas no coinciden.');
        return;
      }
      save.disabled = true;
      save.textContent = 'Cambiando…';
      try {
        await invokeCmd('crypto_change_password', {
          root,
          currentSecret: current.input.value.trim(),
          newPassword: next.input.value,
        });
        modal.close();
        toast('Contraseña cambiada', { kind: 'success' });
        await refresh();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        save.disabled = false;
        save.textContent = 'Cambiar contraseña';
      }
    });
  }

  function openRotateModal(): void {
    if (!root) return;
    const current = passwordField(
      'Contraseña actual o código de recuperación',
      'Contraseña actual',
    );
    const next = passwordField('Contraseña de la clave nueva', 'Mínimo 8 caracteres');
    const repeat = passwordField('Repetir contraseña nueva', 'Repetí la contraseña');
    const error = el('p', {
      class: 'muted',
      style: { color: 'var(--danger)', marginTop: '6px', display: 'none' },
    });
    const rotate = el('button', {
      class: 'btn btn-danger',
      type: 'button',
      text: 'Rotar clave y re-cifrar',
    });

    const modal = openModal({
      title: 'Rotar clave',
      subtitle: 'Genera una clave nueva y vuelve a cifrar todos los eventos.',
      wide: true,
      body: [
        warnBox(
          el('strong', { text: 'Usalo para revocar un equipo. ' }),
          'Los demás equipos dejarán de poder leer los eventos nuevos hasta que importen el llavero nuevo. Se guarda un respaldo antes de empezar.',
        ),
        current.wrap,
        next.wrap,
        repeat.wrap,
        error,
      ],
      actions: [
        el('button', {
          class: 'btn btn-ghost',
          type: 'button',
          text: 'Cancelar',
          on: { click: () => modal.close() },
        }),
        rotate,
      ],
    });

    rotate.addEventListener('click', async () => {
      const showError = (message: string) => {
        error.textContent = message;
        error.style.display = 'block';
      };
      if (!current.input.value.trim()) {
        showError('Ingresá tu contraseña actual o el código de recuperación.');
        return;
      }
      if (next.input.value.length < 8) {
        showError('La contraseña nueva debe tener al menos 8 caracteres.');
        return;
      }
      if (next.input.value !== repeat.input.value) {
        showError('Las contraseñas nuevas no coinciden.');
        return;
      }
      const confirmed = await confirmDialog({
        title: 'Rotar la clave',
        message:
          'Se re-cifrarán todos los eventos con una clave nueva. Los demás equipos necesitarán el llavero nuevo. ¿Continuar?',
        confirmLabel: 'Rotar clave',
        danger: true,
      });
      if (!confirmed) return;

      rotate.disabled = true;
      rotate.textContent = 'Rotando…';
      try {
        const result = await invokeCmd<MigrationResult>('crypto_rotate', {
          root,
          currentSecret: current.input.value.trim(),
          newPassword: next.input.value,
        });
        modal.close();
        showRecoveryCodeModal(
          result.recovery_code,
          `Se re-cifraron ${result.events} eventos en ${result.files} archivos. Respaldo previo dentro de omega/: ${result.backup_dir}`,
        );
        await refresh();
        void refreshDailyBackup();
      } catch (err) {
        showError(err instanceof Error ? err.message : String(err));
        await refresh().catch(() => undefined);
        rotate.disabled = false;
        rotate.textContent = 'Rotar clave y re-cifrar';
      }
    });
  }

  async function exportKeyring(): Promise<void> {
    if (!root) return;
    try {
      const json = await invokeCmd<string>('crypto_keyring_json', { root });
      const area = el('textarea', {
        class: 'input',
        readOnly: true,
        rows: 10,
        style: {
          width: '100%',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: '11px',
          marginTop: '10px',
        },
      });
      area.value = json;

      const modal = openModal({
        title: 'Exportar llavero',
        subtitle: 'No contiene tu contraseña, pero es necesario para abrir los datos.',
        wide: true,
        body: [
          el('p', {
            class: 'muted',
            text:
              'Llevá este archivo al otro equipo e importalo desde Ajustes > Cifrado > Importar llavero. Después ingresá allí la misma contraseña maestra.',
          }),
          area,
        ],
        actions: [
          el('button', {
            class: 'btn',
            type: 'button',
            text: 'Copiar JSON',
            on: {
              click: async () => {
                try {
                  await copyToClipboard(json);
                  toast('Llavero copiado', { kind: 'success' });
                } catch {
                  area.select();
                  toast('No se pudo copiar. Usá Ctrl+C con el texto seleccionado.', {
                    kind: 'error',
                  });
                }
              },
            },
          }),
          el('button', {
            class: 'btn',
            type: 'button',
            text: 'Descargar keyring.json',
            on: {
              click: () =>
                downloadText('inventario-tienda-keyring.json', json),
            },
          }),
          el('button', {
            class: 'btn btn-primary',
            type: 'button',
            text: 'Listo',
            on: { click: () => modal.close() },
          }),
        ],
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
    }
  }

  async function lockNow(): Promise<void> {
    if (!root || !state?.unlocked) return;
    const confirmed = await confirmDialog({
      title: 'Bloquear el cifrado',
      message:
        'La clave se borra de la memoria y la app vuelve a la pantalla de desbloqueo. No se pierde nada.',
      confirmLabel: 'Bloquear',
    });
    if (!confirmed) return;
    try {
      await invokeCmd('crypto_lock');
      window.location.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  function renderEnabled(): HTMLElement {
    const unlocked = state?.unlocked ?? false;
    const kid = state?.kid ?? '—';

    return card({
      title: 'Cifrado de datos',
      subtitle: 'Activado en este equipo.',
      content: [
        el(
          'div',
          {
            class: 'row',
            style: {
              alignItems: 'center',
              gap: '8px',
              marginBottom: '6px',
              flexWrap: 'wrap',
            },
          },
          el('strong', { text: 'Estado: ' }),
          el(
            'span',
            {
              style: {
                color: unlocked ? 'var(--success, #15803d)' : 'var(--danger, #b91c1c)',
                fontWeight: '600',
              },
            },
            unlocked ? 'Desbloqueado' : 'Bloqueado',
          ),
        ),
        el('p', {
          class: 'muted',
          style: { fontSize: '12px', marginBottom: '12px' },
        }, [
          'Huella de la clave: ',
          el('code', { text: kid }),
          '. Todos los equipos que comparten los datos deben mostrar la misma huella.',
        ]),
        el('p', {
          class: 'muted',
          style: { marginBottom: '12px' },
          text:
            'El payload de cada evento se cifra en disco y se descifra al leerlo con la clave de la bóveda. El mismo llavero permite abrir los datos en otro equipo usando la misma contraseña.',
        }),
        el(
          'div',
          { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
          el('button', {
            class: 'btn',
            type: 'button',
            text: 'Bloquear',
            on: { click: () => void lockNow() },
          }),
          el('button', {
            class: 'btn',
            type: 'button',
            text: 'Cambiar contraseña',
            on: { click: () => openChangePasswordModal() },
          }),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: 'Exportar llavero',
            on: { click: () => void exportKeyring() },
          }),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            text: 'Adoptar llavero…',
            on: { click: () => openAdoptModal() },
          }),
        ),
        el('hr', { style: { margin: '18px 0', opacity: '0.3' } }),
        el('p', {
          class: 'muted',
          style: { marginBottom: '8px', fontSize: '13px' },
          text:
            'Rotar la clave genera una clave nueva y re-cifra todos los eventos. Es la forma de revocar un equipo que ya no debería leer los datos.',
        }),
        el('button', {
          class: 'btn btn-danger',
          type: 'button',
          text: 'Rotar clave…',
          on: { click: () => openRotateModal() },
        }),
      ],
    });
  }

  function render(): void {
    if (!isTauri() || !root) {
      renderUnavailable('El cifrado de datos solo está disponible en la app nativa.');
      return;
    }
    if (!state) return;
    host.replaceChildren(state.enabled ? renderEnabled() : renderEnable());
  }

  void refresh();
  return host;
}
