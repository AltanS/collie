import { dirname, join } from "node:path";

import { BEACON_HOOKS, type HookRegistration } from "./beacon.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { type LinkReader, linkPath } from "./link.ts";
import type { Files } from "./sys.ts";
import { collieBinary } from "./unit.ts";

// `collie hooks install claude` / `uninstall claude` / `status` — putting the beacon emitter into the
// agent's own settings, and taking it back out.
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

/** The harnesses that have an emitter. One today; the arg is required so the second needs no new verb. */
export const HOOK_HARNESSES = ["claude"] as const;

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

/** Which absolute name the hook was pinned to. Reported by `status` (and by `doctor`, M11/05). */
export type HookCommandSource = "path-link" | "checkout";

export interface HookCommand {
  readonly binary: string;
  readonly source: HookCommandSource;
  /** Exactly what goes into `settings.json`, marker included. */
  readonly command: string;
}

/**
 * The command an entry runs — ALWAYS an absolute path.
 *
 * A hook does not run under the operator's login shell (the same trap as a Herdr plugin action), so a
 * bare `collie` can simply not be found. `~/.local/bin/collie` is preferred when `collie link`
 * published it and it points at THIS checkout: by ADR 0021 that name is a symlink, never a copy, so
 * it survives every rebuild and even a checkout that moves house. Otherwise the checkout's own binary
 * is written and `status` says so, because that pins the hook to one directory.
 */
export function resolveHookCommand(ctx: CliContext, fs: LinkReader): HookCommand {
  const own = collieBinary(ctx.root);
  const published = linkPath(ctx.home);
  const probe = fs.probe(published);
  const source: HookCommandSource = probe.kind === "symlink" && probe.target === own ? "path-link" : "checkout";
  const binary = source === "path-link" ? published : own;
  return { binary, source, command: `${binary} beacon emit ${HOOK_MARKER}` };
}

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

export type HookDocument =
  | { readonly kind: "document"; readonly document: JsonObject }
  /** The file is not one we may edit, and `reason` is the whole sentence the operator reads. */
  | { readonly kind: "refuse"; readonly reason: string };

/** One registration group, as we write it. `matcher` is dropped by `JSON.stringify` when absent. */
function ourGroup(registration: HookRegistration, command: string): JsonObject {
  return {
    matcher: registration.matcher,
    hooks: [{ type: "command", command }],
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

/** The settings document with our four registrations present, or a refusal. */
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
    deps.io.err(`  \`${name}\` has no beacon emitter — only ${HOOK_HARNESSES.join(", ")} does.`);
  }
  return null;
}

/** `collie hooks install claude` — merge the four registrations into every target. */
export function cmdHooksInstall(deps: HooksDeps, args: readonly string[]): number {
  if (readHarness(deps, args, "install") === null) return EXIT.USAGE;
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
  deps.io.out(
    source === "path-link"
      ? "  Pinned to the published name (a symlink to this checkout), so a rebuild needs no re-install."
      : `  Pinned to this checkout — re-run after \`collie link\` to pin to ~/.local/bin instead.`,
  );
  deps.io.out("  Outside tmux/zellij the hook exits immediately and writes nothing.");
  return EXIT.OK;
}

/** `collie hooks uninstall claude` — remove only what carries the marker. */
export function cmdHooksUninstall(deps: HooksDeps, args: readonly string[]): number {
  if (readHarness(deps, args, "uninstall") === null) return EXIT.USAGE;
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

/** `collie hooks status` — READ-ONLY. It reports; it never repairs. */
export function cmdHooksStatus(deps: HooksDeps): number {
  const { binary, source } = resolveHookCommand(deps.ctx, deps.fs);
  deps.io.out(`would install: ${binary} beacon emit  (${source === "path-link" ? "the published PATH name" : "this checkout"})`);
  for (const target of claudeSettingsTargets(deps.ctx)) {
    deps.io.out(`${target.path}: ${describeTarget(deps, target)}`);
  }
  return EXIT.OK;
}

function describeTarget(deps: HooksDeps, target: HookTarget): string {
  const symlink = symlinkOnPath(deps, target);
  if (symlink !== null) return `refused — ${symlink} is a symlink`;
  const settings = readSettings(deps, target);
  if (settings === null) return "unreadable — not valid JSON";
  if (settings.text === null) return "no settings file — `collie hooks install claude` creates one";
  const section = asObject(asObject(settings.value)?.hooks) ?? {};
  const versions = new Set<string>();
  let present = 0;
  for (const registration of BEACON_HOOKS) {
    const groups = asArray(section[registration.event]) ?? [];
    const command = groups.map((group) => markedCommandIn(group)).find((found) => found !== null);
    if (command === undefined || command === null) continue;
    present += 1;
    versions.add(String(markerVersionOf(command)));
  }
  if (present === 0) return "not installed";
  const at = `v${[...versions].join("/")}`;
  if (present < BEACON_HOOKS.length) return `partly installed (${present}/${BEACON_HOOKS.length}, ${at})`;
  return versions.has(String(HOOK_MARKER_VERSION)) && versions.size === 1
    ? `installed (${at})`
    : `installed at ${at} — re-run install to heal it to v${HOOK_MARKER_VERSION}`;
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
      return cmdHooksStatus(deps);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`error: unknown hooks subcommand \`${sub}\``);
      }
      deps.io.err(hooksUsage());
      deps.io.err("  install     register the beacon hooks: `hooks install claude`");
      deps.io.err("  uninstall   remove only the entries collie owns: `hooks uninstall claude`");
      deps.io.err("  status      what each settings file carries right now (reads only)");
      return EXIT.USAGE;
  }
}
