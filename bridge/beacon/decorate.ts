// THE DECORATOR — where a blind adapter gains sight, and stays honest (M11/03).
//
// `withAgentBeacons` takes an adapter that cannot see agents, joins its snapshot panes to beacons
// through that multiplexer's own environment markers, and is THE ONLY THING that declares
// `agentDetection` and `agentSessionRef` true on such an adapter. The adapters underneath never
// change their declaration, so conformance proves the decorated build and the raw one separately.
//
// ── ONE DECORATOR, NOT A FOURTH ADAPTER ───────────────────────────────────────────────────────────
//
// It touches exactly two things: the capability declaration, and the panes coming out of
// `snapshot()`. Every other method is passed straight through — a decorator that reimplements
// `sendKeys` is a fork, and `decorate.test.ts` pins the pass-through method by method.
//
// ── IT REFUSES TO DECORATE AN ADAPTER THAT ALREADY SEES ───────────────────────────────────────────
//
// An adapter whose multiplexer reports the agent and its session from its own wire has a STRONGER
// source of truth than a beacon. Wrapping it would put a second, weaker one beside it, and the two
// would disagree the moment a hook was missed. So a wrapped adapter declaring either capability is
// refused loudly, at construction, rather than silently producing a pane with two identities.
//
// ── THE DECORATOR HOLDS NO MULTIPLEXER KNOWLEDGE ──────────────────────────────────────────────────
//
// The join is per-namespace and every part of it that is about a particular multiplexer lives beside
// that multiplexer's adapter, as a {@link BeaconMatcher}: which marker namespace to read, what this
// adapter's own addressing scope is, and how a raw marker names one of its panes. This file knows
// only how to ASK — which is what keeps it generic, and what keeps `scripts/check-mux-names.sh`
// green without a carve-out (the operator-facing note is adapter-supplied data, not a literal here).
//
// ── EVENTS ARE NOT SYNTHESISED, AND THAT IS A DECISION ────────────────────────────────────────────
//
// A beacon's status changing is a pane event the wrapped adapter cannot see, so in principle
// `watch()` should fire for it. It does not, in M11, and this comment sits where someone would add
// it: the snapshot poll already carries status to the phone on its adaptive interval, and a
// beacon-directory watcher would be a second filesystem watcher bought for a second's worth of
// latency. `watch` is therefore an untouched pass-through and `pushPaneEvents` stays exactly as the
// wrapped adapter declared it — a decorator that declared a push it does not make would be lying in
// the one direction the conformance suite cannot catch.

import { markersIn, readBeacons, type BeaconSweepDeps } from "./reader.ts";
import type { BeaconReading, BeaconMarker, BeaconStatus } from "./types.ts";
import type { AgentSessionRef } from "../journal/types.ts";
import { declareCapabilities, MUX_CAPABILITIES, type MuxCapabilityDeclaration } from "../mux/capabilities.ts";
import { muxDataFields, type MuxAdapter, type MuxPane, type MuxSnapshot } from "../mux/types.ts";
import type { AgentStatus } from "../types.ts";

/**
 * How much a status is worth, as a named type rather than a comment.
 *
 * `definitive-via-hook` is the ONLY tier that carries a status: the agent said it, through its own
 * hook, and nothing inferred it — the framing Codeman arrived at ("hook events are the only
 * definitive signals") after trying an LLM judge and output throughput, neither of which is adopted
 * here. Everything else is `unknown`, and that includes the case this milestone can most easily get
 * wrong: ABSENCE. "No beacon" and "the agent is resting" look identical from outside and mean
 * opposite things to a triage sort.
 */
export type BeaconTrust = "definitive-via-hook" | "unknown";

/**
 * The beacon vocabulary, in Collie's words. One place, and the only place.
 *
 * The beacon's three words are paseo's event map; Collie's {@link AgentStatus} is a five-word TRIAGE
 * vocabulary and has no `waiting` in it, so the third row is a real decision rather than a rename.
 */
const BEACON_STATUS = {
  working: "working",
  idle: "idle",
  // `waiting` → `blocked` because `STATUS_RANK.blocked = 0` (bridge/types.ts) — the top of triage,
  // which is exactly where an agent that has stopped and is waiting on the operator belongs. Every
  // other Collie word ranks below it, so mapping to `idle` here would bury the one pane that needs a
  // human at the bottom of the herd list.
  waiting: "blocked",
} satisfies Record<BeaconStatus, AgentStatus>;

/**
 * A harness name Collie will put on a pane: short, lower-case, and shaped like a registry key.
 *
 * The parse boundary already bounded the field at 4 KiB, which is not the same as "a name the
 * harness and journal registries could ever match". A value outside this shape names no adapter, so
 * carrying it would decorate a pane with a label that looks like an identity and resolves to
 * nothing.
 */
const HARNESS_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/u;

/**
 * How ONE multiplexer's beacons name ONE of its panes. Contributed by the adapter, never by this
 * file — see the header.
 */
export interface BeaconMatcher {
  /** The marker namespace to read, which is the adapter's own registry key. */
  readonly namespace: string;
  /**
   * This adapter's own addressing space — the tmux server socket, the zellij session — or null when
   * it cannot be determined right now.
   *
   * Asynchronous because a multiplexer is usually the only thing that can answer it, and resolved
   * ONCE per snapshot by the decorator. `null` joins nothing at all: pane ids are per-server and
   * per-session, so without the scope a `%7` from a second multiplexer on the same host would hand
   * this pane somebody else's agent identity. Fail closed is the only safe direction.
   */
  scope(): Promise<string | null>;
  /**
   * Does this marker — raw, exactly as the emitter read it out of the environment — name this pane
   * inside this scope? Any prefixing or normalisation a multiplexer's Collie ids need is applied
   * here, and the scope check is part of the answer.
   */
  matches(pane: MuxPane, marker: BeaconMarker, scope: string): boolean;
  /**
   * What the operator reads while the hooks are NOT installed, per capability this would have lifted.
   *
   * Adapter-supplied, so it may name the multiplexer: it travels on `MuxConfig.notes` (M10/06), which
   * is data on `/api/config` rather than a literal in the frontend.
   */
  readonly notesWithoutHooks: Readonly<Record<"agentDetection" | "agentSessionRef", string>>;
}

/** What the decorator needs besides the adapter and the beacon reader. */
export interface AgentBeaconDeps {
  readonly matcher: BeaconMatcher;
  /**
   * Is the emitter installed for at least one harness?
   *
   * THE LIFT IS GATED ON THIS AND NOT ON A BEACON EXISTING. A freshly-restarted agent has no beacon
   * until its first hook fires, and a capability that appeared and disappeared with it would make
   * the phone's UI flicker between "history is here" and "this multiplexer has no such thing" — a
   * declaration worse than an honestly absent one. A seam rather than a filesystem call so this
   * module keeps `bridge/beacon/`'s rule: nothing under here touches a disk.
   */
  hooksInstalled(): boolean;
}

/** What one matched beacon says about a pane. */
export interface BeaconIdentity {
  readonly agent: string;
  readonly status: AgentStatus;
  readonly trust: BeaconTrust;
  readonly session: AgentSessionRef;
}

/**
 * One reading as a pane's identity, or null when it names nothing usable.
 *
 * The expired row is the subtle one and the reader already made it possible to get right: an expired
 * beacon still supplies `harness` and `session`, because a finished conversation is still readable
 * (M11/04), and supplies NO status, because it has not been able to make a claim since it died. So
 * the session ref survives expiry and the status does not.
 */
export function identityOf(reading: BeaconReading): BeaconIdentity | null {
  const agent = reading.harness.trim().toLowerCase();
  if (!HARNESS_NAME.test(agent)) return null;
  if (reading.liveness === "live") {
    return {
      agent,
      status: BEACON_STATUS[reading.status],
      trust: "definitive-via-hook",
      session: reading.session,
    };
  }
  return { agent, status: "unknown", trust: "unknown", session: reading.session };
}

/** The two capabilities a beacon join can supply, and the only two this decorator touches. */
const LIFTED = ["agentDetection", "agentSessionRef"] as const;

/**
 * The wrapped declaration, lifted or not.
 *
 * Rebuilt through {@link declareCapabilities} rather than spread over the wrapped one, so the
 * fail-closed total it produces stays total: a capability added to the port later cannot arrive here
 * as a silent `true` any more than it can on an adapter.
 */
function declarationFor(adapter: MuxAdapter, matcher: BeaconMatcher, lifted: boolean): MuxCapabilityDeclaration {
  const inherited = MUX_CAPABILITIES.filter((capability) => adapter.capabilities.supports[capability]);
  const notes = { ...adapter.capabilities.notes };
  for (const capability of LIFTED) {
    // The wrapped adapter's note says its multiplexer cannot know what an agent is, which stops being
    // the operator's answer either way: with hooks installed it is no longer true of this build, and
    // without them the useful sentence is the one that says how to turn it on.
    if (lifted) delete notes[capability];
    else notes[capability] = matcher.notesWithoutHooks[capability];
  }
  return declareCapabilities({
    supports: lifted ? [...inherited, ...LIFTED] : inherited,
    unsupportedKeys: adapter.capabilities.unsupportedKeys,
    notes,
    // Carried through, because a beacon changes what Collie knows about a PANE and never how many
    // spaces the multiplexer has. Rebuilding the declaration without it would silently promote a
    // zellij collie to "many" the moment the hooks were installed.
    spaces: adapter.capabilities.spaces,
    // Carried through, never restated: a beacon join changes what a pane IS, not how soon a pane
    // appearing is noticed. That is still the wrapped adapter's census, and claiming otherwise here
    // would be the decorator declaring a promise it makes nothing keep.
    topologyLatency: adapter.capabilities.topologyLatency,
  });
}

/**
 * The beacon that belongs to this pane, or null.
 *
 * AMBIGUITY IS ABSENCE. Two different beacons matching one pane cannot both be its identity — one
 * live agent per pane is the truth on every multiplexer Collie drives — and picking either would be
 * picking at random, so the pane keeps the honest "no agent here" answer instead.
 */
function beaconForPane(
  pane: MuxPane,
  readings: readonly BeaconReading[],
  matcher: BeaconMatcher,
  scope: string,
): BeaconReading | null {
  const matched = readings.filter((reading) =>
    markersIn(reading, matcher.namespace).some((marker) => matcher.matches(pane, marker, scope)),
  );
  return matched.length === 1 ? (matched[0] ?? null) : null;
}

/** One pane, with whatever its beacon says about it. Absent or ambiguous ⇒ returned untouched. */
function decoratePane(
  pane: MuxPane,
  readings: readonly BeaconReading[],
  matcher: BeaconMatcher,
  scope: string,
): MuxPane {
  const reading = beaconForPane(pane, readings, matcher, scope);
  if (reading === null) return pane;
  const identity = identityOf(reading);
  if (identity === null) return pane;
  // Assigned onto a copy, never conditionally spread, so a field the beacon does not supply stays
  // absent — the rule every adapter in this tree follows for `MuxPane`.
  return { ...pane, agent: identity.agent, status: identity.status, agentSession: identity.session };
}

/**
 * `adapter`, seeing agents through their own beacons.
 *
 * Throws when the wrapped adapter already declares either capability — see the header. That is a
 * wiring mistake, it is the same on every start, and a silent second source of truth is exactly what
 * this refusal is here to prevent.
 */
export function withAgentBeacons(
  adapter: MuxAdapter,
  reader: BeaconSweepDeps,
  deps: AgentBeaconDeps,
): MuxAdapter {
  for (const capability of LIFTED) {
    if (adapter.capabilities.supports[capability]) {
      throw new Error(
        `refusing to wrap the "${adapter.mux}" adapter with agent beacons: it already declares ` +
          `${capability} from its own multiplexer, and a beacon beside a stronger source of truth is a ` +
          "second identity for the same pane",
      );
    }
  }
  const lifted = declarationFor(adapter, deps.matcher, true);
  const plain = declarationFor(adapter, deps.matcher, false);

  return {
    // The adapter's own data fields, carried across unchanged — and gathered by ONE helper rather
    // than listed here, so the next field added to the contract cannot go missing at this seam
    // (bridge/mux/types.ts § muxDataFields).
    ...muxDataFields(adapter),
    mux: adapter.mux,
    // A getter, so `collie hooks install claude` reaches a RUNNING bridge: the declaration is read
    // per request (`muxConfigBody`), and the seam behind `hooksInstalled` is what decides how often
    // the real answer is re-read.
    get capabilities(): MuxCapabilityDeclaration {
      return deps.hooksInstalled() ? lifted : plain;
    },

    reachable: () => adapter.reachable(),

    /**
     * The wrapped snapshot, with every pane joined to its beacon.
     *
     * Gated on the same condition as the declaration, so the two can never disagree: an adapter that
     * declared the capability absent and then populated the field would fail conformance, and one
     * that declared it present and populated nothing would fail it the other way.
     */
    async snapshot(): Promise<MuxSnapshot> {
      const snapshot = await adapter.snapshot();
      if (!deps.hooksInstalled()) return snapshot;
      const scope = await deps.matcher.scope();
      if (scope === null) return snapshot;
      const readings = await readBeacons(reader);
      if (readings.length === 0) return snapshot;
      return { ...snapshot, panes: snapshot.panes.map((pane) => decoratePane(pane, readings, deps.matcher, scope)) };
    },

    // ── Everything below is the wrapped adapter's, verbatim ────────────────────
    // A beacon is not topology, so there is nothing extra to pull forward here — and pulling the
    // wrapped adapter's census forward is exactly what a refresh should do either way.
    refresh: () => adapter.refresh(),
    readGrid: (paneId, request) => adapter.readGrid(paneId, request),
    typeText: (paneId, text) => adapter.typeText(paneId, text),
    sendKeys: (paneId, keys) => adapter.sendKeys(paneId, keys),
    renamePane: (paneId, label) => adapter.renamePane(paneId, label),
    closePane: (paneId) => adapter.closePane(paneId),
    setFocus: (paneId) => adapter.setFocus(paneId),
    createTab: (request) => adapter.createTab(request),
    renameTab: (tabId, label) => adapter.renameTab(tabId, label),
    closeTab: (tabId) => adapter.closeTab(tabId),
    createSpace: (request) => adapter.createSpace(request),
    // Untouched, and the header says why a beacon change fires nothing here.
    watch: (options) => adapter.watch(options),
  };
}
