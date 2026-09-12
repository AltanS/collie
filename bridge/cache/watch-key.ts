// How a watched pane is ADDRESSED, and the one place that grammar lives.
//
// Three pure functions and a constant, split out of `watch.ts` so the decision in `warn.ts` can build
// a tag without importing a module that touches the filesystem. Nothing here reads a clock, a file or
// an environment variable.
//
// ── THE KEY IS (host, session, ref), AND `ref` IS NOT ALWAYS A SESSION REF ────
// A LOCAL pane is keyed by the harness's own session ref, `"<kind>:<value>"` of `AgentSessionRef`,
// because pane ids churn and a renumbered pane must inherit nothing (ADR 0042).
//
// A PEER's pane cannot be: `agentSession` is stripped before a pane goes on any wire
// (`bridge/types.ts` § PaneWire), so a lead holds no ref for a pane on a member and adding one to the
// crew wire would publish an agent-reported filesystem path across a machine boundary. A peer's pane is
// therefore keyed `pane:<paneId>`, which is the identity the lead actually has — the same identity
// `bridge/crew/notify.ts` already keys a peer's alerts by. The cost is named rather than hidden: a
// renumbered pane on a member orphans its entry, which then ages out exactly as a moved pi path ref
// does.
//
// ── AND THE REF NEVER LEAVES THE BRIDGE ──────────────────────────────────────
// {@link watchIdOf} is the only form of a key a phone ever sees: a short, one-way hash. It is an
// address for a remove button and nothing else, which is the same containment `agentSession` has.

import { createHash } from "node:crypto";
import type { AgentView, PaneWire } from "../types.ts";
import type { PaneCache } from "./engine.ts";

/** How long an entry whose session is absent from every snapshot survives before it is pruned. */
export const UNSEEN_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * What joins the three parts of a key.
 *
 * A NUL, because any printable separator is a character one of the parts may legitimately contain: a
 * pi ref's value is an absolute path and a session name is operator text. Built rather than typed, so
 * no source file in this tree carries a control byte.
 */
const SEP = String.fromCharCode(0);

/** The three parts of a watch key. `host`/`session` absent mean "here" and "primary". */
export interface WatchIdentity {
  readonly host?: string;
  readonly session?: string;
  /** `"<kind>:<value>"` for a local pane, `"pane:<paneId>"` for a peer's. See the module header. */
  readonly ref: string;
}

/** The stored key for one identity. */
export function watchKeyOf(id: WatchIdentity): string {
  return [id.host ?? "", id.session ?? "", id.ref].join(SEP);
}

/**
 * The opaque handle a key is published under — eight hex characters of its SHA-256.
 *
 * Short because it is typed by nobody and compared by machine; one-way because the ref it covers is
 * either an opaque harness id or an absolute path, and neither is the phone's business.
 */
export function watchIdOf(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** The dedupe mark for one warm cycle: at most one push per `(key, expiresAt)` pair (ADR 0042). */
export function sentMarkOf(key: string, expiresAt: number): string {
  return `${key}@${expiresAt}`;
}

/**
 * One pane as the warden judges it: its key, its address, its label and its cache reading.
 *
 * A shape of its own rather than `AgentView` or `PaneWire`, because the two sides of the crew supply
 * different things — a local pane has the session ref and no host, a peer's pane has a host and no ref
 * — and the decision in `warn.ts` must not have to know which it is holding.
 */
export interface CacheWarnPane {
  readonly key: string;
  /** The third part of {@link key}, kept so a route can hand this straight to the store as an identity. */
  readonly ref: string;
  readonly paneId: string;
  readonly label: string;
  readonly host?: string;
  readonly session?: string;
  readonly cache?: PaneCache;
}

/**
 * What a push says this pane is. The operator's own names first, the harness last.
 *
 * The workspace leads, because two agents in two projects otherwise read as the same line on a lock
 * screen. It is display only and is never part of a key.
 */
export function paneWatchLabel(pane: {
  workspaceLabel?: string;
  paneLabel?: string;
  sessionName?: string;
  agent: string;
}): string {
  const name = pane.paneLabel ?? pane.sessionName ?? pane.agent;
  const space = pane.workspaceLabel ?? "";
  return space === "" ? name : `${space} · ${name}`;
}

/**
 * A pane on THIS collie, or undefined when it names no harness session.
 *
 * `session` is omitted for the primary, which is the same omitted-not-null discipline the push payload
 * follows — so a solo install's keys carry neither a host nor a session.
 */
export function localWatchPane(
  pane: AgentView,
  session: string | undefined,
  /**
   * The prompt-cache ledger, asked by harness session id. Passed in rather than read off the pane
   * because the reading is attached at SERIALISE time (`bridge/server.ts` § localSnapshot) and the two
   * callers here are upstream of that: the poll, and the watch route.
   */
  reading?: (sessionKey: string) => PaneCache | undefined,
): CacheWarnPane | undefined {
  if (pane.agentSession === undefined) return undefined;
  if (pane.kind === "shell") return undefined;
  const identity: WatchIdentity = { ref: `${pane.agentSession.kind}:${pane.agentSession.value}` };
  const id = session === undefined ? identity : { ...identity, session };
  const cache = pane.cache ?? reading?.(pane.agentSession.value);
  const out: CacheWarnPane = {
    key: watchKeyOf(id),
    ref: identity.ref,
    paneId: pane.paneId,
    label: paneWatchLabel(pane),
  };
  const withCache = cache === undefined ? out : { ...out, cache };
  return session === undefined ? withCache : { ...withCache, session };
}

/** A pane on a crew member, keyed by the identity the lead actually has (see the module header). */
export function peerWatchPane(pane: PaneWire, host: string): CacheWarnPane | undefined {
  if (pane.kind === "shell") return undefined;
  const id: WatchIdentity = { host, ref: `pane:${pane.paneId}` };
  const out: CacheWarnPane = {
    key: watchKeyOf(id),
    ref: id.ref,
    paneId: pane.paneId,
    label: paneWatchLabel(pane),
    host,
  };
  // Assigned, never spread as `undefined`: a pane with no reading must carry no key at all, which is
  // what makes `watchable` false for it rather than "false-ish".
  return pane.cache === undefined ? out : { ...out, cache: pane.cache };
}
