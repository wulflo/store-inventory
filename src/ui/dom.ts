/**
 * Helper mínimo de DOM. Sin framework: alcanza para una app de formularios
 * y grillas, y arranca en <1s.
 */

type Attrs = Record<string, unknown>;
type Child = Node | string | number | null | undefined | false | Child[];

export interface ElOptions extends Attrs {
  class?: string;
  text?: string;
  html?: string;
  on?: Record<string, EventListenerOrEventListenerObject>;
  /** Objeto de propiedades CSS o, por compatibilidad, una cadena CSS ("color: red;"). */
  style?: Partial<CSSStyleDeclaration> | Record<string, string> | string;
  dataset?: Record<string, string>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { class: className, text, html, on, style, dataset, ...attrs } = options;

  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (html !== undefined) node.innerHTML = html;

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }

  if (on) {
    for (const [event, handler] of Object.entries(on)) {
      node.addEventListener(event, handler);
    }
  }

  if (style) {
    if (typeof style === 'string') {
      node.style.cssText = style;
    } else {
      for (const [key, value] of Object.entries(style)) {
        if (value === undefined) continue;
        const prop = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        node.style.setProperty(prop, String(value));
      }
    }
  }

  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      node.dataset[key] = value;
    }
  }

  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) {
      append(parent, child);
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function mount(container: HTMLElement, ...children: Child[]): void {
  clear(container);
  append(container, children);
}

/** Icono SVG inline (set mínimo, sin dependencias). */
const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  orders:
    '<path d="M6 2h12a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2-3 2V4a2 2 0 0 1 2-2zm2 5h8v2H8zm0 4h8v2H8zm0 4h5v2H8z"/>',
  production:
    '<path d="M3 20h18v2H3zM5 18V9l5-4 3 2.5V18zm9 0V8.5L17 6l2 2v10z"/>',
  stock:
    '<path d="M3 7l9-4 9 4-9 4zm2 2.6V17c0 1.7 3.6 3 7 3s7-1.3 7-3V9.6l-7 3.1z"/>',
  products:
    '<path d="M12 2 2 7l10 5 10-5zm-9 8.3V19c0 1.7 4 3 9 3s9-1.3 9-3V10.3l-9 4z"/>',
  customers:
    '<path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-4.4 0-8 2.2-8 5v3h16v-3c0-2.8-3.6-5-8-5z"/>',
  reports:
    '<path d="M4 20h16v2H2V2h2zm3-2V10h3v8zm5 0V4h3v14zm5 0v-6h3v6z"/>',
  settings:
    '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.4 4c0 .5 0 1-.1 1.4l2 1.6-2 3.4-2.4-1a7.7 7.7 0 0 1-2.4 1.4l-.4 2.6h-4l-.4-2.6a7.7 7.7 0 0 1-2.4-1.4l-2.4 1-2-3.4 2-1.6a8 8 0 0 1 0-2.8l-2-1.6 2-3.4 2.4 1A7.7 7.7 0 0 1 9.9 6.4L10.3 3.8h4l.4 2.6c.9.3 1.7.8 2.4 1.4l2.4-1 2 3.4-2 1.6c.1.4.1.9.1 1.4z"/>',
  plus: '<path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/>',
  search: '<path d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12z"/>',
  close: '<path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 5.7 18.3 4.3 16.9 10.6 12 4.3 5.7 5.7 4.3 12 10.6l4.9-4.9z"/>',
  chevron: '<path d="M9 6l6 6-6 6z"/>',
  whatsapp:
    '<path d="M12 2a10 10 0 0 0-8.5 15.2L2 22l4.9-1.4A10 10 0 1 0 12 2zm5.8 14.2c-.2.7-1.4 1.3-2 1.4-.5.1-1.2.1-1.9-.1a17 17 0 0 1-1.7-.7c-3-1.3-5-4.3-5.1-4.4-.2-.2-1.2-1.6-1.2-3s.7-2.1 1-2.4c.2-.3.5-.4.7-.4h.5c.2 0 .4 0 .6.4l.8 2c.1.2.1.4 0 .6l-.4.6-.3.3c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2.1 1.3 2.4 1.4.3.1.5.1.7-.1l.9-1.1c.2-.2.4-.2.6-.1l2 1c.2.1.4.2.4.3z"/>',
  alert:
    '<path d="M12 2 1 21h22zm0 5 7.5 13h-15zM11 11h2v5h-2zm0 6h2v2h-2z"/>',
  menu: '<path d="M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z"/>',
  check: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
  trash:
    '<path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/>',
  undo: '<path d="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A7.9 7.9 0 0 1 12.5 10c3.5 0 6.6 2.2 7.7 5.3l2.3-.8A10 10 0 0 0 12.5 8z"/>',
  download: '<path d="M11 3h2v9.2l3.1-3.1 1.4 1.4-5.5 5.5L6.5 10.5l1.4-1.4L11 12.2zm-6 14h14v3H5z"/>',
  upload: '<path d="M11 21h-2v-9.2L5.9 15l-1.4-1.4L10 8.1l5.5 5.5L14.1 15 11 11.8zM5 3h14v3H5z"/>',
  sun: '<path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0-5h-1v3h2V2zm0 18h-2v3h2zm9-9h3V9h-3zM2 12h3v2H2zM4.9 4.9 6.3 6.3 8 4.6 6.6 3.2zM16 19.4l1.7 1.7 1.4-1.7-1.7-1.7zM19.4 4.9l-1.7 1.7 1.4 1.4 1.7-1.7zM16 6.3l1.7-1.7-1.4-1.4-1.7 1.7z"/>',
  moon: '<path d="M12.3 2a9 9 0 1 0 9.7 12.1A7.5 7.5 0 0 1 12.3 2z"/>',
  money:
    '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-1.2c-1.5-.3-2.6-1.4-2.8-3h2c.2.8.7 1.3 1.8 1.3 1.1 0 1.6-.5 1.6-1.3 0-.7-.4-1-1.8-1.4-2-.5-3.4-1.1-3.4-3 0-1.5 1.2-2.6 2.6-2.9V4h2v1.5c1.4.3 2.3 1.4 2.5 2.8h-2c-.1-.7-.6-1.2-1.5-1.2s-1.5.4-1.5 1.1c0 .6.4.9 1.8 1.3 2 .6 3.4 1.2 3.4 3.1 0 1.6-1.2 2.7-2.7 3z"/>',
  box: '<path d="M12 2 3 6.5v11L12 22l9-4.5v-11zm0 2.3L18 7.4v9.2l-6 3-6-3V7.4z"/>',
  arrowLeft: '<path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  calendar:
    '<path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zM5 9h14v11H5z"/>',
};

export function icon(name: keyof typeof ICONS | string, size = 20): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] ?? ICONS.alert;
  return svg;
}

/** Normaliza texto para búsqueda: minúsculas y sin acentos. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Coincidencia por tokens: todos los términos deben aparecer. */
export function matches(haystack: string, query: string): boolean {
  const h = normalize(haystack);
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  return terms.every((t) => h.includes(t));
}
