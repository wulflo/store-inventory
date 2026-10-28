import { el, icon } from '../dom';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  kind?: ToastKind;
  duration?: number;
  /** Acción opcional (ej: "Deshacer"). */
  action?: { label: string; onClick: () => void | Promise<void> };
}

let stack: HTMLElement | null = null;

function getStack(): HTMLElement {
  if (!stack) {
    stack = el('div', { class: 'toast-stack', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message: string, options: ToastOptions = {}): void {
  const kind = options.kind ?? 'info';
  const duration = options.duration ?? (kind === 'error' ? 6000 : 3200);

  const actionBtn = options.action
    ? el('button', {
        class: 'toast-action',
        type: 'button',
        on: {
          click: async () => {
            try {
              await options.action!.onClick();
            } finally {
              remove();
            }
          },
        },
      })
    : null;

  const node = el(
    'div',
    { class: `toast toast-${kind}` },
    el('span', { class: 'toast-msg' }, message),
    actionBtn,
  );

  const remove = () => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 0.18s ease';
    setTimeout(() => node.remove(), 200);
  };

  getStack().appendChild(node);
  const timer = setTimeout(remove, duration);
  node.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.toast-action')) return;
    clearTimeout(timer);
    remove();
  });
}

export function toastSuccess(message: string, action?: ToastOptions['action']): void {
  toast(message, { kind: 'success', action });
}

export function toastError(message: string): void {
  toast(message, { kind: 'error' });
}

export function toastWarning(message: string, action?: ToastOptions['action']): void {
  toast(message, { kind: 'warning', action });
}

/**
 * Muestra un error de validación de forma consistente.
 * Los ValidationError del dominio ya traen un mensaje en español claro.
 */
export function showError(err: unknown): void {
  // Tauri rechaza los comandos con un string (el mensaje del backend), no con
  // un Error. Si solo miramos `instanceof Error`, el usuario ve un texto
  // genérico y se pierde la causa real (IP inalcanzable, TLS, puerto ocupado).
  let message = 'Algo salió mal. Probá de nuevo.';
  if (typeof err === 'string' && err.trim()) {
    message = err;
  } else if (err instanceof Error && err.message) {
    message = err.message;
  } else if (err && typeof err === 'object' && 'message' in err) {
    const value = (err as { message?: unknown }).message;
    if (typeof value === 'string' && value.trim()) message = value;
  }
  toastError(message);
  console.error(err);
}

export { icon };
