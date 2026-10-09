import type { StartWhat } from "@/lib/api";
import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "@/lib/json";
import { hostHealth, writeRefusal, type HostHealth } from "@/lib/host-health";
import { isMultiHost, leadHost } from "@/lib/hosts";
import type { HarnessInfo, Launcher, ServerSummary, WorktreeFolderChoice } from "@/lib/types";

// THE NEW SHEET'S RULES (M48 spec 01, ADR 0091, ADR 0093), apart from the component so each is tested
// without rendering it: which items are offered and which are listed as not working here, the one
// line that says what Start will do, the "Again" memory, and when a request id may be reused.

/** Whether a choice may start on a new branch: an agent or a shell. A `launchers.toml` row may not. */
export function branchAllowed(what: StartWhat | null): boolean {
  return what !== null && what.kind !== "row";
}

/** One stable string per choice, for a radio value and a React key. */
export function whatKey(what: StartWhat): string {
  if (what.kind === "harness") return `harness:${what.id}`;
  if (what.kind === "row") return `row:${what.command}`;
  return "shell";
}

/** Whether two choices are the same one. */
export function sameWhat(a: StartWhat | null, b: StartWhat | null): boolean {
  return a !== null && b !== null && whatKey(a) === whatKey(b);
}

/** Why one item is listed in the sheet's top block instead of being offered. */
export type OffReason =
  /** An agent the machine knows but whose binary its login PATH does not have. */
  | { kind: "notFound" }
  /** The machine's Collie is older than 1.19.0 and starts no agent by id. */
  | { kind: "olderCollie" }
  /** The machine's multiplexer has no worktrees (tmux, zellij). */
  | { kind: "needsHerdr" }
  /** A crew member was chosen; branches are made on the lead only (ADR 0089, rule 6). */
  | { kind: "onlyOnLead"; lead: string }
  /** The machine is not taking writes: its own sentence (lib/host-health.ts). */
  | { kind: "machine"; sentence: string };

/** One line of the top block: what, and why not. */
export interface OffItem {
  key: string;
  /** What cannot run: an agent's label, `null` for "Agents" or "On a new branch" (the caller names those). */
  label: string | null;
  /** Which of the two group names the caller uses when `label` is null. */
  group: "agents" | "branch" | "machine";
  reason: OffReason;
}

export interface OfferInput {
  /** The chosen machine's answer: `null` when the answer is not in yet. */
  harnesses: readonly HarnessInfo[] | null;
  /** Whether that answer is in. With `harnesses` null, an older Collie. */
  loaded: boolean;
  rows: readonly Launcher[];
  /** The chosen machine's refusal, when it takes no writes. */
  refusal?: string;
  /** Branches: whether the lead's multiplexer can make a worktree. */
  canWorktree: boolean;
  /** Branches: the chosen machine is a crew member, and this is the lead's name. */
  memberChosen?: { lead: string };
}

/** What the sheet offers, and the top block of what it does not. Nothing is ever simply hidden. */
export interface Offer {
  agents: readonly HarnessInfo[];
  rows: readonly Launcher[];
  /** Whether the machine starts a plain shell by `shell: true` (else the older `/api/workspace`). */
  shellById: boolean;
  /** Whether the branch switch may be drawn on. */
  branch: boolean;
  off: OffItem[];
}

/**
 * The sheet's offer for one machine. An agent that is not found, an older Collie, a multiplexer with
 * no worktrees and a member chosen for a branch each become one line of the top block, with its
 * reason. A machine that takes no writes is the first line, and then nothing is offered at all.
 */
export function offerFor(input: OfferInput): Offer {
  const off: OffItem[] = [];
  if (input.refusal !== undefined) {
    off.push({ key: "machine", label: null, group: "machine", reason: { kind: "machine", sentence: input.refusal } });
    return { agents: [], rows: [], shellById: false, branch: false, off };
  }
  const harnesses = input.harnesses ?? [];
  if (input.loaded && input.harnesses === null) {
    off.push({ key: "agents", label: null, group: "agents", reason: { kind: "olderCollie" } });
  }
  for (const h of harnesses) {
    if (!h.found) off.push({ key: `harness:${h.id}`, label: h.label, group: "agents", reason: { kind: "notFound" } });
  }
  let branch = input.canWorktree && input.memberChosen === undefined;
  if (!input.canWorktree) {
    off.push({ key: "branch", label: null, group: "branch", reason: { kind: "needsHerdr" } });
  } else if (input.memberChosen !== undefined) {
    off.push({ key: "branch", label: null, group: "branch", reason: { kind: "onlyOnLead", lead: input.memberChosen.lead } });
  }
  // An older Collie cannot be asked for a branch from a folder either: the route is 1.19.0's.
  if (input.loaded && input.harnesses === null) branch = false;
  return {
    agents: harnesses.filter((h) => h.found),
    rows: input.rows,
    shellById: input.harnesses !== null,
    branch,
    off,
  };
}

/** Whether `what` is something the offer still holds (a remembered choice may not be). */
export function offered(offer: Offer, what: StartWhat): boolean {
  if (what.kind === "shell") return true;
  if (what.kind === "harness") return offer.agents.some((h) => h.id === what.id);
  return offer.rows.some((r) => r.command === what.command);
}

/** The label a choice is shown and summarised with. */
export function whatLabel(what: StartWhat, offer: Offer, shellLabel: string): string {
  if (what.kind === "shell") return shellLabel;
  if (what.kind === "harness") return offer.agents.find((h) => h.id === what.id)?.label ?? what.id;
  return offer.rows.find((r) => r.command === what.command)?.label ?? what.command;
}

/** The first choice the sheet opens on, when nothing was remembered: the first agent found, else the shell. */
export function firstWhat(offer: Offer): StartWhat {
  const agent = offer.agents[0];
  return agent === undefined ? { kind: "shell" } : { kind: "harness", id: agent.id };
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

// ── Again ───────────────────────────────────────────────────────────────────────────────────────
//
// The last start, per machine, on THIS device (localStorage): the sheet's first row repeats it. A
// branch start is not repeated blindly, since its name was used; tapping it fills the form with a
// fresh name instead. At most {@link MAX_AGAIN} machines are kept, the oldest dropped.

export const AGAIN_KEY = "collie:new-sheet:again:v1";
export const MAX_AGAIN = 20;

/** One remembered start. */
export interface LastStart {
  what: StartWhat;
  /** What the sheet called it, so a row whose label moved still reads as it did. */
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
    // Private mode or a full quota: the next sheet opens without an Again row.
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
 * Which machine the sheet opens on: the one the view shows (absent `?h=` is the lead), moved to the
 * first machine taking writes when that one is not. When none is, it stays put, so the sheet names
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
