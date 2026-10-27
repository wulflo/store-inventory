import { el, icon } from '../dom';
import { formatMoney } from '../../core/money';
import { DEFAULT_CURRENCY } from '../../core/money';
import type {
  ExpenseCategory,
  MovementType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  ProductionStatus,
} from '../../core/types';

export function money(cents: number, currency = DEFAULT_CURRENCY): string {
  return formatMoney(cents, currency);
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pendiente: 'Pendiente',
  en_produccion: 'En producción',
  listo: 'Listo',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  sin_pagar: 'Sin pagar',
  sena: 'Seña',
  parcial: 'Pago parcial',
  pagado: 'Pagado',
};

export const PRODUCTION_STATUS_LABEL: Record<ProductionStatus, string> = {
  planificada: 'Planificada',
  en_proceso: 'En proceso',
  completada: 'Completada',
  cancelada: 'Cancelada',
};

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  produccion: 'Producción',
  venta: 'Venta',
  ajuste_pos: 'Ajuste +',
  ajuste_neg: 'Ajuste −',
  devolucion: 'Devolución',
  inicial: 'Carga inicial',
};

export const EXPENSE_CATEGORY_LABEL: Record<ExpenseCategory, string> = {
  insumos: 'Insumos',
  envio: 'Envíos',
  publicidad: 'Publicidad',
  alquiler: 'Alquiler',
  servicios: 'Servicios',
  otros: 'Otros',
};

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  efectivo: 'Efectivo',
  transferencia: 'Transferencia',
  tarjeta: 'Tarjeta',
  mercadopago: 'Mercado Pago',
  otro: 'Otro',
};

export function statusBadge(status: OrderStatus | string, label?: string): HTMLElement {
  return el('span', {
    class: `badge badge-${status}`,
    text: label ?? ORDER_STATUS_LABEL[status as OrderStatus] ?? status,
  });
}

export function paymentBadge(status: PaymentStatus): HTMLElement {
  return el('span', {
    class: `badge badge-${status}`,
    text: PAYMENT_STATUS_LABEL[status] ?? status,
  });
}

export function emptyState(options: {
  icon?: string;
  title: string;
  message?: string;
  action?: HTMLElement;
}): HTMLElement {
  return el(
    'div',
    { class: 'empty-state' },
    el('div', { class: 'empty-icon' }, icon(options.icon ?? 'box', 26)),
    el('h3', { text: options.title }),
    options.message ? el('p', { text: options.message }) : null,
    options.action ?? null,
  );
}

export function card(options: {
  title?: string;
  subtitle?: string;
  count?: number | string;
  action?: HTMLElement | null;
  content: HTMLElement | HTMLElement[];
  className?: string;
}): HTMLElement {
  const body = Array.isArray(options.content) ? options.content : [options.content];
  return el(
    'div',
    { class: `card ${options.className ?? ''}` },
    options.title
      ? el(
          'div',
          { class: 'card-head' },
          el(
            'div',
            { class: 'row' },
            el('h3', { text: options.title }),
            options.count !== undefined
              ? el('span', { class: 'count', text: String(options.count) })
              : null,
          ),
          options.action ?? null,
        )
      : null,
    options.subtitle ? el('p', { class: 'sub small dim', text: options.subtitle }) : null,
    ...body,
  );
}

export function kpi(options: {
  label: string;
  value: string;
  hint?: string;
  accent?: 'primary' | 'success' | 'warning' | 'danger';
  icon?: string;
}): HTMLElement {
  return el(
    'div',
    { class: `kpi${options.accent ? ` accent-${options.accent}` : ''}` },
    el(
      'div',
      { class: 'kpi-label' },
      options.icon ? icon(options.icon, 16) : null,
      el('span', { text: options.label }),
    ),
    el('div', { class: 'kpi-value', text: options.value }),
    options.hint ? el('div', { class: 'kpi-hint', text: options.hint }) : null,
  );
}

export function meterRow(options: {
  label: string;
  value: string;
  percent: number;
  variant?: 'success' | 'warning' | 'danger';
}): HTMLElement {
  return el(
    'div',
    { class: 'meter-row' },
    el(
      'div',
      {},
      el(
        'div',
        { class: 'meter-label' },
        el('span', { text: options.label }),
        el('span', { class: 'meter-value', text: options.value }),
      ),
      el(
        'div',
        { class: `bar ${options.variant ?? ''}` },
        el('span', {
          style: { width: `${Math.max(0, Math.min(100, options.percent))}%` },
        }),
      ),
    ),
  );
}

/** Normaliza teléfono a formato internacional para wa.me (sin + ni espacios). */
export function whatsappNumber(phone?: string): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('54')) digits = digits.slice(2);
  if (digits.length < 8) return null;
  return `54${digits}`;
}

export function whatsappLink(phone: string | undefined, message: string): string | null {
  const num = whatsappNumber(phone);
  if (!num) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(message)}`;
}
