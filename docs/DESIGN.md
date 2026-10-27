# DESIGN.md — Rediseño Material Design 3 (Fase 1)

## Objetivo
Rediseño completo de la UI con **Material Design 3 (Material You)**, adaptado a pantalla vertical de Android, mismo código para desktop y móvil. Sin framework de componentes: API propia `el()` sobre tokens M3.

## Decisión de componentes
- **Componentes propios sobre tokens M3** (no `@material/web`).
- Justificación: el proyecto exige "sin dependencias pesadas"; `@material/web` tiene mantenimiento mixto y su WebView en Android puede traer problemas de versionado; componentes propios dan el mismo resultado visual con cero dependencias nuevas.
- `@material/material-color-utilities` no se instala: los roles M3 se definen desde un color semilla con valores fijos en CSS.

## Color semilla y roles M3
Color semilla primario: `#2f6df6` (índigo, armoniza con el logo del carrito con flor). A partir de él se definen los roles M3 en `src/ui/styles.css` (sección Tokens):

| Rol | Claro | Oscuro |
|-----|-------|--------|
| primary | `#2f6df6` | `#8c9dff` |
| on-primary | `#ffffff` | `#303f67` |
| primary-container | `#e7efff` | `#303f67` |
| on-primary-container | `#1a4aa3` | `#e7efff` |
| secondary | `#6e6e80` | `#8c8da1` |
| surface | `#ffffff` | `#121217` |
| on-surface | `#1a1b1e` | `#e6e1e5` |
| surface-variant | `#e7e9ec` | `#333239` |
| background | `#fbfbff` | `#121217` |
| outline | `#79747e` | `#8c8c94` |
| error | `#ba1a1a` | `#ffb4ab` |

Los colores semánticos de estado de pedido se conservan y armonizan con la paleta:
- pendiente / producción / listo / entregado / cancelado (y sus variantes `-soft`).

## Tipografía M3
Tipografía grande (requisito original), escala M3 en rem:

| Token | Valor | Uso |
|-------|-------|-----|
| `--fs-display` | 2.5rem | Títulos grandes (h1) |
| `--fs-headline` | 1.75rem | Títulos de sección (h2) |
| `--fs-title` | 1.375rem | Tarjetas, subtítulos (h3) |
| `--fs-base` | 1rem | Cuerpo (body-large) |
| `--fs-md` | 0.9375rem | Cuerpo medio |
| `--fs-lg` | 1.125rem | Títulos medios |
| `--fs-sm` | 0.875rem | Etiquetas (label-large) |
| `--fs-xs` | 0.75rem | Auxiliar (label-medium) |

## Formas (shapes) M3
| Token | Valor |
|-------|-------|
| `--radius-sm` | 12px (small) |
| `--radius` | 16px (medium) |
| `--radius-lg` | 24px (large) |
| `--radius-pill` | 28px (full) |

## Elevación tonal M3
Sombras por nivel (level1–level4) mapeadas a `--shadow-sm`, `--shadow`, `--shadow-lg`. Usadas en cards, KPIs, modales, bottom sheets.

## State layers (ripple)
Botones, nav-link, chip, FAB, card-action, icon-btn tienen capa de estado: hover (8% opacidad), pressed (escala 0.96, opacidad 1). En dispositivos táctil (`pointer: coarse`) el hover se desactiva.

## Breakpoints / Window size classes
| Clase | Rango | Layout |
|-------|-------|--------|
| compact | < 600px | Sidebar oculto; bottom-nav inferior visible; FAB fijo; modal ancho completo; bottom-sheet a ancho completo |
| medium | 600–839px | Rail estrecho (72px) sin etiquetas; bottom-nav oculto; FAB fijo |
| expanded | ≥ 840px | Sidebar fijo (248px) con etiquetas; bottom-nav oculto; FAB fijo |

Las rutas y funciones son idénticas en todos los tamaños; solo cambia el layout.

## Componentes M3 implementados
- Top app bar (topbar con título, acciones, tema)
- Navigation bar (compacto, inferior) + Navigation rail (medio/expandido, lateral)
- FAB / extended FAB (botón "Pedido", fijo)
- Botones: filled (primary), tonal (ghost), outlined, text (card-link)
- Campos de texto: filled (text-field), outlined (outlined-field), select con label flotante
- Chips (activos/inactivos)
- Diálogos (modal) y bottom sheets (reemplazan modales en compacto)
- Snackbar (toast, con variantes éxito/advertencia/error)
- Segmented buttons, switch, checkbox, tabs
- Listas, badges (estado de pedido), progreso lineal
- Tarjetas (card), KPIs, meter rows

## Específico Android
- `viewport-fit=cover` y `env(safe-area-inset-*)` en html/body
- Objetivos táctiles ≥ 48dp (campos, botones, FAB)
- Teclado virtual: no tapa inputs (usa visualViewport; inputs dentro de cards con scroll)
- Botón y gesto Atrás integrados al router (cerrar sheet/modal → volver → salir)
- Sin interacciones solo-hover
- `overscroll-behavior-y: none`

## Accesibilidad
- Contraste WCAG AA (roles M3 diseñados para ello)
- Foco visible (`:focus-visible` con anillo primario)
- Roles ARIA en modales (`role="dialog"`, `aria-modal="true"`)
- Tipografía escalable (rem, respeta ajuste de tamaño de sistema)

## Pantalla de arranque (boot)
Overlay fijo con marca "IT" y texto "Cargando…" mientras se inicializa la app; se retira al montar el shell.

## Pendiente (bloqueante no crítico)
- **Archivo de logo del usuario**: se mencionó un logo adjuntado para compilaciones Android/Desktop, pero no está presente en el repositorio. No hay ningún archivo PNG/SVG de icono de app. Cuando se proporcione, se integra como icono de la app (Android adaptive icon + desktop) y como marca en la pantalla de arranque.
