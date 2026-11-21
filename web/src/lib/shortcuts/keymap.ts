// Build the keymap from the action table and the operator's `shortcuts.toml` (M108).
//
// The merge is Herdr's (src/config/keybinds.rs, `validated_keybinds`):
//   * A value in the file replaces that action's defaults whole. `""` or `[]` unbinds it.
//   * The operator's bindings register first, then the defaults of the actions the file left alone.
//   * A default that meets an operator binding is dropped silently. Two operator bindings on one key
//     keep the first and report the second. A bad binding is dropped with a diagnostic and the rest
//     of the file still loads. A bad prefix falls back to `ctrl+b`.
//
// Two refusals are Collie's own, for a page that is not a terminal. A direct binding must carry
// Ctrl, Alt or Meta (or be an F key), because anything else would take a key out of the composer
// or a form. And the chords the browser keeps (`ctrl+w`, `ctrl+t`, ...) cannot be direct bindings:
// the page never sees them in time, or should not take them.

import { DEFAULT_PREFIX, MODES, type ActionDef, type ActionId, type ModeDef, type ModeId } from "./actions";
import { chordId, isFunctionKey } from "./chord";
import { HERDR_NAMES, herdrNameMessage } from "./herdr-names";
import { parseBinding } from "./parse";
import type { Binding, Chord, Diagnostic, DiagnosticCode, Hit, Keymap, ModeKeymap, UserShortcuts } from "./types";

export interface BuildInput<Id extends string = ActionId> {
  /** The action table. Production passes `ACTIONS`. */
  readonly defaults: readonly ActionDef<Id>[];
  readonly user?: UserShortcuts;
  /** `mod` means Cmd and the key caps read Cmd and Option. Default false. */
  readonly mac?: boolean;
}

/** Chords the browser owns (close, new, reopen, tab switch, address bar), with a Mac's Cmd twins. */
const BROWSER_RESERVED: ReadonlySet<string> = new Set([
  "ctrl+w",
  "ctrl+t",
  "ctrl+n",
  "ctrl+tab",
  "ctrl+shift+tab",
  "ctrl+shift+n",
  "ctrl+shift+t",
  "ctrl+shift+w",
  "ctrl+l",
  "meta+w",
  "meta+t",
  "meta+n",
  "shift+meta+n",
  "shift+meta+t",
  "shift+meta+w",
  "meta+l",
]);

type Source = "user" | "default";

/** One key in one namespace: who holds it. `hit` is null for a key the keymap keeps for itself. */
interface Slot<Id extends string> {
  readonly field: string;
  readonly source: Source;
  readonly hit: Hit<Id> | null;
}

type Registry<Id extends string> = Map<string, Slot<Id>>;

interface Context<Id extends string> {
  readonly mac: boolean;
  readonly diagnostics: Diagnostic[];
  readonly direct: Registry<Id>;
  readonly prefixed: Registry<Id>;
  readonly modes: ReadonlyMap<ModeId, Registry<Id>>;
}

interface Problem {
  readonly code: DiagnosticCode;
  readonly message: string;
}

function report(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
  diagnostics.push(diagnostic);
}

/** Why a chord cannot be pressed on its own in the normal mode, or null when it can. */
function directProblem(input: { chord: Chord; raw: string }): Problem | null {
  const { chord, raw } = input;
  if (BROWSER_RESERVED.has(chordId(chord))) {
    return { code: "browser-reserved", message: `${raw} belongs to the browser and cannot be a direct binding` };
  }
  if (chord.ctrl || chord.alt || chord.meta || isFunctionKey(chord.key)) return null;
  return {
    code: "unsafe-direct",
    message: `${raw} would intercept typing; use "prefix+${raw}" to require the prefix`,
  };
}

function parseOrThrow(text: string, mac: boolean): Chord {
  const parsed = parseBinding(text, { mac });
  const [only] = parsed.ok ? parsed.bindings : [];
  if (!parsed.ok || parsed.bindings.length !== 1 || only === undefined) throw new Error(`shortcuts: the built-in key "${text}" does not parse`);
  return only.chord;
}

interface PrefixSetting {
  readonly chords: Chord[];
  /** `user` when the file named a prefix, even a bad one that fell back. */
  readonly source: Source;
}

function resolvePrefix(input: { user: UserShortcuts; mac: boolean; diagnostics: Diagnostic[] }): PrefixSetting {
  const { user, mac, diagnostics } = input;
  if (!Object.hasOwn(user, "prefix")) return { chords: [parseOrThrow(DEFAULT_PREFIX, mac)], source: "default" };

  const entries = user.prefix ?? [];
  const chords: Chord[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = entry.trim();
    const problem = prefixProblem({ raw, mac });
    if (problem !== null) {
      report(diagnostics, { action: "prefix", binding: raw, ...problem });
      continue;
    }
    const chord = parseOrThrow(raw, mac);
    if (seen.has(chordId(chord))) continue;
    seen.add(chordId(chord));
    chords.push(chord);
  }
  if (chords.length > 0) return { chords, source: "user" };

  report(diagnostics, {
    action: "prefix",
    binding: entries.join(", "),
    code: "invalid-prefix",
    message: `no valid prefix; using ${DEFAULT_PREFIX}`,
  });
  return { chords: [parseOrThrow(DEFAULT_PREFIX, mac)], source: "user" };
}

function prefixProblem(input: { raw: string; mac: boolean }): Problem | null {
  const { raw, mac } = input;
  const parsed = parseBinding(raw, { mac });
  if (!parsed.ok) return { code: parsed.error.code, message: `invalid prefix: ${parsed.error.message}` };
  const [binding] = parsed.bindings;
  if (binding === undefined) return { code: "invalid-binding", message: "the prefix holds no key" };
  if (binding.prefix) return { code: "invalid-binding", message: "the prefix cannot start with prefix+" };
  return directProblem({ chord: binding.chord, raw });
}

function hitFor<Id extends string>(def: ActionDef<Id>, binding: Binding): Hit<Id> {
  return { action: def.id, index: binding.index, opensMode: def.opensMode, leavesMode: def.leavesMode };
}

/** Put a binding in a namespace, or say why it did not fit. */
function claim<Id extends string>(
  ctx: Context<Id>,
  input: { registry: Registry<Id>; def: ActionDef<Id>; binding: Binding; raw: string; source: Source; placed: Binding[] },
): void {
  const { registry, def, binding, raw, source, placed } = input;
  const id = chordId(binding.chord);
  const held = registry.get(id);
  if (held === undefined) {
    registry.set(id, { field: def.id, source, hit: hitFor(def, binding) });
    placed.push(binding);
    return;
  }
  // A default gives way to the operator's choice without a word. So does a repeat in one action.
  if (source === "default" && held.source === "user") return;
  if (held.hit !== null && held.field === def.id) return;

  const isReserved = held.hit === null;
  report(ctx.diagnostics, {
    action: def.id,
    binding: raw,
    code: isReserved ? "reserved" : "collision",
    message: isReserved
      ? `${raw} is the ${held.field} key and stays so; disabled ${def.id}`
      : `${raw}: kept ${held.field}, disabled ${def.id}`,
  });
}

function modeRegistry<Id extends string>(ctx: Context<Id>, def: ActionDef<Id>, scope: ModeId): Registry<Id> {
  const registry = ctx.modes.get(scope);
  if (registry === undefined) throw new Error(`shortcuts: action ${def.id} names the mode ${scope}, which MODES lacks`);
  return registry;
}

function place<Id extends string>(
  ctx: Context<Id>,
  input: { def: ActionDef<Id>; binding: Binding; raw: string; source: Source; placed: Binding[] },
): void {
  const { def, binding, raw } = input;
  if (def.scope !== undefined) {
    if (binding.prefix) {
      report(ctx.diagnostics, { action: def.id, binding: raw, code: "prefix-in-mode", message: `${raw}: a key inside a mode is pressed on its own, without prefix+` });
      return;
    }
    claim(ctx, { ...input, registry: modeRegistry(ctx, def, def.scope) });
    return;
  }
  if (binding.prefix) {
    claim(ctx, { ...input, registry: ctx.prefixed });
    return;
  }
  const problem = directProblem({ chord: binding.chord, raw });
  if (problem !== null) {
    report(ctx.diagnostics, { action: def.id, binding: raw, ...problem });
    return;
  }
  claim(ctx, { ...input, registry: ctx.direct });
}

/** Register one action's binding texts. Returns the bindings that took a key. */
function registerAction<Id extends string>(
  ctx: Context<Id>,
  input: { def: ActionDef<Id>; texts: readonly string[]; source: Source },
): Binding[] {
  const { def, texts, source } = input;
  const placed: Binding[] = [];
  for (const text of texts) {
    const raw = text.trim();
    if (raw === "") continue;
    const parsed = parseBinding(raw, { mac: ctx.mac, indexed: def.indexed === true });
    if (!parsed.ok) {
      report(ctx.diagnostics, { action: def.id, binding: raw, code: parsed.error.code, message: `${raw}: ${parsed.error.message}` });
      continue;
    }
    for (const binding of parsed.bindings) place(ctx, { def, binding, raw, source, placed });
  }
  return placed;
}

function reserveKeys<Id extends string>(registry: Registry<Id>, input: { ids: readonly string[]; field: string; source: Source }): void {
  for (const id of input.ids) registry.set(id, { field: input.field, source: input.source, hit: null });
}

function exitIds(mode: ModeDef, mac: boolean): string[] {
  return ["esc", ...mode.exits.map((text) => chordId(parseOrThrow(text, mac)))];
}

function hitsOf<Id extends string>(registry: Registry<Id>): Map<string, Hit<Id>> {
  const hits = new Map<string, Hit<Id>>();
  for (const [id, slot] of registry) if (slot.hit !== null) hits.set(id, slot.hit);
  return hits;
}

function reportUnknownActions(input: { user: UserShortcuts; known: ReadonlySet<string>; diagnostics: Diagnostic[] }): void {
  for (const name of Object.keys(input.user)) {
    if (name === "prefix" || input.known.has(name)) continue;
    const binding = (input.user[name] ?? []).join(", ");
    if (HERDR_NAMES.has(name)) {
      report(input.diagnostics, { action: name, binding, code: "herdr-name", message: herdrNameMessage({ name, collie: HERDR_NAMES.get(name) ?? null }) });
      continue;
    }
    report(input.diagnostics, { action: name, binding, code: "unknown-action", message: `${name} is not an action` });
  }
}

export function buildKeymap<Id extends string = ActionId>(input: BuildInput<Id>): Keymap<Id> {
  const mac = input.mac ?? false;
  const user = input.user ?? {};
  const diagnostics: Diagnostic[] = [];
  reportUnknownActions({ user, known: new Set(input.defaults.map((def) => def.id)), diagnostics });

  const prefix = resolvePrefix({ user, mac, diagnostics });
  const prefixIds = prefix.chords.map(chordId);
  const modeEntries: { mode: ModeDef; registry: Registry<Id> }[] = [];
  for (const mode of MODES) modeEntries.push({ mode, registry: new Map() });
  const ctx: Context<Id> = {
    mac,
    diagnostics,
    direct: new Map(),
    prefixed: new Map(),
    modes: new Map(modeEntries.map((entry): [ModeId, Registry<Id>] => [entry.mode.id, entry.registry])),
  };

  reserveKeys(ctx.direct, { ids: prefixIds, field: "prefix", source: prefix.source });
  reserveKeys(ctx.prefixed, { ids: prefixIds, field: "prefix", source: prefix.source });
  reserveKeys(ctx.prefixed, { ids: ["esc"], field: "esc", source: "default" });
  for (const { mode, registry } of modeEntries) {
    reserveKeys(registry, { ids: prefixIds, field: "prefix", source: prefix.source });
    reserveKeys(registry, { ids: exitIds(mode, mac), field: "exit", source: "default" });
  }

  // The file's actions first, then the defaults of the rest: that order is what makes the file win.
  const bindings = new Map<Id, Binding[]>();
  for (const source of ["user", "default"] as const) {
    for (const def of input.defaults) {
      const isUser = Object.hasOwn(user, def.id);
      if (isUser !== (source === "user")) continue;
      const texts = isUser ? (user[def.id] ?? []) : def.defaults;
      bindings.set(def.id, registerAction(ctx, { def, texts, source }));
    }
  }

  return {
    prefix: prefix.chords,
    direct: hitsOf(ctx.direct),
    prefixed: hitsOf(ctx.prefixed),
    modes: new Map(
      modeEntries.map(({ mode, registry }): [ModeId, ModeKeymap<Id>] => [
        mode.id,
        { keys: hitsOf(registry), exits: new Set(exitIds(mode, mac)) },
      ]),
    ),
    bindings: new Map(input.defaults.map((def): [Id, readonly Binding[]] => [def.id, bindings.get(def.id) ?? []])),
    diagnostics,
    mac,
  };
}
