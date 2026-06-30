export interface BuildInfo {
  version: string;
  sha: string;
  time: string;
  id: string;
}

// The build stamp baked into this bundle at build time (vite `define`, see vite.config.ts).
export const BUILD: BuildInfo = __BUILD_INFO__;

/** Short, human-readable footer label, e.g. "v0.3.0 · c9167c3 · 2026-06-30 00:12 UTC". */
export function buildLabel(info: Pick<BuildInfo, "version" | "sha" | "time"> = BUILD): string {
  const when = info.time.slice(0, 16).replace("T", " "); // YYYY-MM-DDTHH:mm → YYYY-MM-DD HH:mm
  return `v${info.version} · ${info.sha} · ${when} UTC`;
}

/**
 * True when the bridge is serving a different build than the one this bundle came from — i.e. the
 * browser is running a stale, service-worker-cached bundle. `unknown`/missing server build (the
 * bridge couldn't read build-info.json) is treated as "not stale" so we never nag spuriously.
 */
export function isStaleBuild(bundleId: string, serverBuild: string | undefined): boolean {
  return Boolean(serverBuild) && serverBuild !== "unknown" && serverBuild !== bundleId;
}
