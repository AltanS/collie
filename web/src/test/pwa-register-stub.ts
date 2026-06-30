// Vitest runs without the VitePWA plugin, so the `virtual:pwa-register` module doesn't exist. This
// stub stands in for it (aliased in vitest.config.ts) so any module that imports it — lib/pwa.ts,
// pulled in transitively by BuildStamp — resolves cleanly. It registers nothing.
export function registerSW(_options?: unknown): (reloadPage?: boolean) => Promise<void> {
  return () => Promise.resolve();
}
