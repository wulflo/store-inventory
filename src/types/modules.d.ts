/* eslint-disable */
/* Declaración genérica para módulos .mjs (scripts de versión) para evitar TS7016. */
declare module '*.mjs' {
  const mod: Record<string, any>;
  export default mod;
  export = mod;
}
