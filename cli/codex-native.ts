import { dirname, join } from "node:path";

import { HOST } from "../bridge/host.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonString, parseJson } from "../web/src/lib/json.ts";
import { compareSemver } from "../web/src/lib/semver.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { binaryVersion } from "../bridge/surface/binary-version.ts";
import { codexHome } from "./codex-hooks.ts";
import { MOSHI_ENTRY_COMMAND, isMoshiCommand, moshiNow, moshiVerdict, capabilityPath } from "./codex-moshi.ts";
import { readRecord, RECORD_FILE, recordPath, serializeRecord, type NativeRecord, type ReplacedMoshi } from "./codex-native-record.ts";
import { EXIT } from "./io.ts";
import type { HooksDeps } from "./hooks.ts";

// `collie hooks install codex --native [--hold-permissions [--with-moshi]]` / `uninstall codex` / `status`:
// Codex's own hooks, in `$CODEX_HOME/hooks.json` (`~/.codex/hooks.json`).
//
// This is the second way to install the Codex hooks; the first is the legacy `notify` line in
// `config.toml` (cli/codex-hooks.ts), which stays exactly as it was and is what a bare `hooks install
// codex` still does. Native mode writes ONLY hooks.json and the Collie-owned record beside it
// (cli/codex-native-record.ts). It never opens `config.toml`, so the operator's own `notify` command
// (the computer-use client's, say) is not read, moved or rewritten, and it never touches the trust
// state Codex keeps there (`[hooks.state]`) or any flag around it: Codex asks the person to review and
// trust a new or changed hook in `/hooks`, and that is how these entries come to run.
//
// ── THE RULES ─────────────────────────────────────────────────────────────────────────────────────
//  1. OWNERSHIP IS THE COMMAND. An entry is ours when its command is `'<binary>' codex-hook # collie-codex
//     v<N>` (Codex rejects unknown keys in a handler, so there is nowhere else to put a marker). Nothing
//     else is ever edited, reordered or removed.
//  2. NEW ENTRIES GO LAST. Codex keys a hook's trust by its position (`hooks.json:<event>:<group>:<handler>`),
//     so appending a group leaves every other entry's trust where it was, and so does removing ours again.
//  3. DUPLICATES REFUSE. Two entries of ours on one event, two entries that are exactly Moshi's, or ours
//     and Moshi's together (in any spelling): nothing says which one the operator meant, so nothing is
//     written. An entry of ours on PermissionRequest with NO record beside it refuses too: it may be a
//     broker, and the entry Moshi had lives only in that record (the uninstall refuses the same way).
//  4. ONE PERMISSION HANDLER. Codex runs every matching PermissionRequest handler and any deny wins. So
//     with `--with-moshi` the exact Moshi entry (`'/opt/homebrew/bin/moshi' codex-hook`) would be
//     REPLACED, in its own slot, by the broker (cli/codex-broker.ts), and the entry as it was saved in
//     the record; uninstall puts that very object back. Without `--with-moshi`, a Moshi
//     PermissionRequest entry, whatever its path or quoting (`moshi` or `moshi-hook` then `codex-hook`),
//     makes the hold install refuse: Moshi's phone card is not withdrawn when Collie decides first
//     (issue #595), and a second handler would hold the turn for the first. A Moshi entry that appears
//     AFTER the install is caught where it runs: `collie codex-hook` reads hooks.json and holds nothing
//     while one is there, and `hooks status` says so.
//  5. THE CAPABILITY GATE (cli/codex-moshi.ts) comes before every write. `--with-moshi` with no proof
//     that Moshi withdraws its request when cancelled, with a proof that no longer matches the installed
//     Moshi, or for a Moshi known not to qualify (0.4.37 today), writes nothing at all and leaves
//     Moshi-only routing in place. No Moshi version qualifies yet, so the replacing path is tested and gated off.
//  6. WRITES ARE CHECKED AND ATOMIC. Each file is re-read right before its rename and compared with
//     what the plan was made from; a change in between aborts with nothing written. Temp file, then
//     rename, a one-time `.collie-backup`, the record first so a failed hooks write can be undone.
//  7. IT IS IDEMPOTENT. The same install writes no bytes.

export const NATIVE_FLAG = "--native";
export const WITH_MOSHI_FLAG = "--with-moshi";

/** What follows the binary in a command we write, and the ownership marker. One place, read by the reader below. */
export const NATIVE_VERB = "codex-hook";
export const NATIVE_MARKER_VERSION = 1;
export const NATIVE_MARKER_PREFIX = "# collie-codex v";
const OWNED = /^'((?:[^']|'\\'')+)' codex-hook # collie-codex v(\d+)$/u;

/** The edge events, with the timeout in seconds each is written with (Codex clamps SessionEnd and Interrupt to 1..3). */
export const NATIVE_EDGE_EVENTS: readonly { readonly event: string; readonly timeout: number }[] = [
  { event: "SessionStart", timeout: 10 },
  { event: "UserPromptSubmit", timeout: 10 },
  { event: "Stop", timeout: 10 },
  { event: "Interrupt", timeout: 3 },
  { event: "SessionEnd", timeout: 3 },
];

/** The hold events: the permission itself, and the tool edge that ends its "Sent" card. */
export const NATIVE_HOLD_EVENTS: readonly { readonly event: string; readonly timeout: number }[] = [
  { event: "PermissionRequest", timeout: 300 },
  { event: "PostToolUse", timeout: 10 },
];

const PERMISSION = "PermissionRequest";

export const hooksJsonPath = (ctx: Parameters<typeof codexHome>[0]): string => join(codexHome(ctx), "hooks.json");

/** A path as one shell word. */
const quote = (text: string): string => `'${text.replace(/'/gu, "'\\''")}'`;

/** The command a native entry runs for this binary. */
export function nativeCommand(binary: string): string {
  return `${quote(binary)} ${NATIVE_VERB} ${NATIVE_MARKER_PREFIX}${String(NATIVE_MARKER_VERSION)}`;
}

/** The binary an owned command names, or null when the command is not ours. */
export function ownedBinary(command: JsonValue | undefined): string | null {
  const text = asJsonString(command);
  if (text === undefined) return null;
  const match = OWNED.exec(text);
  return match === null ? null : match[1]!.replace(/'\\''/gu, "'");
}

// ── The document ────────────────────────────────────────────────────────────────

function asObject(value: JsonValue | undefined): JsonObject | null {
  return value instanceof Object && !Array.isArray(value) ? value : null;
}

/** Where one handler stands in an event's groups. */
interface Slot {
  readonly group: number;
  readonly handler: number;
}

/** Every handler of an event for which `pick` is true, in order. A group or handler of another shape is passed over untouched. */
function slotsOf(groups: readonly JsonValue[], pick: (handler: JsonObject) => boolean): Slot[] {
  const out: Slot[] = [];
  groups.forEach((group, g) => {
    const handlers = asObject(group)?.hooks;
    if (!Array.isArray(handlers)) return;
    handlers.forEach((handler, h) => {
      const node = asObject(handler);
      if (node !== null && pick(node)) out.push({ group: g, handler: h });
    });
  });
  return out;
}

/** The handlers of one group, or null for a group of another shape. */
function handlersOf(group: JsonValue | undefined): JsonValue[] | null {
  const handlers = asObject(group)?.hooks;
  return Array.isArray(handlers) ? handlers : null;
}

/** The handler object at a slot, or null. */
function handlerAt(groups: readonly JsonValue[], slot: Slot): JsonObject | null {
  return asObject(handlersOf(groups[slot.group])?.[slot.handler]);
}

/** Puts `handler` into its slot, in a copy of the group, and leaves every other key of the group as it was. */
function putHandler(groups: JsonValue[], slot: Slot, handler: JsonValue): void {
  const group = asObject(groups[slot.group]);
  const list = handlersOf(groups[slot.group]);
  if (group === null || list === null) return;
  const next = [...list];
  next[slot.handler] = handler;
  groups[slot.group] = { ...group, hooks: next };
}

const isOurs = (handler: JsonObject): boolean => ownedBinary(handler.command) !== null;
/** Exactly Moshi's entry: the only spelling the broker can take over (its capability gate is made for that command). */
const isMoshi = (handler: JsonObject): boolean => handler.type === "command" && handler.command === MOSHI_ENTRY_COMMAND;
/** Moshi's `codex-hook` in any spelling: every one of them is a second remote-approval handler beside a Collie hold. */
const isMoshiLike = (handler: JsonObject): boolean => {
  const command = asJsonString(handler.command);
  return command !== undefined && isMoshiCommand(command);
};

/**
 * The handlers on `PermissionRequest` that are not Collie's: how many are Moshi's `codex-hook` in any
 * spelling, and how many are something else. A hold beside a Moshi one is the issue #595 setup (Moshi's
 * card is not withdrawn when Collie decides first); another handler only shares the decision.
 */
export function foreignPermission(document: JsonValue | null): { readonly moshi: number; readonly other: number } {
  const groups = asObject(asObject(document)?.hooks)?.[PERMISSION];
  let moshi = 0;
  let other = 0;
  if (!Array.isArray(groups)) return { moshi, other };
  for (const group of groups) {
    for (const handler of handlersOf(group) ?? []) {
      const node = asObject(handler);
      if (node === null || isOurs(node)) continue;
      if (isMoshiLike(node)) moshi += 1;
      else other += 1;
    }
  }
  return { moshi, other };
}

export interface InstallPlan {
  readonly hold: boolean;
  /** Replace the Moshi entry with the broker. */
  readonly moshi: boolean;
}

const refusal = (reason: string): PlanResult => ({ kind: "refuse", reason });

export type PlanResult =
  | { readonly kind: "plan"; readonly document: JsonObject; readonly replaced: ReplacedMoshi | null }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * The hooks document with every registration this install wants, or a refusal. Pure: `current` is the
 * parsed file (null for an absent one), `previous` the record of the last install.
 */
export function planInstall(current: JsonValue | null, command: string, want: InstallPlan, previous: NativeRecord | null): PlanResult {
  const root = current === null ? {} : asObject(current);
  if (root === null) return refusal("the file is not a JSON object");
  const sectionRaw = root.hooks;
  const section = sectionRaw === undefined ? {} : asObject(sectionRaw);
  if (section === null) return refusal("`hooks` is not an object");
  const hooks: JsonObject = { ...section };
  let replaced: ReplacedMoshi | null = null;

  const wanted = [...NATIVE_EDGE_EVENTS, ...(want.hold ? NATIVE_HOLD_EVENTS : [])];
  const unwanted = want.hold ? [] : NATIVE_HOLD_EVENTS;

  // The permission event first: the refusals about Moshi come before anything else is built.
  const permissionRaw = hooks[PERMISSION];
  if (permissionRaw !== undefined && !Array.isArray(permissionRaw)) return refusal(`\`${PERMISSION}\` is not an array`);
  const permission = permissionRaw === undefined ? [] : [...permissionRaw];
  const moshiSlots = slotsOf(permission, isMoshi);
  const moshiLike = slotsOf(permission, isMoshiLike);
  const ourPermission = slotsOf(permission, isOurs);
  if (moshiSlots.length > 1) return refusal(`${String(moshiSlots.length)} entries are exactly \`${MOSHI_ENTRY_COMMAND}\` on ${PERMISSION}; nothing says which one to take over`);
  if (ourPermission.length > 1) return refusal(`${String(ourPermission.length)} Collie entries on ${PERMISSION}`);
  if (moshiLike.length > 0 && ourPermission.length > 0) return refusal(`a Collie entry and a Moshi \`codex-hook\` entry are both registered on ${PERMISSION}`);
  // An entry of ours with no record beside it: it may be a broker standing in Moshi's place, and the entry
  // Moshi had is only in that record. Rewriting or removing it would destroy it, the uninstall refuses the same way.
  if (previous === null && ourPermission.length > 0) {
    return refusal(`a Collie entry is on ${PERMISSION} but ${RECORD_FILE} is missing, so it cannot be told from a broker that holds Moshi's place; restore the record or remove the entry by hand`);
  }
  if (want.hold && !want.moshi && moshiLike.length > 0) {
    return refusal(
      `a Moshi \`codex-hook\` entry is registered on ${PERMISSION}, and its phone card can stay answerable after Collie decides and approve an unrelated prompt (issue #595); install without \`--hold-permissions\`, or remove that entry yourself (\`${WITH_MOSHI_FLAG}\` is refused until Moshi can withdraw a card)`,
    );
  }
  if (want.moshi && !want.hold) return refusal(`\`${WITH_MOSHI_FLAG}\` needs \`--hold-permissions\``);
  if (want.moshi && moshiLike.length > moshiSlots.length) {
    return refusal(`a Moshi \`codex-hook\` entry on ${PERMISSION} is not spelled exactly \`${MOSHI_ENTRY_COMMAND}\`, and only that spelling can be taken over`);
  }
  if (want.moshi && moshiSlots.length === 0 && (ourPermission.length === 0 || previous?.moshi == null)) {
    return refusal(`no entry is exactly \`${MOSHI_ENTRY_COMMAND}\` on ${PERMISSION}, so there is nothing to take over`);
  }
  if (!want.moshi && ourPermission.length > 0 && previous?.moshi != null) {
    return refusal(`the ${PERMISSION} entry is the broker that took Moshi's place; run \`collie hooks uninstall codex\` first, or install again with \`${WITH_MOSHI_FLAG}\``);
  }

  for (const row of wanted) {
    const raw = hooks[row.event];
    if (raw !== undefined && !Array.isArray(raw)) return refusal(`\`${row.event}\` is not an array`);
    const groups = raw === undefined ? [] : [...raw];
    const ours = slotsOf(groups, isOurs);
    if (ours.length > 1) return refusal(`${String(ours.length)} Collie entries on ${row.event}`);
    // Key order is fixed, so the same install is the same bytes.
    const handler: JsonObject = { type: "command", command, timeout: row.timeout };
    const moshiSlot = moshiSlots[0];
    const ourSlot = ours[0];
    if (row.event === PERMISSION && want.moshi && moshiSlot !== undefined) {
      const original = handlerAt(groups, moshiSlot);
      if (original === null) return refusal("the Moshi entry cannot be read");
      replaced = { original: structuredClone(original), command: MOSHI_ENTRY_COMMAND, group: moshiSlot.group, handler: moshiSlot.handler };
      putHandler(groups, moshiSlot, handler);
    } else if (ourSlot !== undefined) {
      putHandler(groups, ourSlot, handler);
      if (row.event === PERMISSION && want.moshi) replaced = previous?.moshi ?? null;
    } else {
      groups.push({ hooks: [handler] });
    }
    hooks[row.event] = groups;
  }

  // Hold entries from an earlier install that this one does not ask for go away (never a broker: refused above).
  // An event with none of ours in it is not touched: an empty array someone else left there stays an empty array.
  for (const row of unwanted) {
    const raw = hooks[row.event];
    if (!Array.isArray(raw) || slotsOf(raw, isOurs).length === 0) continue;
    const groups = removeOwned(raw);
    if (groups.length === 0) delete hooks[row.event];
    else hooks[row.event] = groups;
  }
  return { kind: "plan", document: { ...root, hooks }, replaced };
}

/** The groups without our handlers; a group left empty by that is dropped, any other group stays as it was. */
function removeOwned(groups: readonly JsonValue[]): JsonValue[] {
  const out: JsonValue[] = [];
  for (const group of groups) {
    const node = asObject(group);
    const handlers = handlersOf(group);
    const ours = (h: JsonValue): boolean => {
      const handler = asObject(h);
      return handler !== null && isOurs(handler);
    };
    if (node === null || handlers === null || !handlers.some(ours)) {
      out.push(group);
      continue;
    }
    const left = handlers.filter((h) => !ours(h));
    if (left.length > 0) out.push({ ...node, hooks: left });
  }
  return out;
}

export type RemoveResult =
  | { readonly kind: "plan"; readonly document: JsonObject; readonly removed: number; readonly restored: boolean; readonly left: number }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * The document with every entry of ours gone, and the broker's slot given back to the Moshi entry the
 * record saved. A broker with no record to restore from is left in place (`left`), never replaced by a
 * guess of what Moshi's entry was.
 */
export function planUninstall(current: JsonValue, record: NativeRecord | null): RemoveResult {
  const root = asObject(current);
  const section = asObject(root?.hooks);
  if (root === null || section === null) return { kind: "plan", document: root ?? {}, removed: 0, restored: false, left: 0 };
  const hooks: JsonObject = { ...section };
  let removed = 0;
  let restored = false;
  let left = 0;
  for (const [event, raw] of Object.entries(hooks)) {
    if (!Array.isArray(raw)) continue;
    const count = slotsOf(raw, isOurs).length;
    if (count === 0) continue;
    if (event === PERMISSION) {
      if (count > 1) return { kind: "refuse", reason: `${String(count)} Collie entries on ${PERMISSION}; not guessing which one stands in for Moshi` };
      // With no record this entry might be a broker holding Moshi's place, and what Moshi's entry was
      // is not something to guess: it stays, and the verb says so.
      if (record === null) {
        left += 1;
        continue;
      }
      const slot = slotsOf(raw, isOurs)[0];
      if (record.moshi !== null && slot !== undefined) {
        const groups = [...raw];
        putHandler(groups, slot, structuredClone(record.moshi.original));
        hooks[event] = groups;
        removed += 1;
        restored = true;
        continue;
      }
      // A hold-only entry has nothing to give back: it is removed like the others.
    }
    removed += count;
    const groups = removeOwned(raw);
    if (groups.length === 0) delete hooks[event];
    else hooks[event] = groups;
  }
  return { kind: "plan", document: { ...root, hooks }, removed, restored, left };
}

// ── The verbs ───────────────────────────────────────────────────────────────────

/** `hooks.json` as Codex writes it: two-space JSON and a trailing newline. */
export const serializeHooks = (document: JsonObject): string => `${JSON.stringify(document, null, 2)}\n`;

/** The file changed between the read the plan came from and the moment before the rename. */
class ChangedUnderUs extends Error {
  constructor(readonly path: string) {
    super(`${path} changed while the install was running`);
  }
}

interface Target {
  readonly path: string;
  readonly previous: string | null;
  readonly text: string;
}

/**
 * Writes the targets in order, each atomically, after checking that every one still reads as the plan
 * assumed. A later failure puts the earlier targets back. Throws {@link ChangedUnderUs} before the first
 * rename when anything moved.
 */
function commit(deps: HooksDeps, targets: readonly Target[]): void {
  const { files } = deps;
  const stamp = `${String(process.pid)}.${String(Date.now())}`;
  for (const target of targets) if (files.read(target.path) !== target.previous) throw new ChangedUnderUs(target.path);
  const done: Target[] = [];
  try {
    for (const target of targets) {
      files.mkdirp(dirname(target.path), 0o700);
      const temp = `${target.path}.${stamp}.tmp`;
      const mode = files.mode(target.path);
      files.write(temp, target.text, mode === null ? 0o600 : mode & 0o777);
      // The last look: after this the rename is the only step left.
      if (files.read(target.path) !== target.previous) {
        files.remove(temp);
        throw new ChangedUnderUs(target.path);
      }
      const backup = `${target.path}.collie-backup`;
      if (target.previous !== null && !files.exists(backup)) files.write(backup, target.previous, 0o600);
      files.rename(temp, target.path);
      done.push(target);
    }
  } catch (err) {
    for (const target of done.toReversed()) {
      if (target.previous === null) files.remove(target.path);
      else files.write(target.path, target.previous, 0o600);
    }
    throw err;
  }
}

/** The directory's real path: a stowed `~/.codex` is followed, as the Claude installer follows its directory. */
function resolved(deps: HooksDeps, path: string): string {
  const dir = deps.files.realpath(dirname(path));
  return dir === null ? path : join(dir, path.slice(dirname(path).length + 1));
}

/** Reads and parses hooks.json. `null` text is an absent file; a file that is not JSON is `bad`. */
function readHooks(deps: HooksDeps, path: string): { readonly text: string | null; readonly value: JsonValue | null } | "bad" {
  const text = deps.files.read(path);
  if (text === null) return { text: null, value: null };
  const value = parseJson(text);
  return value === undefined ? "bad" : { text, value };
}

export interface NativeFlags {
  readonly hold: boolean;
  readonly moshi: boolean;
}

/** `collie hooks install codex --native …` */
export function cmdCodexNativeInstall(deps: HooksDeps, binary: string, flags: NativeFlags): number {
  if (HOST.platform === "win32") {
    deps.io.err("error: native Codex hooks are not built for Windows: the hook command is a POSIX shell line.");
    return EXIT.FAIL;
  }
  if (flags.moshi && !flags.hold) {
    deps.io.err(`error: \`${WITH_MOSHI_FLAG}\` replaces Moshi's permission entry with the broker, so it needs \`--hold-permissions\`.`);
    return EXIT.USAGE;
  }
  // The same floor the Claude hold has (cli/hooks.ts): Codex before the profile's `hold.minVersion` does not
  // run the PermissionRequest hook this install needs, so it would promise a hold that never comes. A version
  // that cannot be read installs, and the verb says so. A status-only install never asks.
  const profile = loadProfiles().get("codex");
  const floor = flags.hold ? (profile?.hold?.minVersion ?? null) : null;
  const version = floor === null || profile === undefined ? null : (deps.harnessVersion ?? (() => binaryVersion(profile)))("codex");
  if (floor !== null && version !== null && compareSemver(version, floor) < 0) {
    deps.io.err(`error: codex ${version} does not run the ${PERMISSION} hook. The hold needs ${floor} or later.`);
    deps.io.err(`  Update codex, or run the install without \`--hold-permissions\`.`);
    return EXIT.FAIL;
  }
  const hooksPath = resolved(deps, hooksJsonPath(deps.ctx));
  const recordFile = resolved(deps, recordPath(deps.ctx));
  if (deps.files.entryType(hooksPath) === "symlink") {
    deps.io.err(`error: ${hooksPath} is a symlink; a rename would replace the link. Point Collie at the real file's directory with CODEX_HOME, or install it by hand.`);
    return EXIT.FAIL;
  }
  const hooks = readHooks(deps, hooksPath);
  if (hooks === "bad") {
    deps.io.err(`error: ${hooksPath} is not valid JSON — leaving it alone.`);
    deps.io.err("  Fix it (or move it aside), then re-run; a merge into a file we cannot read would lose it.");
    return EXIT.FAIL;
  }
  const previousRecordText = deps.files.read(recordFile);
  const previous = readRecord(deps.files, recordFile);
  const plan = planInstall(hooks.value, nativeCommand(binary), { hold: flags.hold, moshi: flags.moshi }, previous);
  if (plan.kind === "refuse") {
    deps.io.err(`error: ${hooksPath} cannot be merged into — ${plan.reason}. Nothing was written.`);
    return EXIT.FAIL;
  }
  // THE GATE, before any write. A broker that cannot withdraw its loser is worse than two handlers.
  if (flags.moshi) {
    const verdict = moshiVerdict(deps.files, deps.ctx.configDir, MOSHI_ENTRY_COMMAND);
    if (!verdict.ok) {
      deps.io.err(`error: \`${WITH_MOSHI_FLAG}\` is not enabled — ${verdict.reason}.`);
      deps.io.err(`  Moshi-only routing stays as it is and nothing was written. The proof is read from ${capabilityPath(deps.ctx.configDir)}.`);
      return EXIT.FAIL;
    }
  }
  const record: NativeRecord = { hooksPath, binary, hold: flags.hold, moshi: plan.replaced };
  const targets: Target[] = [
    { path: recordFile, previous: previousRecordText, text: serializeRecord(record) },
    { path: hooksPath, previous: hooks.text, text: serializeHooks(plan.document) },
  ].filter((target) => target.text !== target.previous);
  if (targets.length === 0) {
    deps.io.out(`${hooksPath} already has them — no bytes changed.`);
    return EXIT.OK;
  }
  try {
    commit(deps, targets);
  } catch (err) {
    deps.io.err(err instanceof ChangedUnderUs ? `error: ${err.message}; nothing was written. Re-run the install.` : `error: could not write ${hooksPath} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  deps.io.out(`✓ ${hooksPath}`);
  deps.io.out(`  ${[...NATIVE_EDGE_EVENTS, ...(flags.hold ? NATIVE_HOLD_EVENTS : [])].map((row) => row.event).join(", ")} → \`${binary} ${NATIVE_VERB}\``);
  deps.io.out(`  config.toml was not read or changed; your own \`notify\` command is untouched.`);
  if (floor !== null && version === null) deps.io.out(`  Collie could not read the codex version. The hold needs ${floor} or later.`);
  deps.io.out("  Codex runs a new or changed hook only after you trust it: open Codex, run /hooks and review the Collie entries.");
  if (plan.replaced !== null) {
    deps.io.out(`  ${PERMISSION}: the broker took Moshi's slot, so Codex asks you to trust that slot again. Moshi still answers; Collie answers beside it, and whichever answers first wins.`);
    deps.io.out("  `collie hooks uninstall codex` puts Moshi's entry back exactly as it was.");
  } else if (flags.hold) {
    deps.io.out(`  ${PERMISSION} → \`${binary} ${NATIVE_VERB}\`: a permission waits for a tap on the phone, before Codex shows its own prompt.`);
    deps.io.out("  While a PermissionRequest hook waits, Codex shows nothing in its own window (openai/codex#39835); the phone is the way to answer.");
  } else {
    deps.io.out("  No permission hold. Add `--hold-permissions` to hold permissions for the phone.");
  }
  return EXIT.OK;
}

/** `collie hooks uninstall codex`, the native half: only what carries our command, and Moshi's entry back. */
export function cmdCodexNativeUninstall(deps: HooksDeps): number {
  const hooksPath = resolved(deps, hooksJsonPath(deps.ctx));
  const recordFile = resolved(deps, recordPath(deps.ctx));
  const hooks = readHooks(deps, hooksPath);
  if (hooks === "bad") {
    deps.io.err(`error: ${hooksPath} is not valid JSON — leaving it alone.`);
    return EXIT.FAIL;
  }
  const recordText = deps.files.read(recordFile);
  const record = readRecord(deps.files, recordFile);
  if (hooks.text === null || hooks.value === null) {
    if (recordText !== null) deps.files.remove(recordFile);
    return EXIT.OK;
  }
  const plan = planUninstall(hooks.value, record);
  if (plan.kind === "refuse") {
    deps.io.err(`error: ${hooksPath} cannot be edited — ${plan.reason}. Nothing was written.`);
    return EXIT.FAIL;
  }
  const targets: Target[] = [];
  const text = serializeHooks(plan.document);
  if (plan.removed > 0 && text !== hooks.text) targets.push({ path: hooksPath, previous: hooks.text, text });
  try {
    if (targets.length > 0) commit(deps, targets);
  } catch (err) {
    deps.io.err(err instanceof ChangedUnderUs ? `error: ${err.message}; nothing was written. Re-run the uninstall.` : `error: could not write ${hooksPath} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  if (plan.left === 0 && recordText !== null) deps.files.remove(recordFile);
  if (plan.removed > 0) {
    deps.io.out(`✓ ${hooksPath} — removed the native Codex hooks${plan.restored ? " and put the Moshi entry back exactly as it was" : ""}; every other hook is untouched.`);
  }
  if (plan.left > 0) {
    deps.io.err(`error: a ${PERMISSION} entry of ours is still in ${hooksPath} and ${recordFile} is missing, so it cannot be told from a broker that holds Moshi's place. Restore the record or the entry by hand.`);
    return EXIT.FAIL;
  }
  return EXIT.OK;
}

/** Lines for `collie hooks status`: what the native install carries. Reads only; empty when nothing native is there. */
export function nativeStatusLines(deps: HooksDeps, binary: string): string[] {
  const hooksPath = resolved(deps, hooksJsonPath(deps.ctx));
  const recordFile = resolved(deps, recordPath(deps.ctx));
  const hooks = readHooks(deps, hooksPath);
  const record = readRecord(deps.files, recordFile);
  if (hooks === "bad" || hooks.value === null) return record === null ? [] : [`codex native hooks: ${hooksPath} is unreadable`];
  const section = asObject(asObject(hooks.value)?.hooks) ?? {};
  const present: string[] = [];
  const stale: string[] = [];
  let duplicate: string | null = null;
  for (const [event, raw] of Object.entries(section)) {
    if (!Array.isArray(raw)) continue;
    const slots = slotsOf(raw, isOurs);
    if (slots.length === 0) continue;
    present.push(event);
    if (slots.length > 1) duplicate = event;
    for (const slot of slots) if (handlerAt(raw, slot)?.command !== nativeCommand(binary)) stale.push(event);
  }
  if (present.length === 0 && record === null) return [];
  const lines: string[] = [];
  const wanted = [...NATIVE_EDGE_EVENTS, ...(record?.hold === true ? NATIVE_HOLD_EVENTS : [])].map((row) => row.event);
  const missing = wanted.filter((event) => !present.includes(event));
  if (duplicate !== null) lines.push(`${hooksPath}: native Codex hooks: duplicate Collie entries on ${duplicate} — remove one by hand, then re-run install`);
  else if (missing.length > 0) lines.push(`${hooksPath}: native Codex hooks: partly installed (missing ${missing.join(", ")}) — re-run \`install codex --native\``);
  else if (stale.length > 0) lines.push(`${hooksPath}: native Codex hooks: installed, but ${[...new Set(stale)].join(", ")} run another binary — re-run \`install codex --native\` to re-point them`);
  else lines.push(`${hooksPath}: native Codex hooks: installed (${present.join(", ")})${record?.hold === true ? ", holds permissions" : ""}; trust them in /hooks if Codex has not`);
  if (record?.hold === true) {
    const foreign = foreignPermission(hooks.value);
    if (foreign.moshi > 0) {
      lines.push(`  warning: a Moshi \`codex-hook\` entry is registered on ${PERMISSION} beside the Collie hold (issue #595). The Collie hold stays off while it is there, and Codex asks as usual; remove that entry, or install again without \`--hold-permissions\`.`);
    } else if (foreign.other > 0) {
      lines.push(`  note: ${String(foreign.other)} other handler(s) are registered on ${PERMISSION}; Codex runs every one and any deny wins, so the hold waits for the slowest.`);
    }
  }
  if (record?.moshi != null) {
    const verdict = moshiVerdict(deps.files, deps.ctx.configDir, record.moshi.command);
    lines.push(verdict.ok
      ? `  moshi: the broker answers beside Moshi; withdrawal proven by ${verdict.capability.observer} on ${verdict.capability.observedAt}`
      : `  moshi: Moshi-only routing — ${verdict.reason}`);
  } else {
    const now = moshiNow(deps.files, MOSHI_ENTRY_COMMAND);
    if (now !== null) {
      const verdict = moshiVerdict(deps.files, deps.ctx.configDir, MOSHI_ENTRY_COMMAND);
      const why = verdict.ok ? `a proof is recorded at ${capabilityPath(deps.ctx.configDir)}` : `\`--with-moshi\` is refused: ${verdict.reason}`;
      lines.push(`  moshi: installed at ${now.executable} (sha256 ${now.digest}); no broker; ${why}`);
    }
  }
  return lines;
}
