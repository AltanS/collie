// A walky talky session, named for the person on the phone (M80 spec 12).
//
// The wire, the log, `who` and the CLI keep the address (`<memberId>/<paneId>[#token]`) and the message
// id: agents need them. A person reading a message on the phone needs the session's NAME, so this module
// turns an address into the name of the live pane that holds it, and finds addresses inside a body.
//
// ── ONE NAME RULE ─────────────────────────────────────────────────────────────
// The name is `paneName(pane)` (lib/pane-name.ts), the one rule every other screen uses. A second rule
// here would let one pane carry two names, and a renamed pane would keep its old one in old messages.
//
// ── A NAME IS A CLAIM UNTIL A LIVE PANE HOLDS IT ──────────────────────────────
// A body is text an agent wrote, so an address in it is a claim. It becomes a name only where a live pane
// of the phone's own pane list carries that member and pane id. Unresolved text stays text. A bare pane id
// (`w54:p1J`, no machine in front) resolves only when exactly ONE live pane carries it, because a pane id
// is unique within one machine and one session only. A bare window id (`w0`) is never resolved: it names
// no pane. A pane id that two live panes share on one machine (a widened list across sessions) does not
// resolve either, since a name for the wrong terminal is worse than the address.
//
// Pure and React-free: the card, the sheets and the tests all call these functions.
import { paneName } from "./pane-name";
import type { AgentView } from "./types";
import { SOLO_MEMBER, type WalkyRow } from "./walky";

/** The phone's live panes, and the lead's member id (the member of a pane the snapshot did not tag). */
export interface WalkyLivePanes {
  readonly panes: readonly AgentView[];
  readonly lead: string | undefined;
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

/** The one live pane that holds `paneId` on `member`, or null when none does or several do. */
function paneOnMember(live: WalkyLivePanes, member: string, paneId: string): AgentView | null {
  let found: AgentView | null = null;
  for (const pane of live.panes) {
    if (pane.paneId !== paneId || paneMemberOf(pane, live.lead) !== member) continue;
    if (found !== null) return null;
    found = pane;
  }
  return found;
}

/** The one live pane that holds `paneId` on any machine, or null when none does or several do. */
function paneAnywhere(live: WalkyLivePanes, paneId: string): AgentView | null {
  let found: AgentView | null = null;
  for (const pane of live.panes) {
    if (pane.paneId !== paneId) continue;
    if (found !== null) return null;
    found = pane;
  }
  return found;
}

/** The live pane an address names (its token ignored), or null. */
export function livePaneAt(address: string, live: WalkyLivePanes): AgentView | null {
  const bare = withoutToken(address);
  const slash = bare.indexOf("/");
  if (slash <= 0) return null;
  const paneId = bare.slice(slash + 1);
  if (paneId === "") return null;
  return paneOnMember(live, bare.slice(0, slash), paneId);
}

export interface SessionName {
  /** What to call the session. */
  name: string;
  /** The machine to add ("on <machine>") when the session is not on the reader's own, else null. */
  machine: string | null;
  /** The live pane the name came from, or null when the address named none. */
  pane: AgentView | null;
}

/**
 * The name of the session at `address`, and the machine to add beside it.
 *
 * With a live pane the name is `paneName(pane)`. Without one it is `fallbackLabel` (the log's label, when
 * the caller has one), else the address without its token. The machine is decided by the address alone,
 * live pane or not, as `remoteMachineOf` decides it today.
 */
export function sessionNameOf(
  address: string,
  live: WalkyLivePanes,
  self: string | undefined,
  fallbackLabel: string | null,
): SessionName {
  const machine = remoteMember(memberOfAddress(address), self);
  const pane = livePaneAt(address, live);
  if (pane !== null) return { name: paneName(pane), machine, pane };
  const label = fallbackLabel === null || fallbackLabel === "" ? withoutToken(address) : fallbackLabel;
  return { name: label, machine, pane: null };
}

/** What a message row calls its sender: the live pane's name for an agent with an address, else the log's label. */
export function senderNameOf(row: Pick<WalkyRow, "kind" | "from">, live: WalkyLivePanes, self: string | undefined): SessionName {
  if (row.kind !== "agent" || row.from.address === null) return { name: row.from.label, machine: null, pane: null };
  return sessionNameOf(row.from.address, live, self, row.from.label);
}

/** A piece of a body: plain text, or an address that names a live pane. */
export type WalkyAddressPart =
  | { kind: "text"; text: string }
  | { kind: "address"; address: string; name: string; machine: string | null; pane: AgentView };

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
 * without its token) resolves when a live pane carries that member and pane id. A bare pane id resolves
 * only when exactly one live pane carries it; a bare window id never does. Everything else, including a
 * claim no live pane backs, stays inside the text around it. Joining the parts gives `text` back, except
 * that an address part joins as the address as it was written.
 */
export function splitWalkyAddresses(text: string, live: WalkyLivePanes, self?: string): WalkyAddressPart[] {
  if (live.panes.length === 0) return [{ kind: "text", text }];
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
    const hit = resolveWord(core, live, self);
    if (hit === null) continue;
    if (start > at) parts.push({ kind: "text", text: text.slice(at, start) });
    parts.push({ kind: "address", address: written, ...hit });
    at = start + written.length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts.length === 0 ? [{ kind: "text", text }] : parts;
}

function resolveWord(word: string, live: WalkyLivePanes, self: string | undefined): Omit<Extract<WalkyAddressPart, { kind: "address" }>, "kind" | "address"> | null {
  if (word === "") return null;
  const segments = word.split("/");
  if (segments.length === 2 && segments[0] !== "" && segments[1] !== "") {
    const pane = paneOnMember(live, segments[0]!, segments[1]!);
    if (pane === null) return null;
    return { name: paneName(pane), machine: remoteMember(segments[0]!, self), pane };
  }
  if (segments.length !== 1 || !BARE_PANE_ID_HINT.test(word)) return null;
  const pane = paneAnywhere(live, word);
  if (pane === null) return null;
  return { name: paneName(pane), machine: remoteMember(paneMemberOf(pane, live.lead), self), pane };
}
