import { dirname, join } from "node:path";

import { HOST } from "../bridge/host.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject, asJsonString, parseJson } from "../web/src/lib/json.ts";
import { CODEX_HOOK_EVENTS } from "./codex-hook.ts";
import { codexHome } from "./codex-hooks.ts";
import type { CliContext } from "./context.ts";
import { EXIT } from "./io.ts";
import type { HooksDeps } from "./hooks.ts";
import type { LinkReader } from "./link.ts";
import type { Files } from "./sys.ts";

// `collie hooks install codex --native` / `uninstall codex` / `status`: Codex's own lifecycle hooks,
// in `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json` when CODEX_HOME is unset). Each one runs
// `collie beacon codex-hook` (cli/codex-hook.ts), which names the pane's Codex session.
//
// It sits BESIDE the `notify` install (cli/codex-hooks.ts), which is what a bare `hooks install codex`
// still writes. The two are independent: this one never opens `config.toml`, so the operator's own
// notify command and the trust state Codex keeps there are not read or changed. Codex asks the person
// to trust a new or changed hook ("Hooks need review" at its next start), and that is how these
// entries come to run. Nothing here tries to pre-trust them.
//
// Derived from the native installer of PR #596 (Daniel JB Clark), without its permission hold.
//
// ── THE RULES ─────────────────────────────────────────────────────────────────────────────────────
//
//  1. OWNERSHIP IS THE COMMAND. Codex rejects unknown keys in a handler, so there is nowhere to put a
//     marker but the command itself: `'<binary>' beacon codex-hook # collie-codex v<N>`. A handler
//     whose command has that shape is ours, at any version and for any binary, which is what lets an
//     install re-point a moved binary. Every other handler is never edited, moved or removed.
//  2. NEW ENTRIES GO LAST. Codex keys a hook's trust by where it stands in the file
//     (`hooks.json:<event>:<group>:<handler>`, as PR #596 read it in Codex's source), so a new group is
//     appended, and one of ours is replaced in its own slot. Every other entry keeps its place.
//  3. TWO OF OURS ON ONE EVENT REFUSE. Nothing says which one the operator meant to keep.
//  4. WRITES ARE ATOMIC AND CHECKED. A temp file and a rename, a `.collie-backup` before the first
//     change, and the file read once more right before the rename or the removal: a change in between
//     (an editor saving, Codex itself) writes and removes nothing.
//  5. A FILE THAT IS THERE BUT CANNOT BE READ IS REFUSED. `Files.read` answers null for a missing file
//     and for a failed read alike, so the entry is looked at too. Read as absent, an unreadable file
//     would be replaced by Collie's hooks alone, with no backup, and the operator's hooks would be gone.
//  6. IT IS IDEMPOTENT. The same install writes no bytes. Uninstall removes ours and nothing else, and
//     removes a file the install created once nothing is left in it.
//  7. A SYMLINKED FILE IS REFUSED, a rename would replace the link. A symlinked folder (a stowed
//     `~/.codex`) is followed, as the Claude install follows its folder.

/** The flag that picks this install: `collie hooks install codex --native`. */
export const NATIVE_FLAG = "--native";

/** What follows the binary in the command we write. */
export const NATIVE_VERB = "beacon codex-hook";

/** The ownership marker's version. Bump it when the COMMAND has to change shape. */
export const NATIVE_MARKER_VERSION = 1;

export const NATIVE_MARKER_PREFIX = "# collie-codex v";

/** Our command, at any version, for any binary: the binary as one single-quoted shell word. */
const OWNED = /^'((?:[^']|'\\'')+)' beacon codex-hook # collie-codex v(\d+)$/u;

/** The hooks file this install writes. */
export const hooksJsonPath = (ctx: Pick<CliContext, "home" | "env">): string => join(codexHome(ctx), "hooks.json");

/** A path as one POSIX shell word. */
const quote = (text: string): string => `'${text.replace(/'/gu, "'\\''")}'`;

/**
 * The command a native entry runs. One simple command, so the shell Codex starts it in can replace
 * itself with it; the comment is the ownership marker and changes nothing about what runs.
 */
export function nativeCommand(binary: string): string {
  return `${quote(binary)} ${NATIVE_VERB} ${NATIVE_MARKER_PREFIX}${String(NATIVE_MARKER_VERSION)}`;
}

/** One handler of ours: the binary it runs and the marker version it carries. */
export interface OwnedHandler {
  readonly binary: string;
  readonly version: number;
}

/** The binary and version of a command of ours, or null when the command is not ours. */
export function ownedHandler(command: JsonValue | undefined): OwnedHandler | null {
  const text = asJsonString(command);
  const match = text === undefined ? null : OWNED.exec(text);
  if (match === null) return null;
  return { binary: match[1]!.replace(/'\\''/gu, "'"), version: Number(match[2]) };
}

// ── The document ──────────────────────────────────────────────────────────────

/** Where one handler stands in an event's groups. */
interface Slot {
  readonly group: number;
  readonly handler: number;
}

/** The handlers of one group, or null for a group of another shape (left as it is). */
function handlersOf(group: JsonValue | undefined): JsonValue[] | null {
  const handlers = asJsonObject(group)?.hooks;
  return Array.isArray(handlers) ? handlers : null;
}

/** Every handler of ours in an event's groups, in order. */
function oursIn(groups: readonly JsonValue[]): Slot[] {
  const out: Slot[] = [];
  groups.forEach((group, g) => {
    (handlersOf(group) ?? []).forEach((handler, h) => {
      if (ownedHandler(asJsonObject(handler)?.command) !== null) out.push({ group: g, handler: h });
    });
  });
  return out;
}

/** The handler at a slot, in a copy of its group. Every other key of the group stays as it was. */
function putHandler(groups: JsonValue[], slot: Slot, handler: JsonObject): void {
  const group = asJsonObject(groups[slot.group]);
  const handlers = handlersOf(groups[slot.group]);
  if (group === undefined || handlers === null) return;
  const next = [...handlers];
  next[slot.handler] = handler;
  groups[slot.group] = { ...group, hooks: next };
}

export type NativePlan = { readonly kind: "plan"; readonly document: JsonObject } | { readonly kind: "refuse"; readonly reason: string };

/** The section of hooks, or the reason the file cannot be merged into. */
function sectionOf(current: JsonValue | null): { readonly root: JsonObject; readonly section: JsonObject } | { readonly reason: string } {
  const root = current === null ? {} : asJsonObject(current);
  if (root === undefined) return { reason: "its top level is not a JSON object" };
  const section = root.hooks === undefined ? {} : asJsonObject(root.hooks);
  if (section === undefined) return { reason: "its `hooks` is not a JSON object" };
  return { root, section };
}

/** The hooks document with one handler of ours on every event, or a refusal. Pure. */
export function planNativeInstall(current: JsonValue | null, binary: string): NativePlan {
  const read = sectionOf(current);
  if ("reason" in read) return { kind: "refuse", reason: read.reason };
  const hooks: JsonObject = { ...read.section };
  for (const row of CODEX_HOOK_EVENTS) {
    const raw = read.section[row.event];
    if (raw !== undefined && !Array.isArray(raw)) return { kind: "refuse", reason: `its \`hooks.${row.event}\` is not a JSON array` };
    const groups = raw === undefined ? [] : [...raw];
    const ours = oursIn(groups);
    if (ours.length > 1) return { kind: "refuse", reason: `it has ${String(ours.length)} Collie entries on ${row.event}, and nothing says which one to keep` };
    // Key order is fixed, so the same install is the same bytes.
    const handler: JsonObject = { type: "command", command: nativeCommand(binary), timeout: row.timeout };
    const slot = ours[0];
    if (slot === undefined) groups.push({ hooks: [handler] });
    else putHandler(groups, slot, handler);
    hooks[row.event] = groups;
  }
  return { kind: "plan", document: { ...read.root, hooks } };
}

/** What an uninstall leaves: the document, and how many handlers of ours left it. */
export interface NativeRemoval {
  readonly document: JsonValue;
  readonly removed: number;
}

/** The hooks document with every handler of ours removed, and how many went. Pure. */
export function planNativeUninstall(current: JsonValue): NativeRemoval {
  const read = sectionOf(current);
  if ("reason" in read) return { document: current, removed: 0 };
  const hooks: JsonObject = { ...read.section };
  let removed = 0;
  for (const [event, raw] of Object.entries(read.section)) {
    if (!Array.isArray(raw)) continue;
    const ours = oursIn(raw).length;
    if (ours === 0) continue;
    removed += ours;
    const groups: JsonValue[] = [];
    for (const group of raw) {
      const handlers = handlersOf(group);
      const node = asJsonObject(group);
      if (handlers === null || node === undefined) {
        groups.push(group);
        continue;
      }
      const left = handlers.filter((handler) => ownedHandler(asJsonObject(handler)?.command) === null);
      // A group we emptied goes: we are the only reason it was there. Any other group stays as it was.
      if (left.length === handlers.length) groups.push(group);
      else if (left.length > 0) groups.push({ ...node, hooks: left });
    }
    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }
  const document: JsonObject = { ...read.root, hooks };
  if (Object.keys(hooks).length === 0) delete document.hooks;
  return { document, removed };
}

/** What the hooks file holds of ours, as a verdict. `status`, `doctor` and the install read it one way. */
export type NativeState =
  | { readonly kind: "symlink" }
  /** The file is there and could not be read (rule 5). */
  | { readonly kind: "unreadable" }
  /** The file was read and is not JSON. */
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" }
  | { readonly kind: "not-installed" }
  | { readonly kind: "duplicate"; readonly event: string }
  | { readonly kind: "partial"; readonly missing: readonly string[] }
  /** Every event carries ours, but not the command this build writes: another binary, or an older marker. */
  | { readonly kind: "behind"; readonly binary: string; readonly version: number }
  | { readonly kind: "installed"; readonly binary: string };

/** The verdict for one parsed document, against the binary an install would pin. Pure. */
export function nativeStateOf(document: JsonValue | null, binary: string): NativeState {
  const section = asJsonObject(asJsonObject(document ?? undefined)?.hooks) ?? {};
  const missing: string[] = [];
  const found: OwnedHandler[] = [];
  for (const row of CODEX_HOOK_EVENTS) {
    const raw = section[row.event];
    const groups = Array.isArray(raw) ? raw : [];
    const ours = oursIn(groups);
    if (ours.length > 1) return { kind: "duplicate", event: row.event };
    const slot = ours[0];
    if (slot === undefined) {
      missing.push(row.event);
      continue;
    }
    const handler = ownedHandler(asJsonObject(handlersOf(groups[slot.group])?.[slot.handler])?.command);
    if (handler !== null) found.push(handler);
  }
  if (found.length === 0) return { kind: "not-installed" };
  if (missing.length > 0) return { kind: "partial", missing };
  const other = found.find((handler) => handler.binary !== binary || handler.version !== NATIVE_MARKER_VERSION);
  return other === undefined ? { kind: "installed", binary } : { kind: "behind", binary: other.binary, version: other.version };
}

/** Whether a hooks file's text carries a handler of ours on any event: the bridge's "installed" probe. */
export function documentCarriesNativeHooks(text: string): boolean {
  const section = asJsonObject(asJsonObject(parseJson(text))?.hooks);
  if (section === undefined) return false;
  return Object.values(section).some((groups) => Array.isArray(groups) && oursIn(groups).length > 0);
}

// ── The file ──────────────────────────────────────────────────────────────────

/** What reading the file needs: the files, and the symlink probe. */
export type NativeReadDeps = { readonly files: Pick<Files, "read" | "realpath" | "entryType">; readonly fs: LinkReader; readonly ctx: Pick<CliContext, "home" | "env"> };

/** The hooks file as the install sees it: its folder resolved, and whether the file itself is a link. */
interface HooksFile {
  readonly path: string;
  readonly symlink: boolean;
}

/** The file's path with its folder resolved through every link (rule 7), and whether the file is a link. */
function resolvedPath(deps: NativeReadDeps): HooksFile {
  const path = hooksJsonPath(deps.ctx);
  const dir = deps.files.realpath(dirname(path));
  const real = dir === null ? path : join(dir, "hooks.json");
  return { path: real, symlink: deps.fs.probe(real).kind === "symlink" };
}

/** The file as read: its text (null for an absent file) and its parsed value (null for no document). */
interface HooksText {
  readonly text: string | null;
  readonly value: JsonValue | null;
}

/**
 * The file's text and parsed value, `unreadable` for a file that is there and could not be read (rule
 * 5), `invalid` for one that is not JSON. A null read is "absent" only when there is no entry at the path.
 */
function readHooks(files: Pick<Files, "read" | "entryType">, path: string): HooksText | "unreadable" | "invalid" {
  const text = files.read(path);
  if (text === null) return files.entryType(path) === null ? { text: null, value: null } : "unreadable";
  if (text.trim() === "") return { text, value: null };
  const value = parseJson(text);
  return value === undefined ? "invalid" : { text, value };
}

/** The native install's verdict, and the file it is about. */
export interface NativeReading {
  readonly path: string;
  readonly state: NativeState;
}

/** The native install's verdict and the file it is about. Reads only. */
export function readNativeState(deps: NativeReadDeps, binary: string): NativeReading {
  const { path, symlink } = resolvedPath(deps);
  if (symlink) return { path, state: { kind: "symlink" } };
  const hooks = readHooks(deps.files, path);
  if (hooks === "unreadable" || hooks === "invalid") return { path, state: { kind: hooks } };
  if (hooks.text === null) return { path, state: { kind: "absent" } };
  return { path, state: nativeStateOf(hooks.value, binary) };
}

/** `hooks.json` as Codex writes it: two-space JSON and a final line break. */
export const serializeHooks = (document: JsonValue): string => `${JSON.stringify(document, null, 2)}\n`;

/** The file changed between the read the plan came from and the rename or the removal. The message is the whole fact. */
class ChangedUnderUs extends Error {}

/** Temp file, the one-time backup, one more read, then the rename (rule 4). */
function writeHooks(deps: HooksDeps, path: string, previous: string | null, text: string): void {
  const backup = `${path}.collie-backup`;
  if (previous !== null && !deps.files.exists(backup)) deps.files.write(backup, previous, 0o600);
  const temp = `${path}.collie-tmp`;
  try {
    deps.files.write(temp, text, 0o600);
    if (deps.files.read(path) !== previous) throw new ChangedUnderUs(`${path} changed while Collie was writing it. Nothing was written.`);
    deps.files.rename(temp, path);
  } catch (err) {
    deps.files.remove(temp);
    throw err;
  }
}

/** One more read, then the removal (rule 4): a file someone saved since Collie read it stays. */
function removeHooks(deps: HooksDeps, path: string, previous: string): void {
  if (deps.files.read(path) !== previous) throw new ChangedUnderUs(`${path} changed while Collie was removing it. Nothing was removed.`);
  deps.files.remove(path);
}

/** The line for a file that changed under a write or a removal: the verb is safe to run again. */
const changedLine = (err: ChangedUnderUs, verb: string): string => `error: ${err.message} Run \`collie hooks ${verb} codex ${NATIVE_FLAG}\` again.`;

/** The two lines for a file that is there and could not be read (rule 5). */
function unreadableLines(deps: HooksDeps, path: string): void {
  deps.io.err(`error: ${path} is there, and Collie cannot read it. Collie leaves it alone.`);
  deps.io.err("  Give your user read access to it, then run the command again. A merge into a file Collie cannot read would lose it.");
}

// ── The verbs ─────────────────────────────────────────────────────────────────

/** `collie hooks install codex --native`. `binary` is the absolute name the Claude hooks pin to (cli/hooks.ts). */
export function cmdCodexNativeInstall(deps: HooksDeps, binary: string, pinnedNote: string): number {
  if (HOST.platform === "win32") {
    deps.io.err("error: the native Codex hooks are not built for Windows. Their command is a POSIX shell line.");
    return EXIT.FAIL;
  }
  const { path, symlink } = resolvedPath(deps);
  if (symlink) {
    deps.io.err(`error: ${path} is a symlink. Collie does not write there, a rename would replace the link.`);
    deps.io.err("  Replace it with the real file, then run `collie hooks install codex --native` again.");
    return EXIT.FAIL;
  }
  const hooks = readHooks(deps.files, path);
  if (hooks === "unreadable") {
    unreadableLines(deps, path);
    return EXIT.FAIL;
  }
  if (hooks === "invalid") {
    deps.io.err(`error: ${path} is not valid JSON. Collie leaves it alone.`);
    deps.io.err("  Fix it or move it aside, then run the install again. A merge into a file Collie cannot parse would lose it.");
    return EXIT.FAIL;
  }
  const plan = planNativeInstall(hooks.value, binary);
  if (plan.kind === "refuse") {
    deps.io.err(`error: ${path} cannot take the Collie hooks: ${plan.reason}. Nothing was written.`);
    return EXIT.FAIL;
  }
  const text = serializeHooks(plan.document);
  if (text === hooks.text) {
    deps.io.out(`${path} already has them. No bytes changed.`);
  } else {
    try {
      writeHooks(deps, path, hooks.text, text);
    } catch (err) {
      deps.io.err(err instanceof ChangedUnderUs ? changedLine(err, "install") : `error: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT.FAIL;
    }
    deps.io.out(`✓ ${path}`);
  }
  deps.io.out(`  ${CODEX_HOOK_EVENTS.map((row) => row.event).join(", ")} → \`${binary} ${NATIVE_VERB}\``);
  deps.io.out(`  ${pinnedNote}`);
  deps.io.out('  At its next start Codex shows "Hooks need review". Trust the Collie hooks there, or Codex never runs them.');
  deps.io.out("  On herdr-core they name each Codex pane's session, which gives the pane Chat and History.");
  deps.io.out("  Start Codex as `codex --no-daemon` there. Plain `codex` runs its hooks in a shared background process that names no pane.");
  deps.io.out("  config.toml was not read or changed.");
  return EXIT.OK;
}

/** `collie hooks uninstall codex` (and `--native`): removes the handlers of ours and nothing else. */
export function cmdCodexNativeUninstall(deps: HooksDeps): number {
  const { path, symlink } = resolvedPath(deps);
  const hooks = symlink ? null : readHooks(deps.files, path);
  if (hooks === "unreadable") {
    unreadableLines(deps, path);
    return EXIT.FAIL;
  }
  if (hooks === "invalid") {
    deps.io.err(`error: ${path} is not valid JSON. Collie leaves it alone.`);
    return EXIT.FAIL;
  }
  const plan = hooks === null || hooks.value === null ? null : planNativeUninstall(hooks.value);
  if (hooks === null || plan === null || plan.removed === 0) {
    deps.io.out(`nothing to remove: ${path} has no Collie hooks.`);
    return EXIT.OK;
  }
  const emptied = asJsonObject(plan.document) !== undefined && Object.keys(asJsonObject(plan.document)!).length === 0;
  // The install created this file: it had nothing to back up. With our hooks gone it is empty, so it goes.
  if (emptied && !deps.files.exists(`${path}.collie-backup`) && hooks.text !== null) {
    try {
      removeHooks(deps, path, hooks.text);
    } catch (err) {
      deps.io.err(err instanceof ChangedUnderUs ? changedLine(err, "uninstall") : `error: could not remove ${path}: ${err instanceof Error ? err.message : String(err)}`);
      return EXIT.FAIL;
    }
    deps.io.out(`✓ ${path}: removed. The install had created it.`);
    return EXIT.OK;
  }
  try {
    writeHooks(deps, path, hooks.text, serializeHooks(plan.document));
  } catch (err) {
    deps.io.err(err instanceof ChangedUnderUs ? changedLine(err, "uninstall") : `error: could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ ${path}: removed the Collie hooks. Every other hook is untouched.`);
  return EXIT.OK;
}

/** One line for `collie hooks status`: what the hooks file carries. Reads only. */
export function codexNativeStatusLine(deps: HooksDeps, binary: string): string {
  const { path, state } = readNativeState(deps, binary);
  const again = `Run \`collie hooks install codex ${NATIVE_FLAG}\` again`;
  switch (state.kind) {
    case "symlink":
      return `${path}: refused, the file is a symlink`;
    case "unreadable":
      return `${path}: unreadable, Collie cannot read the file`;
    case "invalid":
      return `${path}: not valid JSON`;
    case "absent":
      return `${path}: no hooks file. \`collie hooks install codex ${NATIVE_FLAG}\` creates one`;
    case "not-installed":
      return `${path}: native hooks not installed`;
    case "duplicate":
      return `${path}: two Collie entries on ${state.event}. Remove one by hand, then run the install again`;
    case "partial":
      return `${path}: native hooks partly installed, ${state.missing.join(", ")} missing. ${again}`;
    case "behind":
      return state.version === NATIVE_MARKER_VERSION
        ? `${path}: native hooks installed for ${state.binary}. ${again} to pin them to ${binary}`
        : `${path}: native hooks installed at v${String(state.version)}. ${again} to heal them to v${String(NATIVE_MARKER_VERSION)}`;
    case "installed":
      return `${path}: native hooks installed. Codex runs them once you trust them`;
  }
}
