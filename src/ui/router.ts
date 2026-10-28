/**
 * Router por hash. Simple, sin dependencias, funciona igual en escritorio
 * y móvil, y no rompe el scroll ni el foco al navegar.
 */

export type RouteHandler = (params: Record<string, string>) => void | Promise<void>;

interface Route {
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];
  private current: Route | null = null;
  private currentParams: Record<string, string> = {};
  private notFoundHandler: RouteHandler = () => {};

  constructor(private outlet: HTMLElement) {
    window.addEventListener('hashchange', () => void this.resolve());
  }

  add(pattern: string, handler: RouteHandler): this {
    this.routes.push({ pattern, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  notFound(handler: RouteHandler): this {
    this.notFoundHandler = handler;
    return this;
  }

  navigate(path: string): void {
    const target = path.startsWith('#') ? path : `#${path}`;
    if (window.location.hash === target) {
      void this.resolve();
    } else {
      window.location.hash = target;
    }
  }

  back(): void {
    window.history.back();
  }

  currentPath(): string {
    return window.location.hash.replace(/^#/, '') || '/';
  }

  async resolve(): Promise<void> {
    const path = this.currentPath();
    const parts = path.split('/').filter(Boolean);

    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
        } else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      this.current = route;
      this.currentParams = params;
      await route.handler(params);
      this.outlet.scrollTo?.({ top: 0 });
      window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      return;
    }

    this.current = null;
    await this.notFoundHandler({});
  }

  /**
   * Vuelve a pintar la ruta actual sin navegar ni cambiar el scroll.
   * Se usa cuando llegan datos de otro dispositivo y la vista debe reflejar
   * el estado nuevo sin obligar al usuario a salir y volver a entrar.
   */
  async reload(): Promise<void> {
    if (!this.current) {
      await this.resolve();
      return;
    }
    await this.current.handler(this.currentParams);
  }

  start(): void {
    void this.resolve();
  }
}
