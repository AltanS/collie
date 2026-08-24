// THE MUX PORT — everything Collie needs from a multiplexer, in Collie's words.
//
// A *multiplexer* is what owns the pane. A *harness* is what runs inside it (claude, codex, pi, omp).
// Two axes, two registries, and they never key off each other — see registry.ts.
//
// WHY A PORT AND NOT A CLIENT. `bridge/types.ts` already decoupled the DOMAIN from Herdr's wire
// shapes ("These are OUR types … the rest of the app talks in these terms"), and the frontend holds
// no multiplexer vocabulary at all. What was missing is the other half: an INTERFACE the bridge
// depends on instead of a concrete class, so a second multiplexer is a module rather than a branch
// in every route. ADR 0022 records why "just point the Herdr client at it" is not that.
//
// THREE CONTRACT-OWNED THINGS LIVE HERE, because getting them wrong later is expensive:
//
//  • **The unsupported answer** ({@link MuxOutcome}) — one shape, distinguishable from a failure, so
//    a route never has to guess what a rejected call meant.
//  • **Identity** — see identity.ts. Stable across a reconnect, unique within a collie.
//  • **Subscription semantics** — see {@link MuxAdapter.watch}. The promise is the contract's; how
//    an adapter keeps it (a real stream, a poll, or a hybrid) is the adapter's.
//
// The neutral key spelling is the fourth (keys.ts), and the reason it exists is that all three
// multiplexers spell `ctrl+c` differently.
//
// WHAT IS NOT HERE, deliberately: a rendered terminal. `readGrid` returns text the multiplexer has
// ALREADY rendered, carrying colour and nothing else; Collie runs no emulator and never will
// (ADR 0008). An adapter whose multiplexer will not hand over a rendered screen declines the
// capability — it does not get a VT parser written for it.

import type { AgentSessionRef } from "../journal/types.ts";
import type { AgentStatus } from "../types.ts";
import type { MuxCapability, MuxCapabilityDeclaration } from "./capabilities.ts";
import type { MuxIdentity } from "./identity.ts";

export type { MuxCapability, MuxCapabilityDeclaration, MuxSpaceCapacity } from "./capabilities.ts";
export { declareCapabilities, MUX_CAPABILITIES, supportsCapability } from "./capabilities.ts";
export type { MuxIdentity, MuxIdentityProblem } from "./identity.ts";
export { checkIdentitySet, idsLostBetween, isValidMuxId } from "./identity.ts";
export type { MuxKey, MuxModifier, MuxNamedKey } from "./keys.ts";
export { canonicalMuxKey, formatMuxKey, isMuxKey, parseMuxKey } from "./keys.ts";

// ── The one refusal shape ─────────────────────────────────────────────────────

/**
 * Why a call did not happen. Four reasons, and the first one is not a failure at all:
 *
 *  • `unsupported` — this multiplexer has no such thing, and never will while it is this
 *    multiplexer. The route renders an explanation, not an error (M10/06). It names the
 *    {@link MuxCapability} so the UI can reuse one wording rule instead of parsing prose.
 *  • `gone` — the pane or tab existed and does not any more. The operator's screen is stale; the
 *    remedy is to go back, not to retry.
 *  • `refused` — the multiplexer understood and said no (a key it will not send, a label it will
 *    not take). Retrying the same call gets the same answer.
 *  • `unreachable` — the multiplexer did not answer. This is the only one worth retrying, and it is
 *    what drives the connected/disconnected banner.
 *
 * An adapter MUST return this rather than throw for anything it declared absent — that is checked by
 * conformance (M10/03), because a throw is what forces every route to guess.
 */
export type MuxRefusal =
  | { readonly reason: "unsupported"; readonly capability: MuxCapability; readonly detail: string }
  | { readonly reason: "gone"; readonly detail: string }
  | { readonly reason: "refused"; readonly detail: string }
  | { readonly reason: "unreachable"; readonly detail: string };

/** A refusal, as a failed outcome. */
export type MuxRefusalOutcome = { readonly ok: false } & MuxRefusal;

/** A call's answer: a value, or one {@link MuxRefusal}. */
export type MuxOutcome<T> = { readonly ok: true; readonly value: T } | MuxRefusalOutcome;

/** A call that succeeds with nothing to say. */
export type MuxAck = MuxOutcome<void>;

/** Success. */
export function muxOk<T>(value: T): MuxOutcome<T> {
  return { ok: true, value };
}

/** Success with nothing to return — a send, a rename, a close. */
export function muxAck(): MuxAck {
  return { ok: true, value: undefined };
}

/** "This multiplexer has no such thing." The answer a route explains rather than reports. */
export function muxUnsupported(capability: MuxCapability, detail: string): MuxRefusalOutcome {
  return { ok: false, reason: "unsupported", capability, detail };
}

/** "That pane/tab is gone." */
export function muxGone(detail: string): MuxRefusalOutcome {
  return { ok: false, reason: "gone", detail };
}

/** "Understood, and no." */
export function muxRefused(detail: string): MuxRefusalOutcome {
  return { ok: false, reason: "refused", detail };
}

/** "The multiplexer did not answer." */
export function muxUnreachable(detail: string): MuxRefusalOutcome {
  return { ok: false, reason: "unreachable", detail };
}

/**
 * Whether this outcome is the capability answer rather than a failure.
 *
 * The distinction routes actually branch on: an absent capability is a state of the world to
 * describe, a failure is something that went wrong.
 */
export function isUnsupported<T>(outcome: MuxOutcome<T>): boolean {
  return !outcome.ok && outcome.reason === "unsupported";
}

// ── What a multiplexer knows about ────────────────────────────────────────────

/**
 * One pane, as the MULTIPLEXER knows it.
 *
 * Deliberately smaller than the bridge's `AgentView`: everything Collie adds on top — when you last
 * looked at a pane, whether it is unseen, the session name read out of the pane's own text — is the
 * bridge's knowledge, not the multiplexer's. Keeping the two apart is what stops a future adapter
 * being asked to invent a field only Collie's ledger could ever fill.
 */
export interface MuxPane extends MuxIdentity {
  readonly paneId: string;
  readonly spaceId: string;
  readonly spaceLabel: string;
  /** The space's position, as the multiplexer orders them. 1-based; 0 when it has no ordering. */
  readonly spaceNumber: number;
  readonly tabId: string;
  /** The tab's label, when it carries information. Absent for a positional default. */
  readonly tabLabel?: string;
  /** The pane's working directory. Empty when the multiplexer does not report one. */
  readonly cwd: string;
  /**
   * **The pane the operator's own terminal is showing.** Not "the pane Collie is showing", and not a
   * pane Collie chose — it is a FACT about the multiplexer, read every snapshot.
   *
   * The phone never moves it as a side effect of navigation: a pane is focused because a human, or a
   * named tap on the `setFocus` row, put it there. Every adapter answers this on the floor, because
   * every multiplexer knows it; only *changing* it is a capability
   * ({@link MuxAdapter.setFocus}).
   *
   * Focus is per-CLIENT on every multiplexer here, so "no client attached" is a real answer and the
   * honest one is `false` on every pane. What each adapter reads it off is in MUX_CONTRACT.md
   * § Contract-owned rules, with the probe.
   */
  readonly focused: boolean;
  /** False once the pane's process has ended but its record survives. A send to it answers `gone`. */
  readonly alive: boolean;
  /**
   * Which agent runs here, lower-cased, or `"shell"` for a bare shell.
   *
   * Requires the `agentDetection` capability. An adapter without it reports every pane as a shell —
   * it does NOT guess from a process name, because a wrong agent name picks a wrong harness grammar
   * and a wrong journal adapter.
   */
  readonly agent: string;
  /** How that agent is doing. `"unknown"` is the honest answer without `agentDetection`. */
  readonly status: AgentStatus;
  /**
   * The operator's own label for this pane — ONLY a name given through Collie's {@link
   * MuxAdapter.renamePane}, and never a title the pane's program printed.
   *
   * A multiplexer with one title slot (tmux, zellij) cannot tell the two apart from its listing, so
   * its adapter remembers the labels it set itself and reports everything else as {@link
   * terminalTitle}. The rule and what it costs after a restart: MUX_CONTRACT.md § Contract-owned
   * rules, *Pane naming*.
   */
  readonly paneLabel?: string;
  /**
   * What the pane's process says it is doing — its terminal title, when it says anything useful.
   *
   * The DEFAULT reading of a one-slot multiplexer's title: anything the adapter did not itself put
   * there is the program's, because that is the honest way round. It may also be left over from a
   * program that has since exited — see {@link foregroundCommand} and the bridge's staleness rule.
   */
  readonly terminalTitle?: string;
  /**
   * The session the agent in this pane named, when it named one — the journal's key, and the reason
   * `agentSessionRef` is a capability rather than an assumption (bridge/journal/registry.ts).
   *
   * Server-side only: it never reaches the phone (see `toPaneWire`).
   */
  readonly agentSession?: AgentSessionRef;
  /**
   * Upper bound on the lines one read of this pane can return. The only reliable "is there more"
   * signal, and it means something only with `gridScrollback`.
   */
  readonly readableLines?: number;
  /**
   * The command name the multiplexer says is in this pane's foreground right now — tmux's
   * `pane_current_command`, zellij's `terminal_command`. Absent when the multiplexer reports none.
   *
   * It is the RAW FACT the adapter already holds, reported as a raw fact. Exactly TWO modules in the
   * tree read it, and both spend it on presentation only — it never reaches {@link agent}, {@link
   * status}, the session ref or the triage sort:
   *
   *  • `bridge/beacon/hint.ts`, where it may become a sentence for the operator.
   *  • `bridge/state-engine.ts`, where "a shell in the foreground under a non-empty {@link
   *    terminalTitle}" marks that title STALE — the title outlived the program that printed it
   *    (MUX_CONTRACT.md § traps). The pane's name and status are unchanged by that mark; the phone
   *    merely renders the title quietly instead of as the pane's name.
   *
   * It stops there. It does not go on the wire, because a process name arriving on the phone is the
   * identity this field is not.
   *
   * **IT IS NOT IDENTITY, AND NOTHING MAY TREAT IT AS ONE.** {@link MuxPane.agent} carries the whole
   * reason: a wrong agent name picks a wrong harness grammar AND a wrong journal adapter, so the
   * port's answer to "which agent runs here" is `agentDetection` or `"shell"` — never a process
   * name, however much this one looks like an identity.
   */
  readonly foregroundCommand?: string;
  /**
   * A finished English sentence for the operator about this pane, composed server-side.
   *
   * Presentation, and only presentation: it is text the phone renders and does not interpret. It
   * names no harness and no multiplexer, arms nothing, and its presence or absence changes no
   * capability, no grammar and no sort. See the module that composes it, beside the decorator.
   */
  readonly hint?: string;
}

/** One space — a project-scoped container of tabs. Collie's word; the port never uses another. */
export interface MuxSpace {
  readonly spaceId: string;
  readonly number: number;
  readonly label: string;
  readonly focused: boolean;
  readonly activeTabId: string;
  readonly tabCount: number;
  readonly paneCount: number;
}

/** One tab within a space — a layout holding one or more panes. */
export interface MuxTab {
  readonly tabId: string;
  readonly spaceId: string;
  readonly number: number;
  readonly label: string;
  readonly focused: boolean;
  readonly paneCount: number;
}

/**
 * Everything at once — the floor of the contract, and not a capability.
 *
 * A multiplexer that cannot answer this has nothing for Collie to render. Whether the adapter gets
 * it in one round trip or three is its own business.
 */
export interface MuxSnapshot {
  readonly panes: readonly MuxPane[];
  readonly spaces: readonly MuxSpace[];
  readonly tabs: readonly MuxTab[];
}

// ── Reading a pane ────────────────────────────────────────────────────────────

/**
 * What to read.
 *
 * `scope` is neutral by necessity, not by taste: `viewport` is what is on screen now, `recent` is
 * the viewport plus whatever the multiplexer kept behind it. Without `gridScrollback` the two are
 * the same answer.
 *
 * `styling` is on the contract because it is BEHAVIOURAL, not cosmetic: on at least one multiplexer
 * the two formats take different paths through the terminal core, and one of them can move the
 * operator's own screen (see the note above the read in bridge/server.ts). A caller that only wants
 * words — the session-name scrape in state-engine.ts — must be able to say so.
 */
export interface MuxGridRequest {
  readonly scope: "viewport" | "recent";
  readonly lines: number;
  readonly styling: "preserve" | "strip";
}

/**
 * A pane's screen as the multiplexer rendered it.
 *
 * `text` carries colour/weight escapes and nothing else — no cursor moves, no alternate-screen
 * switches, nothing that would need an emulator to interpret (ADR 0008). It is parsed for colour and
 * rendered as text nodes; that is the XSS boundary, and it does not move.
 */
export interface MuxGrid {
  readonly paneId: string;
  readonly text: string;
  /** The multiplexer truncated the read to fit its own limits. */
  readonly truncated: boolean;
  /**
   * A number that CHANGES when this pane's content changes and never decreases while the pane lives.
   *
   * The race guard leans on it: a tap is refused when the screen it was derived from has moved on.
   * A multiplexer with no native revision must derive one (a counter advanced on changed content is
   * enough) — the contract needs the property, not the mechanism, and an adapter that returned a
   * constant here would disable the guard silently.
   */
  readonly revision: number;
}

/** A freshly-created shell pane — enough to navigate into it before the next snapshot. */
export interface MuxCreatedPane {
  readonly paneId: string;
  readonly spaceId: string;
  readonly spaceLabel: string;
  readonly tabId: string;
  readonly cwd: string;
}

/** What a new tab asks for. */
export interface MuxTabRequest {
  readonly spaceId: string;
  readonly label?: string;
  readonly cwd?: string;
}

/** What a new space asks for. */
export interface MuxSpaceRequest {
  readonly cwd: string;
  readonly label?: string;
}

// ── Learning that something changed ───────────────────────────────────────────

/**
 * How a watcher is told to look again.
 *
 * THE PROMISE IS THE CONTRACT'S AND IT IS SMALL, on purpose: *after something changes, a callback
 * fires within the adapter's stated bound.* Notifications are hints to RE-READ, never state — a
 * caller that builds its view out of them is wrong, and the existing poker already works this way.
 *
 * That smallness is what lets an adapter keep the promise by polling. Herdr streams; tmux's control
 * mode streams; zellij streams content but has no topology event, so its adapter polls that half
 * (M10/05). All three satisfy this interface, and the difference is visible only in the capability
 * declaration (`pushTopologyEvents` / `pushPaneEvents`), where a caller can read it and widen its
 * own cadence — never in the semantics.
 *
 * Ordering: callbacks may COALESCE (two changes, one call) but must not REORDER a change before the
 * call that reports the state preceding it. `onDown` fires at most once; `close()` is idempotent.
 */
export interface MuxWatchOptions {
  /** Panes whose content/status to watch. Empty = topology only. */
  readonly panes: readonly string[];
  /** Something about the pane/tab/space structure changed. Re-read the snapshot. */
  onTopologyChange(): void;
  /** This pane's content or status changed. Re-read it. */
  onPaneChange(paneId: string): void;
  /** The watch is live. */
  onUp(): void;
  /** The watch ended, for any reason, exactly once. Reconnect/backoff belong to the caller. */
  onDown(reason: string): void;
}

/** The handle a watch hands back. `close()` is idempotent. */
export interface MuxSubscription {
  close(): void;
}

// ── The port ──────────────────────────────────────────────────────────────────

/**
 * One multiplexer, behind Collie's contract.
 *
 * Every method that a multiplexer may not have returns {@link MuxOutcome} and answers `unsupported`
 * with the capability it needs. The two that do not — {@link reachable} and {@link snapshot} — are
 * the floor: an adapter that cannot answer them is not an adapter.
 *
 * The methods are host-local by rule. Nothing here takes a host, and nothing here may grow one: a
 * remote machine is reached by talking to the Collie that runs on it, never by dialling its
 * multiplexer across a machine boundary (ADR 0011).
 */
export interface MuxAdapter {
  /** Registry key of the multiplexer behind this adapter. For display and support, never a branch. */
  readonly mux: string;
  /** What this adapter can do. Declared, never inferred from {@link mux}. */
  readonly capabilities: MuxCapabilityDeclaration;

  /**
   * This multiplexer's mark, as SVG source — the bytes served at `/api/mux/logo.svg`.
   *
   * SUPPLIED BY THE ADAPTER, exactly like {@link capabilities} and for the same reason: the phone
   * prints what arrives and recognises nothing, so a picture keyed by name in `web/src` would
   * re-weld the app to one multiplexer just as surely as a name branch would
   * (scripts/check-mux-names.sh). Every adapter in this build ships one in its own `logo.ts`.
   *
   * OPTIONAL, and absent is a real answer: an adapter with no mark publishes no `logoUrl`, and the
   * header renders exactly the text it rendered before this field existed. Nothing downstream may
   * substitute a placeholder for it.
   */
  readonly logo?: string;

  /** Is the multiplexer answering? Drives the connected/disconnected banner. */
  reachable(): Promise<boolean>;

  /** Every pane, space and tab of the configured target. The floor. */
  snapshot(): Promise<MuxSnapshot>;

  /** One pane's rendered screen. Needs `paneGrid`; `recent` past the viewport needs `gridScrollback`. */
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;

  /** Type literal text into a pane, submitting nothing. Needs `typeText`. */
  typeText(paneId: string, text: string): Promise<MuxAck>;

  /**
   * Send keys in the contract's neutral spelling (keys.ts), applied in order. Needs `sendKeys`.
   *
   * A key the multiplexer cannot send is `refused` and is listed in `unsupportedKeys` — the whole
   * door is not closed because one key is missing.
   */
  sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck>;

  /** Set or clear a pane's operator label (`null` clears). Needs `renamePane`. */
  renamePane(paneId: string, label: string | null): Promise<MuxAck>;

  /** Close a pane, ending what runs in it. Needs `closePane`. */
  closePane(paneId: string): Promise<MuxAck>;

  /**
   * Show this pane in the OPERATOR's terminal — after it resolves, {@link MuxPane.focused} is this
   * pane. Needs `setFocus`.
   *
   * The one place the phone may move a human's screen, and it exists only behind a named tap ("Show
   * in terminal"). Nothing else in the bridge or the web app may call it: navigating on the phone
   * must never drag the desktop along ([ADR 0031](../../.adr/)).
   *
   * The promise is the WHOLE act. A multiplexer that can bring the pane's tab forward but cannot say
   * which pane inside it ends up focused declares this ABSENT — a half-kept promise silently shows a
   * neighbouring pane, which is the "degrade rather than lie" failure conformance exists to catch
   * (zellij is exactly that case; see MUX_CONTRACT.md).
   *
   * A pane that has gone away answers `gone`, like every other pane-addressed call.
   */
  setFocus(paneId: string): Promise<MuxAck>;

  /** New tab in a space, opening a fresh shell. Needs `createTab`. */
  createTab(request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>>;

  /** Set a tab's label. Needs `renameTab`. */
  renameTab(tabId: string, label: string): Promise<MuxAck>;

  /** Close a tab and every pane in it. Needs `closeTab`. */
  closeTab(tabId: string): Promise<MuxAck>;

  /** New space, opening a fresh shell. Needs `createSpace`. */
  createSpace(request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>>;

  /** Watch for change. Always available — an adapter with no push satisfies it by polling. */
  watch(options: MuxWatchOptions): MuxSubscription;
}

/**
 * The adapter's plain DATA fields, carried across a decorator unchanged.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES IN EACH WRAPPER. Both decorators (beacon/decorate.ts,
 * beacon/hint.ts) rebuild the adapter as an object literal that names every field — they cannot
 * spread it, because an adapter written as a class keeps its methods on a prototype. That shape has
 * one failure mode and it is silent: a new field on {@link MuxAdapter} is simply not mentioned, so
 * it survives every test that talks to a raw adapter and vanishes the moment the real bridge wraps
 * one. `logo` did exactly that, on all three live instances, while the unit tests stayed green.
 *
 * So the data fields are gathered HERE, once, and each decorator spreads the result. Adding a field
 * to the contract is then one edit in this file rather than three that nothing forces you to make —
 * and `decorate.test.ts`'s surface tripwire fails if the next one is added anywhere else.
 *
 * Methods stay out of it deliberately: a decorator delegating a verb is a decision it makes verb by
 * verb (it may wrap one), whereas data has nothing to decide.
 *
 * The field is OMITTED rather than set to `undefined` when the adapter has none, so
 * `"logo" in adapter` keeps answering the same question after wrapping as before it.
 */
export function muxDataFields(adapter: MuxAdapter): Pick<MuxAdapter, "logo"> {
  return adapter.logo === undefined ? {} : { logo: adapter.logo };
}
