// A walky talky session, named for the person on the phone (M80 spec 12).
//
// The wire, the log, `who` and the CLI keep the address (`<memberId>/<paneId>[#token]`) and the message
// id: agents need them. A person reading a message on the phone needs the session's NAME, so this module
// turns an address into the name of the live pane that holds it, and finds addresses inside a body.
//
// ── THE NAME RULE: `paneName` WITHOUT THE TERMINAL TITLE ──────────────────────
// `walkyPaneName` follows `paneName` (lib/pane-name.ts) tier for tier and skips the terminal title, because a
// Claude pane's title comes from its first prompt, which for a walky receiver is the walky header itself
// ("Message from Walky-talky message from collie-04rj6a"). The title keeps naming the work on every other screen.
//
// ── A NAME IS A CLAIM UNTIL A LIVE PANE HOLDS IT ──────────────────────────────
// A body is text an agent wrote, so an address in it is a claim. It becomes a name only where a live pane
// of the phone's own pane list carries that member and pane id. Unresolved text stays text. An address
// that carries an instance token must match the live pane's instance: a pane id is handed to another
// session when its pane closes, so a token that no live pane carries names a session that is gone. Only
// an address written WITH its token, and matched to that instance, is `pinned`: it names that session
// for certain, and only a pinned address earns a button. Any other match (a full address without its
// token, a bare pane id) names whatever holds the id now, so the screen keeps the agent's text and adds
// the name beside it. Two live panes that share a name get their pane id in brackets. A bare pane id
// (`w54:p1J`, no machine in front) resolves only when exactly ONE live pane carries it, because a pane id
// is unique within one machine and one session only. A bare window id (`w0`) is never resolved: it names
// no pane. A pane id that two live panes share on one machine (a widened list across sessions) does not
// resolve either, since a name for the wrong terminal is worse than the address.
//
// Pure and React-free: the card, the sheets and the tests all call these functions.
import { paneGitHead } from "./git-head";
import { soleTabName } from "./pane-name";
import type { AgentView } from "./types";
import { SOLO_MEMBER, type WalkyRow } from "./walky";

/** The phone's live panes, and the lead's member id (the member of a pane the snapshot did not tag). */
export interface WalkyLivePanes {
  readonly panes: readonly AgentView[];
  readonly lead: string | undefined;
}

/**
 * The name a walky surface gives a live pane, in the order of `paneName` minus the terminal title:
 * the operator's pane label, Claude's own session name, the name of a one-pane tab the operator named,
 * `<folder>#<branch>` when the pane's folder is on a branch, the folder's name, and last the agent word
 * ("shell" for a shell). The folder is the last part of the pane's cwd; a detached head names no branch.
 */
export function walkyPaneName(pane: AgentView): string {
  if (pane.paneLabel) return pane.paneLabel;
  if (pane.sessionName) return pane.sessionName;
  const tab = soleTabName(pane);
  if (tab !== null) return tab;
  const folder = pane.cwd.split(/[\\/]/u).findLast((part) => part.length > 0) ?? "";
  if (folder !== "") {
    const head = paneGitHead(pane);
    return head?.kind === "branch" ? `${folder}#${head.name}` : folder;
  }
  return pane.kind === "shell" ? "shell" : pane.agent;
}

/** No live pane known: every name falls back to the log's label. */
export const NO_LIVE_PANES: WalkyLivePanes = { panes: [], lead: undefined };

/** The member id of the machine a pane lives on, as an address spells it (`paneAddress` in lib/walky.ts). */
export function paneMemberOf(pane: Pick<AgentView, "host">, lead: string | undefined): string {
  return pane.host ?? lead ?? SOLO_MEMBER;
}

/** The part of an address before its first `/`, or null when it has none (`all`, a folder name). */
function memberOfAddress(address: string): string | null {
  const slash = address.indexOf("/");
  return slash > 0 ? address.slice(0, slash) : null;
}

/** An address without its `#<token>`. */
function withoutToken(address: string): string {
  const at = address.indexOf("#");
  return at === -1 ? address : address.slice(0, at);
}

/**
 * The machine to name beside a session: the address's member id when it is not the member of the pane at
 * address `self`, else null. Same rule as `remoteMachineOf` (lib/walky.ts), read off an address alone.
 */
function remoteMember(member: string | null, self: string | undefined): string | null {
  if (member === null || member === "" || self === undefined) return null;
  const slash = self.indexOf("/");
  if (slash <= 0) return null;
  return member === self.slice(0, slash) ? null : member;
}

// ── THE LIVE PANES, INDEXED ONCE ──────────────────────────────────────────────
// A body can hold many words and a card many bodies, so the panes are indexed by pane id ONCE per list
// (a WeakMap keyed by the list, which the pane screen and the Crew page memoise) and every lookup after
// that is a map read. The index also settles the display names: two live panes that share one name
// would read as one session, so each gets its short pane id in square brackets after the name.
interface LiveIndex {
  readonly byId: ReadonlyMap<string, readonly AgentView[]>;
  readonly display: ReadonlyMap<AgentView, string>;
  readonly lead: string | undefined;
}

const INDEXES = new WeakMap<WalkyLivePanes, LiveIndex>();

function indexOfLive(live: WalkyLivePanes): LiveIndex {
  const known = INDEXES.get(live);
  if (known !== undefined) return known;
  const byId = new Map<string, AgentView[]>();
  const byName = new Map<string, AgentView[]>();
  for (const pane of live.panes) {
    byId.set(pane.paneId, [...(byId.get(pane.paneId) ?? []), pane]);
    const name = walkyPaneName(pane);
    byName.set(name, [...(byName.get(name) ?? []), pane]);
  }
  const display = new Map<AgentView, string>();
  for (const [name, twins] of byName) {
    for (const pane of twins) {
      if (twins.length === 1) {
        display.set(pane, name);
        continue;
      }
      // The pane id tells two sessions apart on one machine; when a twin on another machine has the same id too, the machine joins it.
      const clash = twins.some((other) => other !== pane && other.paneId === pane.paneId);
      display.set(pane, `${name} [${clash ? `${paneMemberOf(pane, live.lead)}/` : ""}${pane.paneId}]`);
    }
  }
  const made: LiveIndex = { byId, display, lead: live.lead };
  INDEXES.set(live, made);
  return made;
}

/** Whether an address carries a token, and the token. */
function tokenOf(address: string): string | null {
  const at = address.indexOf("#");
  return at === -1 ? null : address.slice(at + 1);
}

interface Match {
  pane: AgentView;
  /** The address carried a token and the pane's instance is that token: it names THIS session, not whatever holds the id now. */
  pinned: boolean;
}

/**
 * The one live pane on `member` that holds `paneId` and agrees with `token`, or null.
 *
 * A token names one session of a pane id. When the address has one and the pane carries an instance, they
 * must be equal: a different instance is a pane that was replaced since the address was written, and that
 * is no live pane. A pane that carries no instance cannot be checked, so it matches but is not pinned. Two
 * panes that both fit (a list widened across sessions) answer null: a name for the wrong terminal is worse
 * than the address.
 */
function matchOn(index: LiveIndex, member: string | null, paneId: string, token: string | null): Match | null {
  let found: AgentView | null = null;
  for (const pane of index.byId.get(paneId) ?? []) {
    if (member !== null && paneMemberOf(pane, index.lead) !== member) continue;
    if (token !== null && pane.instance !== undefined && pane.instance !== token) continue;
    if (found !== null) return null;
    found = pane;
  }
  if (found === null) return null;
  return { pane: found, pinned: token !== null && found.instance === token };
}

/** The live pane an address names, token respected, or null. */
export function livePaneAt(address: string, live: WalkyLivePanes): AgentView | null {
  return matchAddress(address, indexOfLive(live))?.pane ?? null;
}

function matchAddress(address: string, index: LiveIndex): Match | null {
  const bare = withoutToken(address);
  const slash = bare.indexOf("/");
  if (slash <= 0) return null;
  const paneId = bare.slice(slash + 1);
  if (paneId === "") return null;
  return matchOn(index, bare.slice(0, slash), paneId, tokenOf(address));
}

export interface SessionName {
  /** What to call the session. */
  name: string;
  /** The machine to add ("on <machine>") when the session is not on the reader's own, else null. */
  machine: string | null;
  /** The live pane the name came from, or null when the address named none. */
  pane: AgentView | null;
  /** The address carried a token and the live pane is that very session. False for a match by member and pane id alone. */
  pinned: boolean;
}

/**
 * The name of the session at `address`, and the machine to add beside it.
 *
 * With a live pane the name is `walkyPaneName(pane)` (with its pane id in brackets when another live pane has
 * the same name). Without one it is `fallbackLabel` (the log's label, when the caller has one), else the
 * address without its token. An address whose token no live pane carries (the pane was replaced) names no
 * live pane. The machine is decided by the address alone, as `remoteMachineOf` decides it today.
 */
export function sessionNameOf(
  address: string,
  live: WalkyLivePanes,
  self: string | undefined,
  fallbackLabel: string | null,
): SessionName {
  const machine = remoteMember(memberOfAddress(address), self);
  const index = indexOfLive(live);
  const match = matchAddress(address, index);
  if (match !== null) return { name: index.display.get(match.pane) ?? walkyPaneName(match.pane), machine, pane: match.pane, pinned: match.pinned };
  const label = fallbackLabel === null || fallbackLabel === "" ? withoutToken(address) : fallbackLabel;
  return { name: label, machine, pane: null, pinned: false };
}

/**
 * The address a SENT row's target is resolved from. The message's own `to` carries the token when it names
 * exactly one pane (`<member>/<paneId>#<token>`), so it pins the session the sender meant; every other
 * `to` (`all`, `<member>/all`, a folder name, `here`) leaves the receipt's bare target to answer.
 */
export function sentTargetAddress(row: Pick<WalkyRow, "to" | "receipt">): string {
  const to = withoutToken(row.to);
  const slash = to.indexOf("/");
  const paneId = slash > 0 ? to.slice(slash + 1) : "";
  const onePane = paneId !== "" && paneId !== "all" && !paneId.includes("/");
  return onePane ? row.to : row.receipt.target;
}

/** What a message row calls its sender: the live pane's name for an agent with an address, else the log's label. */
export function senderNameOf(row: Pick<WalkyRow, "kind" | "from">, live: WalkyLivePanes, self: string | undefined): SessionName {
  if (row.kind !== "agent" || row.from.address === null) return { name: row.from.label, machine: null, pane: null, pinned: false };
  return sessionNameOf(row.from.address, live, self, row.from.label);
}

/** A piece of a body: plain text, or an address that names a live pane. */
export type WalkyAddressPart =
  | { kind: "text"; text: string }
  | { kind: "address"; address: string; name: string; machine: string | null; pane: AgentView; pinned: boolean };

/**
 * Anything made of the characters a pane id may hold, plus `/`, with an optional `#<4 chars>` token that
 * ends the word. A greedy run starts at the beginning of a word, so the pieces below see whole words.
 */
const WORD = /[A-Za-z0-9_.:%@+=/-]+(?:#[a-z0-9]{4}(?![A-Za-z0-9_]))?/gu;
/** Punctuation that can end a sentence right after an address and is never the end of a pane id. */
const TRAILING = /[.:\-=+@]+$/u;
/** A bare pane id carries one of these marks: herdr `w54:p1J`, tmux `%7`, zellij `terminal_3`. A bare `w0` has not. */
const BARE_PANE_ID_HINT = /[:%_]/u;

/**
 * `text` cut at the addresses that resolve to a live pane. A full address (`bluefin/w54:p1J`, with or
 * without its token) resolves when a live pane carries that member and pane id; with a token the pane's
 * instance must agree (`matchOn`). A bare pane id resolves only when exactly one live pane carries it; a
 * bare window id never does. Only an address written WITH its token, and matched to that very instance, is
 * `pinned`. Everything else, including a claim no live pane backs, stays inside the text around it.
 * Joining the parts gives `text` back, except that an address part joins as the address as it was written.
 */
export function splitWalkyAddresses(text: string, live: WalkyLivePanes, self?: string): WalkyAddressPart[] {
  if (live.panes.length === 0) return [{ kind: "text", text }];
  const index = indexOfLive(live);
  const parts: WalkyAddressPart[] = [];
  let at = 0;
  for (const match of text.matchAll(WORD)) {
    const raw = match[0];
    const start = match.index;
    const tokenAt = raw.indexOf("#");
    const word = tokenAt === -1 ? raw : raw.slice(0, tokenAt);
    const core = word.replace(TRAILING, "");
    const hasToken = tokenAt !== -1 && core.length === word.length;
    const written = hasToken ? raw : core;
    const hit = resolveWord(core, hasToken ? raw.slice(tokenAt + 1) : null, index, self);
    if (hit === null) continue;
    if (start > at) parts.push({ kind: "text", text: text.slice(at, start) });
    parts.push({ kind: "address", address: written, ...hit });
    at = start + written.length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts.length === 0 ? [{ kind: "text", text }] : parts;
}

type Hit = Omit<Extract<WalkyAddressPart, { kind: "address" }>, "kind" | "address">;

function resolveWord(word: string, token: string | null, index: LiveIndex, self: string | undefined): Hit | null {
  if (word === "") return null;
  const segments = word.split("/");
  if (segments.length === 2 && segments[0] !== "" && segments[1] !== "") {
    const found = matchOn(index, segments[0]!, segments[1]!, token);
    if (found === null) return null;
    return { name: index.display.get(found.pane) ?? walkyPaneName(found.pane), machine: remoteMember(segments[0]!, self), pane: found.pane, pinned: found.pinned };
  }
  if (segments.length !== 1 || !BARE_PANE_ID_HINT.test(word)) return null;
  const found = matchOn(index, null, word, null);
  if (found === null) return null;
  const machine = remoteMember(paneMemberOf(found.pane, index.lead), self);
  return { name: index.display.get(found.pane) ?? walkyPaneName(found.pane), machine, pane: found.pane, pinned: false };
}
