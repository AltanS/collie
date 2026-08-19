import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Files } from "./sys.ts";
import { collieBinary } from "./unit.ts";

// `collie link` / `collie unlink` — publish the checkout's compiled binary under a name on the
// operator's PATH, and take it back.
//
// ── A POINTER, NEVER A COPY ──────────────────────────────────────────────────
// What lands in `~/.local/bin` is a SYMLINK to `<checkout>/bin/collie`, and the reasoning for that —
// rather than a copied binary or a wrapper script — is
// [ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md). The one fact this module
// depends on: `build` compiles to `bin/collie.new` and RENAMES it into place (cli/build.ts), so the
// path a symlink resolves is replaced atomically underneath it. The link never needs refreshing, and
// there is no second artifact to keep in step.
//
// ── ONLY EVER TEAR DOWN WHAT MATCHES YOUR OWN RECORD ─────────────────────────
// ADR 0001's rule, applied to a name instead of a front door. Here the "record" is the destination's
// SHAPE: a symlink whose target is some checkout's `bin/collie` is a name Collie published, so `link`
// may replace it (loudly, naming what it pointed at). Anything else — a regular file, a directory, a
// symlink into someone else's tool — is refused untouched. `unlink` is stricter still: it removes the
// name only when it points at THIS checkout's binary, because a link to another checkout belongs to
// that instance.
//
// Nothing here edits a shell profile. Publishing a name is one act; changing how the operator's shell
// is configured is another, and a verb that quietly rewrote `.bashrc` would be the second.

/** The directory `link` publishes into — the XDG-conventional per-user bin, created if missing. */
export const linkDir = (home: string): string => join(home, ".local", "bin");

/** The published name itself. */
export const linkPath = (home: string): string => join(linkDir(home), "collie");

/**
 * What sits at the destination, read WITHOUT following the final symlink — the only three answers
 * that change the decision. `target` is the link's target made absolute against the link's own
 * directory; it is deliberately not `realpath`d, so a link to a checkout that is currently absent is
 * still classified by what it names.
 */
export type LinkProbe =
  | { readonly kind: "absent" }
  | { readonly kind: "symlink"; readonly target: string }
  /** `what` describes it in the words the refusal prints — "a regular file", "a directory". */
  | { readonly kind: "other"; readonly what: string };

/** A link target as read off disk, made absolute the way the kernel resolves it. */
export function resolveLinkTarget(linkAt: string, rawTarget: string): string {
  return isAbsolute(rawTarget) ? rawTarget : resolve(dirname(linkAt), rawTarget);
}

/**
 * Does this target name SOME collie checkout's compiled binary? That — not equality with our own —
 * is what makes a destination one Collie published and may therefore replace. Both separators are
 * accepted because the CLI runs on Windows too.
 */
export function isCollieBinaryPath(target: string): boolean {
  return /[/\\]bin[/\\]collie$/.test(target);
}

export type LinkVerdict =
  | { readonly action: "create" }
  /** Already this checkout's binary: nothing to do, and saying so is the whole output. */
  | { readonly action: "keep" }
  | { readonly action: "replace"; readonly previous: string }
  | { readonly action: "refuse"; readonly reason: string };

/** The `link` decision, as a total function of what is at the destination and what we would publish. */
export function classifyLink(probe: LinkProbe, own: string): LinkVerdict {
  switch (probe.kind) {
    case "absent":
      return { action: "create" };
    case "symlink":
      if (probe.target === own) return { action: "keep" };
      if (isCollieBinaryPath(probe.target)) return { action: "replace", previous: probe.target };
      return { action: "refuse", reason: `a symlink to ${probe.target}, which is not a collie binary` };
    case "other":
      return { action: "refuse", reason: probe.what };
  }
}

export type UnlinkVerdict =
  | { readonly action: "remove" }
  | { readonly action: "absent" }
  | { readonly action: "refuse"; readonly reason: string };

/** The `unlink` decision. Only this checkout's own link is ours to remove. */
export function classifyUnlink(probe: LinkProbe, own: string): UnlinkVerdict {
  switch (probe.kind) {
    case "absent":
      return { action: "absent" };
    case "symlink":
      if (probe.target === own) return { action: "remove" };
      return {
        action: "refuse",
        reason: isCollieBinaryPath(probe.target)
          ? `it points at ${probe.target} — that checkout owns the name`
          : `it points at ${probe.target}, which Collie never published`,
      };
    case "other":
      return { action: "refuse", reason: probe.what };
  }
}

/** One PATH entry, comparable: no trailing separator, so `~/.local/bin/` matches `~/.local/bin`. */
function normalizeEntry(entry: string): string {
  return entry.replace(/[/\\]+$/, "");
}

/**
 * Is `dir` on this PATH? Split only — never resolved, never globbed: what matters is whether the
 * operator's shell would find the name, and the shell does exactly this comparison.
 */
export function onPath(dir: string, pathVar: string | undefined): boolean {
  if (pathVar === undefined || pathVar === "") return false;
  const want = normalizeEntry(dir);
  return pathVar.split(delimiter).some((entry) => entry !== "" && normalizeEntry(entry) === want);
}

// ── The verbs ────────────────────────────────────────────────────────────────

/** Reading the destination — all `doctor` is given, so there is nothing there for it to call. */
export interface LinkReader {
  probe(p: string): LinkProbe;
}

/** Reading it, and the three writes `link`/`unlink` need. */
export interface LinkWriter extends LinkReader {
  mkdirp(p: string): void;
  symlink(target: string, at: string): void;
  remove(at: string): void;
}

export interface LinkDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  /** Only to answer "has this checkout been built yet?". */
  readonly files: Files;
  readonly fs: LinkWriter;
}

/** The PATH warning, printed after a successful link. A fact and a hint — never a profile edit. */
function pathNote(deps: LinkDeps, dir: string): void {
  if (onPath(dir, deps.ctx.env.PATH)) return;
  deps.io.out(`  note: ${dir} is not on your PATH — add it to your shell profile to use \`collie\` bare.`);
}

/** `collie link` — publish `~/.local/bin/collie` → this checkout's `bin/collie`. */
export function cmdLink(deps: LinkDeps): number {
  const own = collieBinary(deps.ctx.root);
  if (!deps.files.exists(own)) {
    deps.io.err(`error: no binary at ${own} — run the build first (\`bin/collie build\`).`);
    return EXIT.FAIL;
  }
  const dir = linkDir(deps.ctx.home);
  const at = linkPath(deps.ctx.home);
  const verdict = classifyLink(deps.fs.probe(at), own);

  if (verdict.action === "refuse") {
    deps.io.err(`error: ${at} is ${verdict.reason} — leaving it alone.`);
    deps.io.err("  Move it out of the way yourself, then re-run `collie link`.");
    return EXIT.FAIL;
  }
  if (verdict.action === "keep") {
    deps.io.out(`${at} already links to ${own}.`);
    pathNote(deps, dir);
    return EXIT.OK;
  }

  try {
    deps.fs.mkdirp(dir);
    // A symlink cannot be created over an existing name, so a replacement is remove-then-create.
    if (verdict.action === "replace") deps.fs.remove(at);
    deps.fs.symlink(own, at);
  } catch (err) {
    deps.io.err(`error: could not link ${at} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  deps.io.out(`✓ ${at} → ${own}`);
  if (verdict.action === "replace") {
    deps.io.out(`  It pointed at ${verdict.previous} before; that checkout no longer owns the name.`);
  }
  deps.io.out("  A pointer, not a copy: every `collie build` here is live through it immediately.");
  pathNote(deps, dir);
  return EXIT.OK;
}

/** `collie unlink` — remove the published name, but only when it is this checkout's. */
export function cmdUnlink(deps: LinkDeps): number {
  const own = collieBinary(deps.ctx.root);
  const at = linkPath(deps.ctx.home);
  const verdict = classifyUnlink(deps.fs.probe(at), own);

  if (verdict.action === "absent") {
    deps.io.out(`not linked — there is nothing at ${at}.`);
    return EXIT.OK;
  }
  if (verdict.action === "refuse") {
    deps.io.err(`error: ${at} is not this checkout's link — ${verdict.reason}.`);
    deps.io.err(`  Run \`collie unlink\` from there, or remove ${at} by hand.`);
    return EXIT.FAIL;
  }

  try {
    deps.fs.remove(at);
  } catch (err) {
    deps.io.err(`error: could not remove ${at} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ removed ${at} — the checkout at ${deps.ctx.root} is untouched.`);
  return EXIT.OK;
}

// ── Production wiring ────────────────────────────────────────────────────────

/**
 * The real destination, read with `lstat` — following the link would report the checkout's binary
 * where the whole question is what the NAME is, and a dangling link would read as absent.
 */
export const realLinkFs: LinkWriter = {
  probe(p) {
    let stat;
    try {
      stat = lstatSync(p);
    } catch {
      return { kind: "absent" };
    }
    if (stat.isSymbolicLink()) {
      try {
        return { kind: "symlink", target: resolveLinkTarget(p, readlinkSync(p)) };
      } catch {
        // It was a symlink a moment ago and now cannot be read: report it as occupied rather than
        // absent, so nothing is replaced on the strength of a race.
        return { kind: "other", what: "an unreadable symlink" };
      }
    }
    return { kind: "other", what: stat.isDirectory() ? "a directory" : "a regular file" };
  },
  mkdirp: (p) => void mkdirSync(p, { recursive: true }),
  symlink: (target, at) => symlinkSync(target, at),
  remove: (at) => rmSync(at, { force: true }),
};
