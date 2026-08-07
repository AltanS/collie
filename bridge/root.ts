import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// Where the Collie checkout lives — the one path every other path is derived from (web/dist,
// herdr-plugin.toml, bridge/*.ts for the source stamp).
//
// This exists because `import.meta.dir` CANNOT be used for it. Under `bun build --compile` the
// module's own directory resolves into the embedded `/$bunfs` root, not the checkout on disk, so
// `join(import.meta.dir, "..", "web", "dist")` would point into the bundle and the served PWA would
// vanish. web/dist is read from disk at request time (a frontend rebuild is live with no restart —
// CLAUDE.md), so it must never be resolved relative to the bundle.
//
// Order:
//   1. COLLIE_PLUGIN_ROOT — an explicit injection, and the answer for a binary deliberately kept
//      outside its checkout.
//   2. This module's own directory's parent — the checkout, in source mode.
//   3. dirname(dirname(process.execPath)) — the compiled binary at <root>/bin/collie.
//
// Two things keep (2) from resolving into the bundle. A candidate is accepted only if it CONTAINS
// the manifest — a file the bundle does not carry — and a source path inside the embedded root is
// discarded outright. Both are needed: `/$bunfs` is a REAL virtual filesystem inside the binary, so
// an existence check there answers true, and a compiled-ness sniff alone would be one Bun rename
// away from silently pointing the served directory at the bundle.

const MARKER = "herdr-plugin.toml";

/** Bun's embedded filesystem root: `/$bunfs/…` on POSIX, `B:\~BUN\…` on Windows. */
function isEmbedded(p: string): boolean {
  return p.startsWith("/$bunfs/") || /^[A-Za-z]:[\\/]~BUN[\\/]/i.test(p);
}

function sourcePath(): string | null {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return null;
  }
}

export interface RootDeps {
  env: Record<string, string | undefined>;
  execPath: string;
  /** This module's own source file, or null when it has no resolvable path. */
  source: string | null;
  exists: (p: string) => boolean;
}

/** Pure core of {@link pluginRoot} — see the comment above for the precedence it implements. */
export function resolvePluginRoot(deps: RootDeps): string {
  const injected = deps.env.COLLIE_PLUGIN_ROOT?.trim();
  if (injected && isAbsolute(injected)) return injected;

  const candidates: string[] = [];
  if (deps.source !== null && !isEmbedded(deps.source)) {
    candidates.push(dirname(dirname(deps.source)));
  }
  candidates.push(dirname(dirname(deps.execPath)));

  for (const c of candidates) {
    if (deps.exists(join(c, MARKER))) return c;
  }
  // Nothing looks like a checkout. Return the compiled-binary guess rather than throwing: `version`
  // must still answer ("unknown"), and every verb that truly needs the checkout reports its own
  // missing file with a path the operator can act on.
  return candidates[candidates.length - 1]!;
}

let cached: string | null = null;

/** The Collie checkout root, resolved once per process. */
export function pluginRoot(): string {
  if (cached === null) {
    cached = resolvePluginRoot({
      env: process.env,
      execPath: process.execPath,
      source: sourcePath(),
      exists: existsSync,
    });
  }
  return cached;
}
