import { readFileSync } from "node:fs";
import { join } from "node:path";

// This collie's own version string, resolved from the same two files for every consumer.
//
// It lives in `bridge/` rather than in `cli/` because the dependency direction is one-way — `cli/`
// imports from `bridge/` (context.ts already does, for `config.ts` and `root.ts`) and nothing in
// `bridge/` may import from `cli/`. `hello` has to answer with a version (PACK_PROTOCOL.md §7.1,
// "Where the responder gets the string"), and the spec's requirement is that the bridge and the CLI
// "never print different strings for one machine" — which is only guaranteed by one implementation,
// not by two that agree today. `cli/context.ts` re-exports {@link collieVersion} from here.
//
// TWO SPELLINGS, deliberately:
//   • {@link collieVersion} — what `collie version` PRINTS. May carry a parenthetical
//     ("0.24.2 (manifest; web not built)"): it is a sentence for an operator.
//   • {@link collieVersionBare} — what goes ON THE WIRE. A version and nothing else, because the
//     other side compares it against its own and renders the difference (§7.1); a parenthetical
//     would make one machine skewed against itself the moment its web bundle was missing.
// Both read the same files through the same judgement, so they can differ in decoration and never
// in the version they name.

/** Which file answered, and with what. `version === null` ⇒ neither file named one. */
interface ResolvedVersion {
  readonly version: string | null;
  /** True when the manifest answered because no built bundle stamp existed. */
  readonly manifestOnly: boolean;
}

function resolve(buildInfo: string | null, manifest: string | null): ResolvedVersion {
  if (buildInfo !== null) {
    const stamp = readBuildInfo(buildInfo);
    if (stamp !== null) return { version: stamp, manifestOnly: false };
  }
  const v = manifest === null ? null : /^version[ \t]*=[ \t]*"([^"]*)"/m.exec(manifest)?.[1];
  return { version: v === undefined || v === "" ? null : v, manifestOnly: true };
}

/**
 * What Collie is actually serving: the built bundle's stamp (`web/dist/build-info.json`, the same id
 * the PWA footer and `/api/config` report), else the manifest version tagged as unbuilt, else
 * `unknown`. Ported from `collie_version()` (the pre-shim `collie-ctl.sh`) output for output —
 * this is authoritative in a way Herdr's link-time registry value is not.
 */
export function collieVersionFrom(buildInfo: string | null, manifest: string | null): string {
  const { version, manifestOnly } = resolve(buildInfo, manifest);
  if (version === null) return "unknown";
  return manifestOnly ? `${version} (manifest; web not built)` : version;
}

/**
 * The same judgement with no sentence around it — `1.0.0-alpha.12`, or `1.0.0-alpha.12+ab12cd3` when
 * a build stamp is present (§5's wire example). Never a parenthetical, never a note.
 */
export function bareVersionFrom(buildInfo: string | null, manifest: string | null): string {
  return resolve(buildInfo, manifest).version ?? "unknown";
}

function readBuildInfo(text: string): string | null {
  let version: string | undefined;
  let sha: string | undefined;
  try {
    const data = JSON.parse(text) as { version?: unknown; sha?: unknown };
    if (typeof data.version === "string") version = data.version;
    if (typeof data.sha === "string") sha = data.sha;
  } catch {
    // The shell read this file with `sed`, so a truncated write still yielded a version. Keep that
    // tolerance rather than falling all the way back to the manifest on a half-written stamp.
    version = /"version"[ \t]*:[ \t]*"([^"]*)"/.exec(text)?.[1];
    sha = /"sha"[ \t]*:[ \t]*"([^"]*)"/.exec(text)?.[1];
  }
  if (!version) return null;
  return sha ? `${version}+${sha}` : version;
}

/** Read the two files {@link collieVersionFrom} judges. Missing/unreadable reads as absent. */
export function collieVersion(root: string, read: (p: string) => string | null = readIfPresent): string {
  return collieVersionFrom(...versionFiles(root, read));
}

/** {@link bareVersionFrom} over the same two files — the spelling the pack wire takes. */
export function collieVersionBare(root: string, read: (p: string) => string | null = readIfPresent): string {
  return bareVersionFrom(...versionFiles(root, read));
}

function versionFiles(root: string, read: (p: string) => string | null): [string | null, string | null] {
  return [read(join(root, "web", "dist", "build-info.json")), read(join(root, "herdr-plugin.toml"))];
}

function readIfPresent(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
