import { asJsonString } from "./json";

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

// SemVer, loosely: a three-number core, an optional `-prerelease`, an optional `+build` metadata.
// Anything that doesn't match this shape is not a version we're willing to reason about.
const SEMVER = /^v?\d+\.\d+\.\d+(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * The prerelease marker to shout, or `undefined` when this is a stable build (⇒ show nothing).
 *
 * `1.0.0-alpha.3` → `"ALPHA"`, `2.0.0-rc.1` → `"RC"`, `0.25.0` → `undefined`. The label is the
 * prerelease tag's FIRST dot-separated identifier, uppercased, so a beta never gets announced as an
 * alpha; a purely numeric tag (`1.0.0-1`) falls back to `"PRERELEASE"`. Garbage, empty and absent
 * versions return `undefined` — this drives an unmissable banner, so every failure mode must fail
 * toward hidden rather than toward crying wolf on a stable install.
 *
 * The one subtlety: vite.config.ts stamps `-dev` onto BUILD.version whenever HEAD isn't the release
 * tag, so a stable checkout mid-development reports `0.25.0-dev`. That suffix is a build-time
 * "not a tagged release" marker, NOT a SemVer prerelease from the version files, so it's stripped
 * before the test — otherwise every dev build of stable Collie would wear an alpha banner.
 */
export function prereleaseLabel(version: string | undefined | null): string | undefined {
  // Narrowed rather than trusted: this reads a version off `/api/config` and off the update check,
  // both parsed JSON, so a number can arrive here despite the annotation — and `.trim()` would
  // throw on one. `asJsonString` is the single place that question is asked.
  const raw = asJsonString(version);
  if (raw === undefined) return undefined;
  const tag = SEMVER.exec(raw.trim().replace(/-dev$/, ""))?.[1];
  if (!tag) return undefined;
  const first = tag.split(".")[0] ?? "";
  return /[A-Za-z]/.test(first) ? first.toUpperCase() : "PRERELEASE";
}

/**
 * True when the bridge is serving a different build than the one this bundle came from — i.e. the
 * browser is running a stale, service-worker-cached bundle. `unknown`/missing server build (the
 * bridge couldn't read build-info.json) is treated as "not stale" so we never nag spuriously.
 */
export function isStaleBuild(bundleId: string, serverBuild: string | undefined): boolean {
  return Boolean(serverBuild) && serverBuild !== "unknown" && serverBuild !== bundleId;
}
