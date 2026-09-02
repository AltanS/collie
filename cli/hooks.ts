import { basename, dirname, join } from "node:path";

import { BEACON_HOOKS, type HookRegistration } from "./beacon.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import type { CliContext } from "./context.ts";
import { publishedBinary } from "./install-kind.ts";
import { EXIT, type Io } from "./io.ts";
import { type LinkReader, linkPath, resolveLinkTarget } from "./link.ts";
import {
  OMP_SLASH_CATALOG_MARKER,
  OMP_SLASH_CATALOG_MARKER_PREFIX,
  OMP_SLASH_CATALOG_MARKER_VERSION,
  OMP_SLASH_CATALOG_SOURCE,
} from "./omp-slash-catalog-source.ts";
import type { Files } from "./sys.ts";
import { collieBinary } from "./unit.ts";

// `collie hooks install claude` / `uninstall claude` / `status` — putting the beacon emitter into the
// agent's own settings, and taking it back out. `hooks install omp` writes a marked extension into
// `~/.omp/agent/extensions/` the same way: Collie owns the file, the operator never copies it.
//
// ── THE SCOPE IS GLOBAL, AND THAT IS THE MILESTONE'S PREMISE ──────────────────────────────────────
//
// The targets are `~/.claude/settings.json` and the same file in every `CLAUDE_CONFIG_DIR` profile
// the journal registry already knows about (issue #92). PROJECT SETTINGS ARE NEVER WRITTEN — not
// `.claude/settings.json`, not `.claude/settings.local.json`. The operator adopts panes *anywhere on
// the host*, so a per-project install would make a pane's identity depend on which directory the
// agent happened to be started in, which is precisely the fragility beacons exist to remove. The cost
// of the global scope is one process spawn per hook event outside a multiplexer, and `beacon emit`'s
// environment gate makes that cost nothing.
//
// ── THREE GUARDS, EACH EARNED FROM A REAL FAILURE (Ark0N/Codeman) ─────────────────────────────────
//
//  1. MERGE BY A VERSION-PREFIXED OWNERSHIP MARKER. Claude Code merges hook entries across settings
//     levels rather than replacing them, so an operator's own hooks sit in the same arrays as ours.
//     Every entry we write carries {@link HOOK_MARKER}; an entry without one is never touched, read
//     or reordered, and `uninstall` removes only marked entries. A marker at a DIFFERENT version is
//     replaced in place — that is the self-heal, and it is why the version is in the marker at all.
//  2. REFUSE A SYMLINKED TARGET. Writing through a symlink is how an installer edits a file the
//     operator did not mean.
//  3. WRITE ATOMICALLY, AND BACK UP ONCE. Temp file plus rename, and a `.collie-backup` beside the
//     file before the first modification, so a bad merge is one `mv` from undone.
//
// Installing twice changes no bytes: the second run serialises the same document and writes nothing.
// "Already installed" is decided by COMPARING THE BYTES, never by finding a marker and stopping — so
// when a registration joins {@link BEACON_HOOKS} (as `SessionStart` did), the next `hooks install`
// adds that one event to a file that already carries the others, leaves every entry beside it where
// it was, and is a no-op on the run after. That is why growing the set needs no marker bump: the
// version says what the COMMAND looks like, and the command did not change. The same rule healed an
// entry installed before `timeout: 10` existed: `ourGroup` always rebuilds the whole entry object, so
// an old one missing the field gets it back the next time bytes are compared — no marker bump, because
// the command string is still exactly what it was.

/** The harnesses that have an installer. Claude gets beacon entries; omp gets a slash-catalog extension. */
export const HOOK_HARNESSES = ["claude", "omp"] as const;

/** The `hooks` sub-verbs, in the order the usage block prints them. */
export const HOOKS_SUBCOMMANDS = ["install", "uninstall", "status"] as const;

/**
 * The ownership marker's version. Bump it when the COMMAND we write has to change shape; every
 * installed entry then heals itself on the next `hooks install`.
 */
export const HOOK_MARKER_VERSION = 1;

/** What makes an entry ours — at any version, which is what lets a stale one be recognised. */
export const HOOK_MARKER_PREFIX = "# collie-beacon v";

/**
 * The marker this build writes — `# collie-beacon v1` today.
 *
 * A shell comment, so the command string stays a command string: Claude Code hands it to a shell,
 * and a trailing comment changes nothing about what runs (probed 2026-08-20 — the hook still runs as
 * a direct child of `claude`, which is what `beacon emit`'s pid depends on).
 */
export const HOOK_MARKER = `${HOOK_MARKER_PREFIX}${HOOK_MARKER_VERSION}`;

/** The marker's version in a command string, or null when the command is not ours. */
export function markerVersionOf(command: string): number | null {
  const found = new RegExp(`${HOOK_MARKER_PREFIX}(\\d+)`, "u").exec(command);
  const digits = found?.[1];
  return digits === undefined ? null : Number(digits);
}

// ── The command we write ─────────────────────────────────────────────────────

/**
 * Which absolute name the hook was pinned to. Reported by `status` (and by `doctor`, M11/05).
 *
 * `install-current` exists because a binary install has a THIRD stable name — `<root>/current/bin/collie`,
 * the symlink `update` flips — and calling that "the checkout" would print a remedy (`collie link`
 * here) for a shape that has no checkout.
 */
export type HookCommandSource = "path-link" | "install-current" | "checkout";

export interface HookCommand {
  readonly binary: string;
  readonly source: HookCommandSource;
  /** Exactly what goes into `settings.json`, marker included. */
  readonly command: string;
}

/**
 * What follows the binary in every command we write. One constant, so the writer below and
 * {@link hookBinaryOf} — which reads an INSTALLED command back — cannot drift apart.
 */
const HOOK_VERB = " beacon emit ";

/**
 * The absolute name an installed entry runs, or null when the command is not shaped like ours.
 *
 * `doctor` asks this (M11/05): a hook pinned to a checkout that has since moved still parses, still
 * carries our marker, and simply never runs — the silent failure the verb exists to catch. The
 * answer comes from the string in the settings file, never from what an install would write today.
 */
export function hookBinaryOf(command: string): string | null {
  const at = command.indexOf(HOOK_VERB);
  return at <= 0 ? null : command.slice(0, at);
}

/** How many links a chain may follow before {@link realpathVia} gives up. `ELOOP`, without the errno. */
const SYMLINK_HOPS = 32;

/**
 * `realpath(3)` over the {@link LinkReader} seam — every component resolved, not just the last one.
 *
 * The last component is not where the indirection is. A binary install publishes
 * `~/.local/bin/collie` → `<root>/current/bin/collie`, and `current` is a DIRECTORY symlink: probing
 * the full path finds a regular file and learns nothing. So each ancestor is resolved before the
 * component below it, which is the only way `current` and `versions/X.Y.Z` are ever seen to be the
 * same file. A path nobody can resolve comes back as itself — that is what a dangling link is, and
 * the caller wants to compare it, not to fail on it.
 */
function realpathVia(fs: LinkReader, path: string, hops = { left: SYMLINK_HOPS }): string {
  const parent = dirname(path);
  // The root is its own parent — that is the recursion's floor, and it needs no probe.
  const here = parent === path ? path : join(realpathVia(fs, parent, hops), basename(path));
  const probe = fs.probe(here);
  if (probe.kind !== "symlink" || hops.left <= 0) return here;
  hops.left -= 1;
  return realpathVia(fs, resolveLinkTarget(here, probe.target), hops);
}

/**
 * The command an entry runs — ALWAYS an absolute path, and always one that SURVIVES AN UPDATE.
 *
 * A hook does not run under the operator's login shell (the same trap as a Herdr plugin action), so a
 * bare `collie` can simply not be found. But an absolute path is not enough on its own: a binary
 * install runs from `<root>/versions/X.Y.Z/bin/collie`, and `update` keeps only the previous version
 * — so a hook pinned to the version directory dangles silently after one or two updates, with every
 * pane quietly reading as a shell again. That is the bug this order exists to make impossible, and
 * the version directory is never written here.
 *
 * The preference, in order:
 *
 *  1. `~/.local/bin/collie`, when it RESOLVES to the binary this install publishes. By ADR 0021 that
 *     name is a symlink, never a copy, so it survives a rebuild, a version flip and a checkout that
 *     moves house. Both sides are realpath'd ({@link realpathVia}) before they are compared, because
 *     the link points at `<root>/current/bin/collie` while the running process was launched from
 *     `<root>/versions/X.Y.Z/bin/collie` — the same file under two names, and a string comparison
 *     calls them different (the whole cause of the dangling-hook bug).
 *  2. Whatever {@link publishedBinary} says this install publishes — `<root>/current/bin/collie` on a
 *     binary install (the symlink `update` itself flips, so it is valid at every version), and the
 *     checkout's own `bin/collie` on a git checkout, which is exactly the old behaviour there.
 */
export function resolveHookCommand(ctx: CliContext, fs: LinkReader): HookCommand {
  const own = publishedBinary(ctx.root, fs);
  const published = linkPath(ctx.home);
  const probe = fs.probe(published);
  const linked =
    probe.kind === "symlink" &&
    realpathVia(fs, resolveLinkTarget(published, probe.target)) === realpathVia(fs, own);
  const fallback: HookCommandSource = own === collieBinary(ctx.root) ? "checkout" : "install-current";
  const source: HookCommandSource = linked ? "path-link" : fallback;
  const binary = linked ? published : own;
  return { binary, source, command: `${binary}${HOOK_VERB}${HOOK_MARKER}` };
}

/** What each source is called in one phrase — `hooks status`'s parenthetical. */
const SOURCE_NAME = {
  "path-link": "the published PATH name",
  "install-current": "this install's `current` symlink",
  checkout: "this checkout",
} satisfies Record<HookCommandSource, string>;

/** The line `hooks install` prints under the events — what the pin costs, and how to improve it. */
const PINNED_NOTE = {
  "path-link": "Pinned to the published name (a symlink, never a copy), so a rebuild needs no re-install.",
  // Never the version directory: `update` keeps only the previous version, so a hook pinned there
  // dangles after one or two updates. `current` is the symlink `update` flips, valid at every version.
  "install-current":
    "Pinned to this install's `current` symlink, so it survives every `collie update` — never a version directory.",
  checkout: "Pinned to this checkout — re-run after `collie link` to pin to ~/.local/bin instead.",
} satisfies Record<HookCommandSource, string>;

// ── The targets ──────────────────────────────────────────────────────────────

export interface HookTarget {
  /** The Claude config dir — `~/.claude`, or a `CLAUDE_CONFIG_DIR` profile's own. */
  readonly dir: string;
  /** The settings file inside it. */
  readonly path: string;
}

/** `<path>.collie-backup` — written once, before the first modification. */
export const backupPath = (target: HookTarget): string => `${target.path}.collie-backup`;

/**
 * Every settings file this install writes to.
 *
 * `~/.claude` always, plus the parent of each configured Claude journal root — the bridge resolves
 * those from `COLLIE_TRANSCRIPT_ROOT` (a comma-separated list, because `CLAUDE_CONFIG_DIR` gives each
 * profile its own tree, issue #92), and a profile's `settings.json` sits beside its `projects/`. So
 * the set of homes Collie can already READ a journal from is exactly the set it installs hooks into;
 * a profile Collie cannot read is a profile a beacon would not help.
 *
 * It asks for the two fields it reads rather than the whole {@link CliContext}, because the BRIDGE
 * asks the same question — "are these hooks installed", which decides whether the beacon decorator
 * lifts its capabilities (M11/03, `bridge/beacon-io.ts`) — and the answer must be computed from one
 * rule. A second implementation over there would drift silently, and a drifted answer is a
 * capability declared over beacons that will never be written.
 */
export function claudeSettingsTargets(ctx: Pick<CliContext, "home" | "env">): HookTarget[] {
  const dirs = [join(ctx.home, ".claude")];
  for (const root of (ctx.env.COLLIE_TRANSCRIPT_ROOT ?? "").split(",")) {
    const trimmed = root.trim();
    if (trimmed !== "") dirs.push(dirname(trimmed));
  }
  return [...new Set(dirs)].map((dir) => ({ dir, path: join(dir, "settings.json") }));
}

// ── The merge ────────────────────────────────────────────────────────────────

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value instanceof Object && !Array.isArray(value) ? value : null;
}

function asArray(value: JsonValue | undefined): JsonValue[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * The command of the marked entry inside one registration group, or null when the group is not ours.
 *
 * `String()` is total over every value `JSON.parse` can produce, and an object stringifies to
 * something that contains no marker — so a group is classified without asserting anything about the
 * shapes inside it.
 */
export function markedCommandIn(group: JsonValue): string | null {
  const row = asObject(group);
  const entries = asArray(row?.hooks) ?? [];
  for (const entry of entries) {
    const command = asObject(entry)?.command;
    if (command === undefined || command === null) continue;
    const text = String(command);
    if (text.includes(HOOK_MARKER_PREFIX)) return text;
  }
  return null;
}

/**
 * One entry per {@link BEACON_HOOKS} registration, in order: the command WE own on that event, or
 * null where the event carries none of ours.
 *
 * The single reading of "what is installed in this file", and both readers use it — `hooks status`
 * below and `collie doctor` (M11/05). A second walk of the same document is a second thing to drift,
 * and a doctor that disagrees with its own verb is worse than no doctor (cli/doctor.ts's rule).
 */
export function markedCommandsByEvent(document: JsonValue | null): (string | null)[] {
  const section = asObject(asObject(document)?.hooks) ?? {};
  return BEACON_HOOKS.map((registration) => {
    const groups = asArray(section[registration.event]) ?? [];
    return groups.map((group) => markedCommandIn(group)).find((found) => found !== null) ?? null;
  });
}

export type HookDocument =
  | { readonly kind: "document"; readonly document: JsonObject }
  /** The file is not one we may edit, and `reason` is the whole sentence the operator reads. */
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * One registration group, as we write it. `matcher` is dropped by `JSON.stringify` when absent.
 *
 * `timeout: 10` (seconds) rides beside `command` on every entry, same as the Herdr row above it.
 * Without it Claude Code's own default — 60 s — applies, and a hung `beacon emit` would stall the
 * agent for a full minute; the emitter is one small file write and must finish in well under 10 s
 * (`cli/beacon.ts`'s own budget note: `SessionEnd` gets 1.5 s from Claude Code itself). This is a
 * sibling field on the same command, not a change to the command string, so it needs no marker bump
 * — `installDocument` rebuilds the group from scratch on every run, so an entry installed before this
 * field existed gains it the next time `hooks install` runs, purely from the byte comparison already
 * in place.
 */
function ourGroup(registration: HookRegistration, command: string): JsonObject {
  return {
    matcher: registration.matcher,
    hooks: [{ type: "command", command, timeout: 10 }],
  };
}

/**
 * The event's array with our entry merged in — replacing OUR previous entry in place, and leaving
 * every unmarked entry exactly where it was.
 *
 * In place, rather than "remove and append", so a self-heal (`v1` → `v2`) does not silently reorder
 * the operator's hooks around it. Ordering matters to them: hooks in one array run in sequence.
 */
function mergeGroups(groups: readonly JsonValue[], ours: JsonObject): JsonValue[] {
  const kept = groups.filter((group) => markedCommandIn(group) === null);
  const at = groups.findIndex((group) => markedCommandIn(group) !== null);
  if (at < 0) return [...kept, ours];
  // `at` counts only unmarked entries before it (it is the FIRST marked one), so it indexes `kept`
  // at the same position. A second marked entry — someone's copy-paste — is dropped by the filter.
  return [...kept.slice(0, at), ours, ...kept.slice(at)];
}

/** The settings document with every {@link BEACON_HOOKS} registration present, or a refusal. */
export function installDocument(current: JsonValue | null, command: string): HookDocument {
  const root = current === null ? {} : asObject(current);
  if (root === null) return { kind: "refuse", reason: "its top level is not a JSON object" };
  const section = root.hooks === undefined ? {} : asObject(root.hooks);
  if (section === null) return { kind: "refuse", reason: "its `hooks` is not a JSON object" };

  const hooks: JsonObject = { ...section };
  for (const registration of BEACON_HOOKS) {
    const existing = section[registration.event];
    const groups = existing === undefined ? [] : asArray(existing);
    if (groups === null) {
      return { kind: "refuse", reason: `its \`hooks.${registration.event}\` is not a JSON array` };
    }
    hooks[registration.event] = mergeGroups(groups, ourGroup(registration, command));
  }
  return { kind: "document", document: { ...root, hooks } };
}

/**
 * The settings document with every marked entry removed, or a refusal.
 *
 * An array we empty is deleted (we are the only reason it existed); an unmarked entry is left alone,
 * so an operator who wrote their own `Stop` hook keeps it.
 */
export function uninstallDocument(current: JsonValue | null): HookDocument {
  const root = current === null ? {} : asObject(current);
  if (root === null) return { kind: "refuse", reason: "its top level is not a JSON object" };
  const section = root.hooks === undefined ? {} : asObject(root.hooks);
  if (section === null) return { kind: "refuse", reason: "its `hooks` is not a JSON object" };

  const hooks: JsonObject = {};
  for (const [event, value] of Object.entries(section)) {
    const groups = asArray(value);
    if (groups === null) {
      hooks[event] = value;
      continue;
    }
    const kept = groups.filter((group) => markedCommandIn(group) === null);
    if (kept.length > 0) hooks[event] = kept;
  }
  const document: JsonObject = { ...root, hooks };
  // A `hooks` we emptied entirely is removed rather than left as `{}` — there is nothing of the
  // operator's in it, and an empty section is a leftover, not a setting.
  if (Object.keys(hooks).length === 0) delete document.hooks;
  return { kind: "document", document };
}

/** How a settings file is serialised. Two-space JSON with a trailing newline, as Claude Code writes it. */
export function serializeSettings(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ── The verbs ────────────────────────────────────────────────────────────────

export interface HooksDeps {
  readonly ctx: CliContext;
  readonly io: Io;
  readonly files: Files;
  /** `lstat` without following — the symlink refusal, and how the published PATH name is recognised. */
  readonly fs: LinkReader;
}

/** The one refusal that is about the PATH rather than the contents: a symlink anywhere on the way in. */
function symlinkOnPath(deps: HooksDeps, target: HookTarget): string | null {
  // The file and its config dir, and no further: everything above them is the operator's own home
  // path, which they gave us. These two are what an attacker — or a dotfile manager — points
  // elsewhere.
  for (const candidate of [target.path, target.dir]) {
    if (deps.fs.probe(candidate).kind === "symlink") return candidate;
  }
  return null;
}

function refuseSymlink(deps: HooksDeps, at: string): void {
  deps.io.err(`error: ${at} is a symlink — refusing to write through it.`);
  deps.io.err("  Replace it with the real file or directory (or point the profile at the real one),");
  deps.io.err("  then re-run `collie hooks install claude`.");
}

/** The file's contents parsed, `null` for an absent file, or a refusal for one we cannot read. */
function readSettings(deps: HooksDeps, target: HookTarget): { text: string | null; value: JsonValue | null } | null {
  const text = deps.files.read(target.path);
  if (text === null) return { text: null, value: null };
  if (text.trim() === "") return { text, value: null };
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return null;
  }
}

/** Temp file, then rename — and the one-time backup, taken before the first modification. */
function writeSettings(deps: HooksDeps, target: HookTarget, previous: string | null, text: string): void {
  if (previous !== null && !deps.files.exists(backupPath(target))) {
    deps.files.write(backupPath(target), previous, 0o600);
  }
  const temp = `${target.path}.collie-tmp`;
  try {
    deps.files.write(temp, text, 0o600);
    deps.files.rename(temp, target.path);
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

/** The harness argument, or null when it was missing or unknown. */
function readHarness(deps: HooksDeps, args: readonly string[], verb: string): string | null {
  const name = args[0];
  if (name !== undefined && HOOK_HARNESSES.some((h) => h === name)) return name;
  deps.io.err(`usage: collie hooks ${verb} {${HOOK_HARNESSES.join("|")}}`);
  if (name !== undefined && name !== "") {
    deps.io.err(`  \`${name}\` has no hook installer — only ${HOOK_HARNESSES.join(", ")} do.`);
  }
  return null;
}

function ompExtensionTarget(ctx: Pick<CliContext, "home">): HookTarget {
  const dir = join(ctx.home, ".omp", "agent", "extensions");
  return { dir, path: join(dir, "collie-slash-catalog.ts") };
}

function ompMarkerVersionOf(text: string): number | null {
  const found = new RegExp(`${OMP_SLASH_CATALOG_MARKER_PREFIX}(\\d+)`, "u").exec(text);
  const digits = found?.[1];
  return digits === undefined ? null : Number(digits);
}

export type OmpCatalogState =
  | { readonly kind: "refused"; readonly symlink: string }
  | { readonly kind: "absent" }
  | { readonly kind: "foreign" }
  | { readonly kind: "stale"; readonly at: string }
  | { readonly kind: "installed"; readonly at: string };

function ompCatalogState(deps: HooksDeps): OmpCatalogState {
  const target = ompExtensionTarget(deps.ctx);
  const symlink = symlinkOnPath(deps, target);
  if (symlink !== null) return { kind: "refused", symlink };
  const text = deps.files.read(target.path);
  if (text === null) return { kind: "absent" };
  const version = ompMarkerVersionOf(text);
  if (version === null) return { kind: "foreign" };
  const at = `v${String(version)}`;
  return version === OMP_SLASH_CATALOG_MARKER_VERSION && text === OMP_SLASH_CATALOG_SOURCE
    ? { kind: "installed", at }
    : { kind: "stale", at };
}

function writeOmpExtension(deps: HooksDeps, target: HookTarget, previous: string | null, text: string): void {
  if (previous !== null && !deps.files.exists(backupPath(target))) {
    deps.files.write(backupPath(target), previous, 0o600);
  }
  const temp = `${target.path}.collie-tmp`;
  try {
    deps.files.write(temp, text, 0o600);
    deps.files.rename(temp, target.path);
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

function cmdOmpHooksInstall(deps: HooksDeps): number {
  const target = ompExtensionTarget(deps.ctx);
  const symlink = symlinkOnPath(deps, target);
  if (symlink !== null) {
    refuseSymlink(deps, symlink);
    return EXIT.FAIL;
  }
  const previous = deps.files.read(target.path);
  if (previous !== null && ompMarkerVersionOf(previous) === null) {
    deps.io.err(`error: ${target.path} is not a collie-owned extension — leaving it alone.`);
    deps.io.err("  Move it aside, then re-run; overwriting an unmarked file would lose it.");
    return EXIT.FAIL;
  }
  if (previous === OMP_SLASH_CATALOG_SOURCE) {
    deps.io.out(`${target.path} already has it — no bytes changed.`);
    deps.io.out("  Restart omp so a running session loads the extension.");
    return EXIT.OK;
  }
  try {
    writeOmpExtension(deps, target, previous, OMP_SLASH_CATALOG_SOURCE);
  } catch (err) {
    deps.io.err(`error: could not write ${target.path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ ${target.path}`);
  deps.io.out(`  ${OMP_SLASH_CATALOG_MARKER} — hint file, never a control channel`);
  deps.io.out("  Restart omp so the session loads the extension.");
  return EXIT.OK;
}

function cmdOmpHooksUninstall(deps: HooksDeps): number {
  const target = ompExtensionTarget(deps.ctx);
  const previous = deps.files.read(target.path);
  if (previous === null) {
    deps.io.out("nothing to remove — no collie-owned omp extension is installed.");
    return EXIT.OK;
  }
  const symlink = symlinkOnPath(deps, target);
  if (symlink !== null) {
    refuseSymlink(deps, symlink);
    return EXIT.FAIL;
  }
  if (ompMarkerVersionOf(previous) === null) {
    deps.io.err(`error: ${target.path} is not a collie-owned extension — leaving it alone.`);
    return EXIT.FAIL;
  }
  try {
    if (!deps.files.exists(backupPath(target))) {
      deps.files.write(backupPath(target), previous, 0o600);
    }
    deps.files.remove(target.path);
  } catch (err) {
    deps.io.err(`error: could not remove ${target.path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ ${target.path} — removed. Restart omp so a running session drops it.`);
  return EXIT.OK;
}

function describeOmpCatalog(deps: HooksDeps): string {
  const state = ompCatalogState(deps);
  switch (state.kind) {
    case "refused":
      return `refused — ${state.symlink} is a symlink`;
    case "absent":
      return "not installed — `collie hooks install omp` writes it";
    case "foreign":
      return "unmarked file present — install will refuse to overwrite it";
    case "stale":
      return `installed at ${state.at} — re-run install to heal it to v${String(OMP_SLASH_CATALOG_MARKER_VERSION)}`;
    case "installed":
      return `installed (${state.at})`;
  }
}

/** `collie hooks install claude|omp` — Claude: merge beacon registrations. omp: write the catalog extension. */
export function cmdHooksInstall(deps: HooksDeps, args: readonly string[]): number {
  const harness = readHarness(deps, args, "install");
  if (harness === null) return EXIT.USAGE;
  if (harness === "omp") return cmdOmpHooksInstall(deps);
  const { command, binary, source } = resolveHookCommand(deps.ctx, deps.fs);
  let failed = false;

  for (const target of claudeSettingsTargets(deps.ctx)) {
    const symlink = symlinkOnPath(deps, target);
    if (symlink !== null) {
      refuseSymlink(deps, symlink);
      failed = true;
      continue;
    }
    const settings = readSettings(deps, target);
    if (settings === null) {
      deps.io.err(`error: ${target.path} is not valid JSON — leaving it alone.`);
      deps.io.err("  Fix it (or move it aside), then re-run; a merge into a file we cannot read would lose it.");
      failed = true;
      continue;
    }
    const outcome = installDocument(settings.value, command);
    if (outcome.kind === "refuse") {
      deps.io.err(`error: ${target.path} cannot be merged into — ${outcome.reason}.`);
      failed = true;
      continue;
    }
    const text = serializeSettings(outcome.document);
    if (text === settings.text) {
      deps.io.out(`${target.path} already has them — no bytes changed.`);
      continue;
    }
    try {
      writeSettings(deps, target, settings.text, text);
    } catch (err) {
      deps.io.err(`error: could not write ${target.path} — ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
      continue;
    }
    deps.io.out(`✓ ${target.path}`);
  }

  if (failed) return EXIT.FAIL;
  deps.io.out(`  ${BEACON_HOOKS.map((r) => r.event).join(", ")} → \`${binary} beacon emit\``);
  deps.io.out(`  ${PINNED_NOTE[source]}`);
  deps.io.out("  Outside tmux/zellij the hook exits immediately and writes nothing.");
  return EXIT.OK;
}

/** `collie hooks uninstall claude|omp` — remove only what collie owns. */
export function cmdHooksUninstall(deps: HooksDeps, args: readonly string[]): number {
  const harness = readHarness(deps, args, "uninstall");
  if (harness === null) return EXIT.USAGE;
  if (harness === "omp") return cmdOmpHooksUninstall(deps);
  let failed = false;
  let removed = 0;

  for (const target of claudeSettingsTargets(deps.ctx)) {
    const settings = readSettings(deps, target);
    if (settings === null || settings.text === null) continue;
    const symlink = symlinkOnPath(deps, target);
    if (symlink !== null) {
      refuseSymlink(deps, symlink);
      failed = true;
      continue;
    }
    const outcome = uninstallDocument(settings.value);
    if (outcome.kind === "refuse") continue;
    const text = serializeSettings(outcome.document);
    if (text === settings.text) continue;
    try {
      writeSettings(deps, target, settings.text, text);
    } catch (err) {
      deps.io.err(`error: could not write ${target.path} — ${err instanceof Error ? err.message : String(err)}`);
      failed = true;
      continue;
    }
    deps.io.out(`✓ ${target.path} — removed the marked entries; every other hook is untouched.`);
    removed += 1;
  }

  if (failed) return EXIT.FAIL;
  if (removed === 0) deps.io.out("nothing to remove — no settings file here carries a collie-beacon entry.");
  return EXIT.OK;
}

/**
 * What ONE settings file carries, as a verdict rather than a sentence.
 *
 * `status` renders these into its lines; `--check` branches on them. One reading, two readers — the
 * same rule {@link markedCommandsByEvent} exists for, one level up.
 */
export type HookTargetState =
  | { readonly kind: "refused"; readonly symlink: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "absent" }
  | { readonly kind: "not-installed" }
  /** Ours, and missing at least one registration this build knows — the shape a grown set leaves. */
  | { readonly kind: "partial"; readonly at: string; readonly present: number }
  /** Ours, complete, but written by a build whose marker was a different version. */
  | { readonly kind: "stale"; readonly at: string }
  | { readonly kind: "installed"; readonly at: string };

function targetState(deps: HooksDeps, target: HookTarget): HookTargetState {
  const symlink = symlinkOnPath(deps, target);
  if (symlink !== null) return { kind: "refused", symlink };
  const settings = readSettings(deps, target);
  if (settings === null) return { kind: "unreadable" };
  if (settings.text === null) return { kind: "absent" };
  const versions = new Set<string>();
  let present = 0;
  for (const command of markedCommandsByEvent(settings.value)) {
    if (command === null) continue;
    present += 1;
    versions.add(String(markerVersionOf(command)));
  }
  if (present === 0) return { kind: "not-installed" };
  const at = `v${[...versions].join("/")}`;
  if (present < BEACON_HOOKS.length) return { kind: "partial", at, present };
  return versions.has(String(HOOK_MARKER_VERSION)) && versions.size === 1
    ? { kind: "installed", at }
    : { kind: "stale", at };
}

/**
 * Is any settings file BEHIND this build — carrying our entries, but not all of them, or at a marker
 * version this build no longer writes?
 *
 * "Behind" is deliberately narrower than "install would change something". A file with none of our
 * entries is not behind, it OPTED OUT, and nothing should nag about it. Absent, unreadable and
 * refused files are not behind either: they are `doctor`'s business, not an afterthought's.
 *
 * This is the question `collie update` asks — of the NEWLY installed binary, never in-process, since
 * {@link BEACON_HOOKS} is compiled in and the old build's copy is exactly the stale thing.
 */
export function hooksAreBehind(deps: HooksDeps): boolean {
  const claudeBehind = claudeSettingsTargets(deps.ctx)
    .map((target) => targetState(deps, target))
    .some((state) => state.kind === "partial" || state.kind === "stale");
  const omp = ompCatalogState(deps);
  const ompBehind = omp.kind === "stale";
  return claudeBehind || ompBehind;
}

/**
 * `collie hooks status` — READ-ONLY. It reports; it never repairs.
 *
 * `--check` is the same verdict for a caller with no eyes: nothing on stdout, and the exit code IS
 * the answer — `EXIT.STATE` ("the local state says no", `cli/io.ts`) when {@link hooksAreBehind},
 * `EXIT.OK` otherwise. `collie update` runs it on the binary it just installed; keeping it a flag on
 * the existing verb means the two answers cannot drift, and it leaves `status`'s own contract alone.
 */
export function cmdHooksStatus(deps: HooksDeps, args: readonly string[] = []): number {
  if (args.includes("--check")) return hooksAreBehind(deps) ? EXIT.STATE : EXIT.OK;
  const { binary, source } = resolveHookCommand(deps.ctx, deps.fs);
  deps.io.out(`would install: ${binary} beacon emit  (${SOURCE_NAME[source]})`);
  for (const target of claudeSettingsTargets(deps.ctx)) {
    deps.io.out(`${target.path}: ${describeTarget(deps, target)}`);
  }
  const omp = ompExtensionTarget(deps.ctx);
  deps.io.out(`${omp.path}: ${describeOmpCatalog(deps)}`);
  return EXIT.OK;
}

function describeTarget(deps: HooksDeps, target: HookTarget): string {
  const state = targetState(deps, target);
  switch (state.kind) {
    case "refused":
      return `refused — ${state.symlink} is a symlink`;
    case "unreadable":
      return "unreadable — not valid JSON";
    case "absent":
      return "no settings file — `collie hooks install claude` creates one";
    case "not-installed":
      return "not installed";
    // A file installed by an older build carries the events THAT build knew, which is what this reads
    // like once the set grows. So the line names the remedy: install adds the missing ones in place.
    case "partial":
      return `partly installed (${state.at}, ${state.present}/${BEACON_HOOKS.length} events) — re-run install to add the rest`;
    case "stale":
      return `installed at ${state.at} — re-run install to heal it to v${HOOK_MARKER_VERSION}`;
    case "installed":
      return `installed (${state.at})`;
  }
}

export function hooksUsage(): string {
  return `usage: collie hooks {${HOOKS_SUBCOMMANDS.join("|")}}`;
}

/** The parent verb. Reached by a bare `collie hooks` or a misspelt sub-verb, as `cmdDevices` is. */
export function cmdHooks(deps: HooksDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "install":
      return cmdHooksInstall(deps, rest);
    case "uninstall":
      return cmdHooksUninstall(deps, rest);
    case "status":
      return cmdHooksStatus(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown hooks subcommand \`${sub}\``);
      }
      deps.io.err(hooksUsage());
      deps.io.err("  install     register what collie owns: `hooks install claude|omp`");
      deps.io.err("  uninstall   remove only the entries collie owns: `hooks uninstall claude|omp`");
      deps.io.err("  status      what each settings file / omp extension carries right now (reads only)");
      return EXIT.USAGE;
  }
}
