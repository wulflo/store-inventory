import { el, matches } from '../dom';

export interface AutocompleteItem {
  key: string;
  title: string;
  subtitle?: string;
  avatar?: string;
  /** Texto adicional para el fuzzy match. */
  keywords?: string;
}

export interface AutocompleteOptions<T> {
  placeholder?: string;
  /** Devuelve los candidatos para una consulta. */
  getItems: (query: string) => T[];
  /** Convierte un candidato en la vista de lista. */
  toItem: (value: T) => AutocompleteItem;
  /** Valor seleccionado. */
  onSelect: (value: T) => void;
  /** Permite crear un valor nuevo con el texto escrito. */
  allowCustom?: (query: string) => boolean;
  /** Texto de la opción "crear nuevo". */
  customLabel?: (query: string) => string;
  onCustom?: (query: string) => void;
  /** Valor inicial. */
  initial?: string;
  inputClass?: string;
  autofocus?: boolean;
}

export interface AutocompleteHandle<T> {
  element: HTMLElement;
  input: HTMLInputElement;
  setValue: (text: string) => void;
  clear: () => void;
  focus: () => void;
  getValue: () => string;
  on: (event: 'submit', handler: (value: string) => void) => void;
}

/**
 * Autocompletado con navegación por teclado.
 * - ↑ ↓ para moverse
 * - Enter para elegir
 * - Esc para cerrar
 */
export function autocomplete<T>(options: AutocompleteOptions<T>): AutocompleteHandle<T> {
  let items: T[] = [];
  let highlighted = -1;
  const customHandlers: ((value: string) => void)[] = [];

  const list = el('div', { class: 'autocomplete-list hidden', role: 'listbox' });
  const input = el('input', {
    type: 'text',
    class: options.inputClass ?? '',
    placeholder: options.placeholder ?? 'Buscar…',
    autocomplete: 'off',
    role: 'combobox',
    'aria-expanded': 'false',
    'aria-autocomplete': 'list',
    value: options.initial ?? '',
    on: {
      input: () => refresh(),
      focus: () => refresh(),
      keydown: (e: Event) => onKeyDown(e as KeyboardEvent),
      blur: () => setTimeout(() => hide(), 160),
    },
  });

  const element = el('div', { class: 'autocomplete' }, input, list);

  function hide(): void {
    list.classList.add('hidden');
    input.setAttribute('aria-expanded', 'false');
    highlighted = -1;
  }

  function show(): void {
    list.classList.remove('hidden');
    input.setAttribute('aria-expanded', 'true');
  }

  function renderList(): void {
    list.replaceChildren();

    if (items.length === 0) {
      if (options.allowCustom?.(input.value)) {
        list.appendChild(
          el(
            'div',
            {
              class: 'autocomplete-item',
              on: {
                mousedown: (e: Event) => {
                  e.preventDefault();
                  pickCustom();
                },
              },
            },
            el('span', { class: 'badge badge-primary', text: '+' }),
            el('span', { text: options.customLabel?.(input.value) ?? `Crear "${input.value}"` }),
          ),
        );
      } else {
        list.appendChild(el('div', { class: 'autocomplete-empty', text: 'Sin resultados' }));
      }
      show();
      return;
    }

    items.forEach((value, i) => {
      const item = options.toItem(value);
      const node = el(
        'div',
        {
          class: `autocomplete-item${i === highlighted ? ' selected' : ''}`,
          role: 'option',
          on: {
            mousedown: (e: Event) => {
              e.preventDefault();
              selectIndex(i);
            },
          },
        },
        item.avatar ? el('span', { class: 'color-dot', style: { background: item.avatar } }) : null,
        el(
          'div',
          { class: 'grow' },
          el('div', { class: 'strong', text: item.title }),
          item.subtitle ? el('div', { class: 'xsmall dim', text: item.subtitle }) : null,
        ),
      );
      list.appendChild(node);
    });

    if (options.allowCustom?.(input.value)) {
      list.appendChild(
        el(
          'div',
          {
            class: 'autocomplete-item',
            on: {
              mousedown: (e: Event) => {
                e.preventDefault();
                pickCustom();
              },
            },
          },
          el('span', { class: 'badge badge-primary', text: '+' }),
          el('span', { text: options.customLabel?.(input.value) ?? `Crear "${input.value}"` }),
        ),
      );
    }

    show();
  }

  function refresh(): void {
    const q = input.value.trim();
    items = q ? options.getItems(q) : [];
    highlighted = -1;
    renderList();
  }

  function selectIndex(index: number): void {
    const value = items[index];
    if (value === undefined) return;
    hide();
    input.value = options.toItem(value).title;
    options.onSelect(value);
  }

  function pickCustom(): void {
    const q = input.value.trim();
    if (!q || !options.allowCustom?.(q) || !options.onCustom) return;
    hide();
    options.onCustom(q);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (items.length === 0) return;
      highlighted = (highlighted + 1) % items.length;
      renderList();
      list.querySelectorAll('.autocomplete-item')[highlighted]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length === 0) return;
      highlighted = highlighted <= 0 ? items.length - 1 : highlighted - 1;
      renderList();
      list.querySelectorAll('.autocomplete-item')[highlighted]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (!list.classList.contains('hidden')) {
        e.preventDefault();
        if (highlighted >= 0 && highlighted < items.length) {
          selectIndex(highlighted);
        } else if (items.length > 0) {
          selectIndex(0);
        } else {
          pickCustom();
        }
      } else {
        customHandlers.forEach((h) => h(input.value));
      }
    } else if (e.key === 'Escape') {
      hide();
    }
  }

  if (options.autofocus) {
    setTimeout(() => input.focus(), 50);
  }

  return {
    element,
    input,
    setValue(text: string) {
      input.value = text;
    },
    clear() {
      input.value = '';
      hide();
    },
    focus() {
      input.focus();
    },
    getValue() {
      return input.value;
    },
    on(event: 'submit', handler: (value: string) => void) {
      if (event === 'submit') customHandlers.push(handler);
    },
  };
}

/** Filtro de búsqueda por texto libre. */
export function searchFilter<T>(
  items: T[],
  query: string,
  toText: (item: T) => string,
): T[] {
  if (!query.trim()) return items;
  return items.filter((item) => matches(toText(item), query));
}
