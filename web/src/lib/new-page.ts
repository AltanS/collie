import type { StartWhat } from "@/lib/api";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "@/lib/json";
import { hostHealth, writeRefusal, type HostHealth } from "@/lib/host-health";
import { isMultiHost, leadHost } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import type { HarnessInfo, Launcher, LauncherItem, ServerSummary, WorktreeFolderChoice } from "@/lib/types";

// THE NEW PAGE'S RULES (M48 spec 01, ADR 0091, ADR 0093), apart from the route so each is tested
// without rendering it: which items are offered and which are listed as not working here, the one
// line that says what Start will do, the "Again" and Agent-or-Command memories, and when a request
// id may be reused.

/** Where the two "how to add one" links under the Agent and Command selects open: one docs section. */
export const NEW_PAGE_DOCS = {
  /** Collie's agent list is built in; the operator's way to add another is a `launchers.toml` row. */
  agent: "https://colliepwa.dev/docs/configure#your-own-launchers",
  command: "https://colliepwa.dev/docs/configure#your-own-launchers",
} as const;

/** The two halves of "what to start": an agent (one Collie knows, or an agent row) or a command (Shell or a row). */
export type Kind = "agent" | "shell";

/**
 * Which half a choice belongs to. A harness is an agent, the shell a command. A ROW is either (an
 * agent row has a harness; a command row has none), so pass the offer to tell them apart; without it
 * a row reads as a command, as it did before agent rows.
 */
export function kindOf(what: StartWhat, offer?: Offer): Kind {
  if (what.kind === "harness") return "agent";
  if (what.kind === "row" && offer?.agents.some((a) => whatKey(a.what) === whatKey(what)) === true) return "agent";
  return "shell";
}

/** One stable string per choice, for an option value and a React key. */
export function whatKey(what: StartWhat): string {
  if (what.kind === "harness") return `harness:${what.id}`;
  if (what.kind === "row") return `row:${what.command}`;
  return "shell";
}

/** The choice a {@link whatKey} names, or `null` for anything else (a missing or foreign `?pick=`). */
export function keyToWhat(key: string | null | undefined): StartWhat | null {
  if (key === undefined || key === null) return null;
  if (key === "shell") return { kind: "shell" };
  if (key.startsWith("harness:") && key.length > 8) return { kind: "harness", id: key.slice(8) };
  if (key.startsWith("row:") && key.length > 4) return { kind: "row", command: key.slice(4) };
  return null;
}

/** Which select an item key is listed in, or `null` when the offer holds no such item. */
export function kindOfKey(offer: Offer, key: string | undefined): Kind | null {
  if (key === undefined) return null;
  if (offer.agents.some((a) => a.key === key)) return "agent";
  if (offer.commands.some((c) => c.key === key)) return "shell";
  return null;
}

/** Why one item is listed on the page but cannot be used here. */
export type Unavailable =
  /** An agent the machine knows but whose binary its login PATH does not have. */
  | { kind: "notFound" }
  /** The operator turned phone-added rows off on that machine (`[phone] adds = false`). */
  | { kind: "addsOff" }
  /** The operator has not turned typed lines on (`[phone] free_text`). */
  | { kind: "freeTextOff" }
  /** A command row never starts in a worktree: the switch is off and says so. */
  | { kind: "commandRow" }
  /** The machine's Collie is older than 1.19.0 and starts no agent by id. */
  | { kind: "olderCollie" }
  /** The machine's multiplexer has no worktrees (tmux, zellij). */
  | { kind: "needsHerdr" }
  /** A crew member was chosen; worktrees are made on the lead only (ADR 0089, rule 6). */
  | { kind: "onlyOnLead"; lead: string }
  /** The machine is not taking writes: its own sentence (lib/host-health.ts). */
  | { kind: "machine"; sentence: string };

/** The reason as words: short enough to follow a name in brackets. */
export function unavailableText(reason: Unavailable): string {
  switch (reason.kind) {
    case "notFound":
      return t("newPage.reason.notFound");
    case "addsOff":
      return t("newPage.reason.addsOff");
    case "freeTextOff":
      return t("newPage.reason.freeTextOff");
    case "commandRow":
      return t("newPage.reason.commandRow");
    case "olderCollie":
      return t("newPage.reason.olderCollie");
    case "needsHerdr":
      return t("newPage.reason.needsHerdr");
    case "onlyOnLead":
      return t("newPage.reason.onlyOnLead", { lead: reason.lead });
    case "machine":
      return reason.sentence;
  }
}

/**
 * One thing the page can start: an agent Collie knows, a row (operator's or a phone's), or the
 * shell. Listed whether or not it can start here, with the reason when it cannot.
 */
export interface OfferItem {
  /** {@link whatKey} of `what`: the option value. */
  key: string;
  what: StartWhat;
  label: string;
  /** The harness whose mark draws beside it, when one reads it. */
  harness?: string;
  /** The line a row types. Also what the no-prompts confirm is kept under. */
  command?: string;
  /** A fixed folder, shown in place of the Folder field. */
  cwd?: string;
  /** The line skips permission prompts: badged, and confirmed once per device. */
  noPrompts: boolean;
  /** Whether it may start on a new worktree: agents and the shell, never a command row. */
  branch: boolean;
  unavailable: Unavailable | null;
}

/** The shell, which every machine can start. Its label is the page's own word (`newPage.shell`). */
export const SHELL_ITEM: OfferItem = { key: "shell", what: { kind: "shell" }, label: "Shell", noPrompts: false, branch: true, unavailable: null };

export interface OfferInput {
  /** The chosen machine's answer: `null` when the answer is not in yet. */
  harnesses: readonly HarnessInfo[] | null;
  /** Every agent, row and the shell with its availability (a bridge from 1.19.0), else `null`. */
  items?: readonly LauncherItem[] | null;
  /** Whether that answer is in. With `harnesses` null, an older Collie. */
  loaded: boolean;
  rows: readonly Launcher[];
  /** The chosen machine's refusal, when it takes no writes. */
  refusal?: string;
  /** Worktrees: whether the lead's multiplexer can make one. */
  canWorktree: boolean;
  /** Worktrees: the chosen machine is a crew member, and this is the lead's name. */
  memberChosen?: { lead: string };
}

/** What the page offers. Nothing is ever simply hidden: an item that cannot run is listed with its reason. */
export interface Offer {
  /** The Agent select: agents Collie knows, agent rows, and off agent rows (disabled, with a reason). */
  agents: readonly OfferItem[];
  /** The Command select: Shell first, then the rows. */
  commands: readonly OfferItem[];
  /** Whether the machine starts a plain shell by `shell: true` (else the older `/api/workspace`). */
  shellById: boolean;
  /** Why there is no agent list at all (an older Collie), said under the Agent select. */
  agentsNote: Unavailable | null;
  /** Why the worktree switch is off, or `null` when it may be used. */
  branchBlocked: Unavailable | null;
}

function reasonOf(reason: NonNullable<LauncherItem["reason"]>): Unavailable {
  switch (reason) {
    case "not_found":
      return { kind: "notFound" };
    case "adds_off":
      return { kind: "addsOff" };
    case "free_text_off":
      return { kind: "freeTextOff" };
  }
}

/** One item of `GET /api/launchers` as the page holds it. */
function fromItem(item: LauncherItem): OfferItem {
  const what: StartWhat =
    "harness" in item.start ? { kind: "harness", id: item.start.harness } : "command" in item.start ? { kind: "row", command: item.start.command } : { kind: "shell" };
  const out: OfferItem = {
    key: whatKey(what),
    what,
    label: item.label,
    noPrompts: item.noPrompts,
    branch: item.branch,
    unavailable: item.available ? null : item.reason === undefined ? { kind: "notFound" } : reasonOf(item.reason),
  };
  if (item.harness !== undefined) out.harness = item.harness;
  if (item.command !== undefined) out.command = item.command;
  if (item.cwd !== undefined) out.cwd = item.cwd;
  return out;
}

/** A command row of an older bridge, which sends no `items`. */
function fromRow(row: Launcher): OfferItem {
  const out: OfferItem = {
    key: `row:${row.command}`,
    what: { kind: "row", command: row.command },
    label: row.label,
    command: row.command,
    noPrompts: row.noPrompts === true,
    branch: false,
    unavailable: null,
  };
  if (row.cwd !== undefined) out.cwd = row.cwd;
  return out;
}

/**
 * The page's offer for one machine. An agent that is not found stays in the list, disabled. An older
 * Collie, a multiplexer with no worktrees and a member chosen for a worktree each become one reason.
 * A machine that takes no writes offers nothing, and its sentence is said beside the machine select.
 *
 * With `items` (a 1.19.0 bridge) the two lists are the bridge's, in its order. Without them the page
 * builds today's lists from `harnesses` and `launchers`.
 */
export function offerFor(input: OfferInput): Offer {
  if (input.refusal !== undefined) {
    return {
      agents: [],
      commands: [SHELL_ITEM],
      shellById: false,
      agentsNote: null,
      branchBlocked: { kind: "machine", sentence: input.refusal },
    };
  }
  const olderCollie = input.loaded && input.harnesses === null;
  let branchBlocked: Unavailable | null = null;
  if (!input.canWorktree) branchBlocked = { kind: "needsHerdr" };
  else if (input.memberChosen !== undefined) branchBlocked = { kind: "onlyOnLead", lead: input.memberChosen.lead };
  // An older Collie cannot be asked for a worktree from a folder either: the route is 1.19.0's.
  else if (olderCollie) branchBlocked = { kind: "olderCollie" };
  const listed = input.items ?? null;
  if (listed !== null) {
    const commands = listed.filter((i) => i.group === "commands").map(fromItem);
    return {
      agents: listed.filter((i) => i.group === "agents").map(fromItem),
      // The shell leads, whatever order a bridge sent it in.
      commands: [SHELL_ITEM, ...commands.filter((c) => c.what.kind !== "shell")],
      shellById: true,
      agentsNote: null,
      branchBlocked,
    };
  }
  return {
    agents: (input.harnesses ?? []).map((h) => ({
      key: `harness:${h.id}`,
      what: { kind: "harness", id: h.id },
      label: h.label,
      harness: h.id,
      noPrompts: false,
      branch: true,
      unavailable: h.found ? null : { kind: "notFound" },
    })),
    commands: [SHELL_ITEM, ...input.rows.map(fromRow)],
    shellById: input.harnesses !== null,
    agentsNote: olderCollie ? { kind: "olderCollie" } : null,
    branchBlocked,
  };
}

/** The agents that can start now. */
export function startableAgents(offer: Offer): OfferItem[] {
  return offer.agents.filter((a) => a.unavailable === null);
}

/** The listed item `what` names, if the offer holds it. */
export function itemOf(offer: Offer, what: StartWhat): OfferItem | undefined {
  const key = whatKey(what);
  return offer.agents.find((i) => i.key === key) ?? offer.commands.find((i) => i.key === key);
}

/** Whether `what` is something the offer still holds and can start (a remembered choice may not be). */
export function offered(offer: Offer, what: StartWhat): boolean {
  if (what.kind === "shell") return true;
  return itemOf(offer, what)?.unavailable === null;
}

/** One row of the Command select. */
export interface CommandOption {
  key: string;
  /** ALREADY TRANSLATED: the option's words, with "(No prompts)" and a reason in brackets. */
  text: string;
  disabled: boolean;
}

/**
 * THE COMMAND SELECT'S OPTIONS, from one function: "Just a shell" first, then the rows. Anything the
 * select gains later (a "Recent" group, a "Type a command…" option) is added here and nowhere else.
 */
export function commandOptions(offer: Offer, shellLabel: string): CommandOption[] {
  return offer.commands.map((c) => ({ key: c.key, text: optionText(c, shellLabel), disabled: c.unavailable !== null }));
}

/** The label a choice is shown and summarised with. */
export function whatLabel(what: StartWhat, offer: Offer, shellLabel: string): string {
  if (what.kind === "shell") return shellLabel;
  return itemOf(offer, what)?.label ?? (what.kind === "harness" ? what.id : what.command);
}

/** The words of one option: its label, then "(No prompts)", then the reason it cannot start, each in brackets. */
export function optionText(item: OfferItem, shellLabel: string): string {
  let text = item.what.kind === "shell" ? shellLabel : item.label;
  if (item.noPrompts) text += ` (${t("newPage.noPrompts")})`;
  if (item.unavailable !== null) text += ` (${unavailableText(item.unavailable)})`;
  return text;
}

/**
 * Whether `what` may start on a new worktree: an agent, an agent row or the shell. A command row
 * may not. Nothing chosen may not.
 */
export function branchAllowed(offer: Offer, what: StartWhat | null): boolean {
  if (what === null) return false;
  if (what.kind === "shell") return true;
  return itemOf(offer, what)?.branch ?? what.kind === "harness";
}

/**
 * Which half the page opens on: the one remembered for this machine, else the half Again's last start
 * was in, else Agent while the machine has an agent that starts (or its answer is not in yet), else
 * Command.
 */
export function defaultKind(offer: Offer, loaded: boolean, remembered: Kind | null, again: LastStart | null): Kind {
  if (remembered !== null) return remembered;
  if (again !== null) return kindOf(again.what, offer);
  return loaded && startableAgents(offer).length === 0 ? "shell" : "agent";
}

/** The agent the Agent select shows: the pick (an option key), else Again's, else the first that starts. `null` when none does. */
export function agentChoice(offer: Offer, pick: string | null, again: LastStart | null): OfferItem | null {
  const startable = startableAgents(offer);
  const has = (key: string | null): OfferItem | undefined => (key === null ? undefined : startable.find((a) => a.key === key));
  return has(pick) ?? (again === null ? undefined : has(whatKey(again.what))) ?? startable[0] ?? null;
}

/** The command the Command select shows: the pick, else Again's, else Shell. */
export function commandChoice(offer: Offer, pick: StartWhat | null, again: LastStart | null): StartWhat {
  const inCommands = (what: StartWhat): boolean => offer.commands.some((c) => c.key === whatKey(what) && c.unavailable === null);
  if (pick !== null && inCommands(pick)) return pick;
  if (again !== null && inCommands(again.what)) return again.what;
  return { kind: "shell" };
}

/** What Start would start: the Agent select's agent or the Command select's command. */
export function whatFor(kind: Kind, agent: OfferItem | null, command: StartWhat): StartWhat | null {
  if (kind === "shell") return command;
  return agent === null ? null : agent.what;
}

// ── The summary line ────────────────────────────────────────────────────────────────────────────

/** The parts of the one line above Start. The caller says it with `t()`. */
export interface SummaryParts {
  what: string;
  folder: string;
  /** The machine's name, only when there is a crew to tell machines apart in. */
  machine?: string;
  /** The new branch and where it starts, when the switch is on. */
  branch?: { name: string; base: string };
}

/** Which of the four summary sentences `parts` needs. */
export function summaryKey(parts: SummaryParts): "plain" | "machine" | "branch" | "branchMachine" {
  if (parts.branch === undefined) return parts.machine === undefined ? "plain" : "machine";
  return parts.machine === undefined ? "branch" : "branchMachine";
}

/**
 * The folder as the bridge will use it, for the summary line. Empty is home. `~` and `~/x` and an
 * absolute path are themselves; a name with no leading `/` or `~` is a folder under home, as `cd
 * projects` is in a fresh shell (bridge `askedFolder`, one rule for every client). `home` is the
 * machine's own home, `""` before its answer is in: then `~` stands for it. Never rewritten
 * silently: this is what the person reads before Start.
 */
export function folderShown(typed: string, home: string): string {
  const text = typed.trim();
  if (text === "") return home || "~";
  if (text.startsWith("~") || text.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(text)) return text;
  return `~/${text.replace(/^(\.\/)+/u, "")}`;
}

// ── Again ───────────────────────────────────────────────────────────────────────────────────────
//
// The last start, per machine, on THIS device (localStorage): the page's first row repeats it. A
// branch start is not repeated blindly, since its name was used; tapping it fills the form with a
// fresh name instead. At most {@link MAX_AGAIN} machines are kept, the oldest dropped.

// The key keeps the name it had when this was a sheet: renaming it would drop what people stored.
export const AGAIN_KEY = "collie:new-sheet:again:v1";
export const MAX_AGAIN = 20;

/** One remembered start. */
export interface LastStart {
  what: StartWhat;
  /** What the page called it, so a row whose label moved still reads as it did. */
  label: string;
  /** The folder it ran in, as sent; `null` for home or a row's pinned folder. */
  cwd: string | null;
  /** Whether it started on a new branch, and in which folder kind. */
  branch: { folder: WorktreeFolderChoice } | null;
  at: number;
}

/** The stored file: one last start per machine key. */
interface AgainFile {
  [machine: string]: LastStart;
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function parseWhat(raw: JsonValue | undefined): StartWhat | null {
  const o = asJsonObject(raw);
  const kind = asJsonString(o?.kind);
  if (kind === "shell") return { kind: "shell" };
  const id = asJsonString(o?.id);
  if (kind === "harness" && id !== undefined && id !== "") return { kind: "harness", id };
  const command = asJsonString(o?.command);
  if (kind === "row" && command !== undefined && command !== "") return { kind: "row", command };
  return null;
}

function parseFolder(raw: JsonValue | undefined): WorktreeFolderChoice | null {
  const o = asJsonObject(raw);
  const kind = asJsonString(o?.kind);
  if (kind === "default") return { kind: "default" };
  const parent = asJsonString(o?.parent);
  if (kind === "parent" && parent !== undefined && parent !== "") return { kind: "parent", parent };
  return null;
}

function parseStart(raw: JsonValue | undefined): LastStart | null {
  const o = asJsonObject(raw);
  if (o === undefined) return null;
  const what = parseWhat(o.what);
  const label = asJsonString(o.label);
  const at = asJsonNumber(o.at);
  if (what === null || label === undefined || at === undefined) return null;
  const cwd = o.cwd === null ? null : asJsonString(o.cwd);
  if (cwd === undefined) return null;
  let branch: LastStart["branch"] = null;
  if (o.branch !== null && o.branch !== undefined) {
    const folder = parseFolder(asJsonObject(o.branch)?.folder);
    if (folder === null) return null;
    branch = { folder };
  }
  return { what, label, cwd, branch, at };
}

function readFile(storage: Pick<Storage, "getItem"> | undefined): AgainFile {
  let text: string | null = null;
  try {
    text = storage?.getItem(AGAIN_KEY) ?? null;
  } catch {
    return {};
  }
  const parsed = text === null ? undefined : parseJsonObject(text);
  const out: AgainFile = {};
  if (parsed === undefined) return out;
  for (const [machine, entry] of Object.entries(parsed)) {
    const start = parseStart(entry);
    if (start !== null) out[machine] = start;
  }
  return out;
}

/** The last start on `machine` (`""` is the lead or a solo install), or `null`. */
export function readAgain(machine: string, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): LastStart | null {
  return readFile(storage)[machine] ?? null;
}

/** Remember a start that worked. A storage that refuses keeps no memory. */
export function rememberAgain(
  machine: string,
  start: LastStart,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
): void {
  const file = readFile(storage);
  file[machine] = start;
  const kept = Object.entries(file)
    .toSorted(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_AGAIN);
  try {
    storage?.setItem(AGAIN_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Private mode or a full quota: the next visit opens without an Again row.
  }
}

/**
 * Forget every machine's last start. The wipe at the end of a pairing runs it (lib/wipe.ts): the
 * entry names folders on the machines of that pairing, so it goes with the pairing.
 */
export function forgetAgain(storage: Pick<Storage, "removeItem"> | undefined = safeStorage()): void {
  try {
    storage?.removeItem(AGAIN_KEY);
  } catch {
    // Locked-down storage: there was nothing it could have kept.
  }
}

// ── Agent or Command ────────────────────────────────────────────────────────────────────────────
//
// Which half of "what to start" the page opens on, per machine, on THIS device. It is written the
// moment the segment is tapped (not only after a start), so a person who looks for a command, leaves
// and comes back finds the half they were in. No folder or name in it, only the word, so a wipe at the
// end of a pairing leaves it (it is a preference, as the hidden-machines list is).

export const KIND_KEY = "collie:new-page:kind:v1";

/** The remembered half on `machine` (`""` is the lead or a solo install), or `null`. */
export function readKind(machine: string, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): Kind | null {
  let text: string | null = null;
  try {
    text = storage?.getItem(KIND_KEY) ?? null;
  } catch {
    return null;
  }
  const value = asJsonString((text === null ? undefined : parseJsonObject(text))?.[machine]);
  return storedKind(value);
}

/**
 * A stored half as a {@link Kind}. The second half was called "command" before it was "Shell" (its
 * select is still labelled Command), and the file keeps its key, so the old word reads as `shell`
 * and nobody loses their choice.
 */
function storedKind(value: string | undefined): Kind | null {
  if (value === "agent") return "agent";
  if (value === "shell" || value === "command") return "shell";
  return null;
}

/** Remember the half chosen on `machine`. At most {@link MAX_AGAIN} machines are kept, the oldest dropped. */
export function rememberKind(
  machine: string,
  kind: Kind,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = safeStorage(),
): void {
  let text: string | null = null;
  try {
    text = storage?.getItem(KIND_KEY) ?? null;
  } catch {
    return;
  }
  const kept = new Map<string, Kind>();
  for (const [key, value] of Object.entries((text === null ? undefined : parseJsonObject(text)) ?? {})) {
    const other = storedKind(asJsonString(value));
    if (key !== machine && other !== null) kept.set(key, other);
  }
  // Re-added last, so the oldest entries are the ones a full file drops.
  kept.set(machine, kind);
  try {
    storage?.setItem(KIND_KEY, JSON.stringify(Object.fromEntries([...kept].slice(-MAX_AGAIN))));
  } catch {
    // Private mode or a full quota: the page opens on its default half.
  }
}

// ── Request ids ─────────────────────────────────────────────────────────────────────────────────

/**
 * The fingerprint of one Start, to decide whether a retry may keep its request id. The bridge
 * replays a known id with the FIRST request's answer, so the id must name one request: the same
 * fingerprint keeps the id (a lost reply lands on its receipt), any other mints a new one.
 */
export function startFingerprint(parts: {
  machine: string;
  what: StartWhat;
  cwd: string;
  branch: { name: string; base: string; folder: WorktreeFolderChoice } | null;
}): string {
  return JSON.stringify([parts.machine, whatKey(parts.what), parts.cwd, parts.branch]);
}

// ── Which machine ───────────────────────────────────────────────────────────────────────────────

/**
 * A member's tier-2 health, with the fallback `server-switcher.tsx` uses: outside a `CrewProvider`
 * there is no derived map, so re-derive with no clock, which hands back the lead's plain boolean.
 */
export function memberHealth(health: ReadonlyMap<string, HostHealth>, s: ServerSummary): HostHealth {
  return health.get(s.id) ?? hostHealth(s, { at: 0, pollMs: 0 });
}

/**
 * Why a machine takes no writes, in one word for a list ("unreachable", "incompatible"), or
 * `undefined` when it takes them. The full sentence is {@link writeRefusal}'s, said beside the select.
 */
export function machineWord(h: HostHealth): string | undefined {
  if (writeRefusal(h) === undefined) return undefined;
  return h.incompatible ? t("connection.host.incompatible") : t("connection.host.unreachablePlain");
}

/**
 * Which machine the page opens on: the one the view shows (absent `?h=` is the lead), moved to the
 * first machine taking writes when that one is not. When none is, it stays put, so the page names
 * the machine and its refusal instead of a live-looking form. `undefined` on a solo install.
 */
export function defaultHost(
  servers: readonly ServerSummary[],
  health: ReadonlyMap<string, HostHealth>,
  want: string | undefined,
): string | undefined {
  if (!isMultiHost(servers)) return undefined;
  const wanted = want ?? leadHost(servers);
  const writable = (id: string | undefined): boolean =>
    servers.some((s) => s.id === id && writeRefusal(memberHealth(health, s)) === undefined);
  if (writable(wanted)) return wanted;
  const firstWritable = servers.find((s) => writeRefusal(memberHealth(health, s)) === undefined);
  return firstWritable?.id ?? wanted ?? servers[0]?.id;
}
