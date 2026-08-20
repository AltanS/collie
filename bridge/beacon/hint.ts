// THE HINT TIER — the ONE module in the tree that turns a process name into anything (M11/05).
//
// A pane whose foreground command looks like a harness may carry a SENTENCE. That is the whole
// feature, and every constraint on it is about what it must not become:
//
//  • It sets no identity — not the pane's agent, not its status, not the session ref an agent named.
//    The reasoning is `bridge/mux/types.ts` § `MuxPane.agent`, cited rather than restated, and it is
//    why the port answers `"shell"` instead of guessing from a process name.
//  • It arms no grammar, keys no journal adapter and never enters the triage sort. A hinted pane is
//    a shell of unknown standing that has a sentence attached to it.
//  • What reaches the phone is finished English — no harness name, no multiplexer name — so
//    `web/src` learns nothing new and renders text it does not interpret.
//
// ── WHY THE MATCHING IS HERE AND THE FIELD IS THERE ──────────────────────────────────────────────
//
// The adapter reports the raw fact it already holds (`MuxPane.foregroundCommand`); this module is
// the only reader of it, and a repo-level grep proves that. Put the matching in the adapters and
// every adapter re-invents it; put the sentence in the frontend and the names cross the boundary.
//
// ── SUPPRESSION IS THE FEATURE, NOT A TRIMMING ───────────────────────────────────────────────────
//
// Three conditions each retire the sentence, and each for its own reason (see {@link paneHint}). A
// hint on a pane that already has identity is not extra context — it is Collie asking for something
// it has.

import { KNOWN_HARNESS_NAMES } from "../journal/registry.ts";
import type {
  MuxAck,
  MuxAdapter,
  MuxCapabilityDeclaration,
  MuxCreatedPane,
  MuxGrid,
  MuxGridRequest,
  MuxOutcome,
  MuxPane,
  MuxSnapshot,
  MuxSpaceRequest,
  MuxSubscription,
  MuxTabRequest,
  MuxWatchOptions,
} from "../mux/types.ts";

/**
 * The sentence, and it is the whole vocabulary this module emits.
 *
 * "may be" is exact rather than modest: the evidence is a foreground process name, which is what
 * `MuxPane.agent` refuses to call an identity. It names the remedy without naming the harness or
 * the multiplexer, because either name would be a guess arriving on the phone as a fact.
 */
export const AGENT_HINT =
  "This pane may be running an agent. Install Collie's hooks on the host to identify it.";

/** What the port calls a pane holding no agent — `bridge/state-engine.ts`'s `SHELL`, one word. */
const SHELL = "shell";

/** What the hint needs to know about the world the pane came from. */
export interface HintContext {
  /**
   * Does this adapter report agents from its own wire, or through a join that is already live?
   *
   * True suppresses every hint: there is real identity here, so a sentence asking for it is noise.
   * Herdr is always in this case, and so is a decorated tmux/zellij once the emitter is installed.
   */
  readonly agentDetection: boolean;
  /**
   * Are the emitter's hooks installed on this host?
   *
   * True suppresses the hint separately from {@link agentDetection}, because the sentence's remedy
   * is already done. A pane with the hooks installed and nothing to show has an agent that has not
   * spoken yet — or no agent at all — and "install the hooks" is then simply wrong.
   */
  readonly hooksInstalled: boolean;
}

/** The command's base name, lower-cased — `/usr/local/bin/claude --resume` ⇒ `claude`. */
function commandName(raw: string): string {
  const argv0 = raw.trim().split(/\s+/u)[0] ?? "";
  const base = argv0.split("/").pop() ?? "";
  return base.toLowerCase();
}

/**
 * The sentence for this pane, or null.
 *
 * Null in every case but one, and the order below is the argument: the host first (an adapter that
 * sees, or a host that already installed the emitter), then this pane's own identity (a pane the
 * port already named needs nothing), then the evidence — a foreground command whose base name is a
 * harness this build knows about. The name list is the journal registry's own, derived from the
 * adapters, so it cannot drift into a second definition of "a harness".
 */
export function paneHint(pane: MuxPane, ctx: HintContext): string | null {
  // 1. The adapter sees agents — Herdr, and a decorated adapter whose capabilities were lifted.
  if (ctx.agentDetection) return null;
  // 2. The remedy is already done on this host.
  if (ctx.hooksInstalled) return null;
  // 3. This pane has an identity from somewhere. Real identity always outranks a guess.
  if (pane.agent !== SHELL) return null;
  const name = commandName(pane.foregroundCommand ?? "");
  if (name === "" || !KNOWN_HARNESS_NAMES.includes(name)) return null;
  return AGENT_HINT;
}

/** One pane with its sentence attached, or the pane exactly as it arrived. */
export function withPaneHint(pane: MuxPane, ctx: HintContext): MuxPane {
  const hint = paneHint(pane, ctx);
  // Assigned onto a copy, never conditionally spread: a pane with no sentence keeps the field
  // ABSENT, which is the rule every adapter in this tree follows for optional `MuxPane` fields.
  return hint === null ? pane : { ...pane, hint };
}

/** What the wrapper needs besides the adapter: the host's own answer about the emitter. */
export interface AgentHintDeps {
  /** Is the emitter installed for at least one harness? The same probe the decorator is gated on. */
  hooksInstalled(): boolean;
}

/**
 * `adapter`, with a sentence on the panes that look like they might hold an agent.
 *
 * WRAPPED OUTSIDE THE BEACON DECORATOR, deliberately: the declaration it reads is then the decorated
 * one, so an adapter whose capabilities were lifted by an installed emitter announces `agentDetection`
 * and this wrapper suppresses itself without needing to know that beacons exist. Two of the three
 * suppression rules fall out of that placement; the third is asked for explicitly, so wrapping a raw
 * adapter directly is still correct.
 *
 * It touches ONE thing — the panes coming out of `snapshot()`. Every other method is delegated
 * verbatim (never spread: an adapter written as a class keeps its methods on a prototype), and the
 * capability declaration is passed through untouched, because a sentence can never be a capability.
 */
export function withAgentHints(adapter: MuxAdapter, deps: AgentHintDeps): MuxAdapter {
  return {
    mux: adapter.mux,
    // A getter, because the wrapped declaration is itself one — the decorator re-reads the emitter's
    // install per request, and freezing the answer here would undo that.
    get capabilities(): MuxCapabilityDeclaration {
      return adapter.capabilities;
    },

    reachable: (): Promise<boolean> => adapter.reachable(),

    async snapshot(): Promise<MuxSnapshot> {
      const snapshot = await adapter.snapshot();
      const ctx: HintContext = {
        agentDetection: adapter.capabilities.supports.agentDetection,
        hooksInstalled: deps.hooksInstalled(),
      };
      // Read once per snapshot rather than per pane, and never cached across snapshots: that is what
      // keeps `collie hooks install claude` live on a running bridge, exactly as the decorator is.
      return { ...snapshot, panes: snapshot.panes.map((pane) => withPaneHint(pane, ctx)) };
    },

    // ── Everything below is the wrapped adapter's, verbatim ────────────────────
    readGrid: (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> =>
      adapter.readGrid(paneId, request),
    typeText: (paneId: string, txt: string): Promise<MuxAck> => adapter.typeText(paneId, txt),
    sendKeys: (paneId: string, keys: readonly string[]): Promise<MuxAck> => adapter.sendKeys(paneId, keys),
    renamePane: (paneId: string, label: string | null): Promise<MuxAck> => adapter.renamePane(paneId, label),
    closePane: (paneId: string): Promise<MuxAck> => adapter.closePane(paneId),
    createTab: (request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> => adapter.createTab(request),
    renameTab: (tabId: string, label: string): Promise<MuxAck> => adapter.renameTab(tabId, label),
    closeTab: (tabId: string): Promise<MuxAck> => adapter.closeTab(tabId),
    createSpace: (request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> => adapter.createSpace(request),
    watch: (options: MuxWatchOptions): MuxSubscription => adapter.watch(options),
  };
}
