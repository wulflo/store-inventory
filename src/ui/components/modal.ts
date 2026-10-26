import { el, icon } from '../dom';

export interface ModalOptions {
  title: string;
  subtitle?: string;
  wide?: boolean;
  /** Contenido principal. */
  body: HTMLElement | HTMLElement[];
  /** Botones del pie. */
  actions?: HTMLElement[];
  /** Se invoca al cerrar. */
  onClose?: () => void;
}

export interface ModalHandle {
  close: () => void;
  element: HTMLElement;
}

export function openModal(options: ModalOptions): ModalHandle {
  const bodyNodes = Array.isArray(options.body) ? options.body : [options.body];

  const closeBtn = el('button', {
    class: 'btn-icon',
    type: 'button',
    'aria-label': 'Cerrar',
    on: { click: () => handle.close() },
  });
  closeBtn.appendChild(icon('close', 20));

  const modal = el(
    'div',
    { class: `modal${options.wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
    el(
      'div',
      { class: 'modal-head' },
      el(
        'div',
        { class: 'grow' },
        el('h3', { text: options.title }),
        options.subtitle ? el('div', { class: 'sub', text: options.subtitle }) : null,
      ),
      closeBtn,
    ),
    ...bodyNodes,
    options.actions && options.actions.length
      ? el('div', { class: 'modal-foot' }, ...options.actions)
      : null,
  );

  const backdrop = el('div', { class: 'modal-backdrop' }, modal);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) handle.close();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') handle.close();
  };
  document.addEventListener('keydown', onKey);

  function handle_close() {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    options.onClose?.();
  }

  const handle: ModalHandle = {
    close: handle_close,
    element: modal,
  };

  document.body.appendChild(backdrop);
  // Foco en el primer input del modal.
  setTimeout(() => {
    const focusable = modal.querySelector<HTMLElement>(
      'input:not([type=hidden]), select, textarea, button.btn-primary',
    );
    focusable?.focus();
  }, 30);

  return handle;
}

/**
 * Modal con confirmación asíncrona: muestra spinner en el botón y
 * cierra solo si la operación terminó bien.
 */
export function openModalLazy(options: {
  title: string;
  subtitle?: string;
  body: HTMLElement | HTMLElement[];
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose?: () => void;
}): ModalHandle {
  const bodyNodes = Array.isArray(options.body) ? options.body : [options.body];
  const confirmBtn = el('button', {
    class: 'btn btn-primary',
    type: 'button',
    text: options.confirmLabel ?? 'Guardar',
  });

  const modal = openModal({
    title: options.title,
    subtitle: options.subtitle,
    body: bodyNodes,
    actions: [
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Cancelar',
        on: { click: () => modal.close() },
      }),
      confirmBtn,
    ],
    onClose: options.onClose,
  });

  confirmBtn.addEventListener('click', async () => {
    confirmBtn.setAttribute('disabled', '');
    confirmBtn.textContent = 'Guardando…';
    try {
      await options.onConfirm();
      modal.close();
    } catch (err) {
      confirmBtn.removeAttribute('disabled');
      confirmBtn.textContent = options.confirmLabel ?? 'Guardar';
      throw err;
    }
  });

  return modal;
}

/** Diálogo de confirmación con opción de deshacer. */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const confirmBtn = el('button', {
      class: `btn ${options.danger ? 'btn-danger' : 'btn-primary'}`,
      type: 'button',
      text: options.confirmLabel ?? 'Confirmar',
      on: {
        click: () => {
          done(true);
          modal.close();
        },
      },
    });

    const modal = openModal({
      title: options.title,
      body: el('p', { class: 'muted', text: options.message }),
      actions: [
        el('button', {
          class: 'btn',
          type: 'button',
          text: 'Cancelar',
          on: {
            click: () => {
              done(false);
              modal.close();
            },
          },
        }),
        confirmBtn,
      ],
      onClose: () => done(false),
    });
  });
}
