// What a multiplexer adapter DECLARES it can do — the vocabulary a route asks in, so that no route
// ever asks "is this Herdr".
//
// EVERY NAME BELOW WAS DERIVED FROM A ROUTE, NOT IMAGINED. The trace is in
// {@link MUX_CAPABILITY_ROUTES} and it is part of the contract: a capability with no route behind it
// is a capability nothing can consume, and a route whose only backing is "Herdr has always done it"
// is the bug this seam exists to prevent. When a new route needs something a multiplexer might not
// have, the capability is added here WITH its route — see MUX_CONTRACT.md for the matrix.
//
// Two things are deliberately NOT capabilities:
//
//  • **The floor.** Listing panes/spaces/tabs and answering "are you reachable" are not declarable.
//    An adapter that cannot do those is not an adapter — there is nothing for Collie to render.
//  • **Image upload** (`POST /api/pane/:id/upload`). Read the route: it takes `cfg` and never the
//    multiplexer (bridge/server.ts `uploadPane`). It writes a file to the bridge host's disk and
//    hands back a path the operator pastes; the multiplexer is not involved, so it cannot decline it.
//    It is host-local for every adapter because a mux adapter is host-local by rule (ADR 0011).

/**
 * Every capability an adapter may declare, in Collie's words.
 *
 * The order is the order the matrix in MUX_CONTRACT.md reads: what you can learn about a pane,
 * what you can do to a pane, what you can do to the structure around it, and how you learn that
 * any of it changed.
 */
export const MUX_CAPABILITIES = [
  "paneGrid",
  "gridScrollback",
  "agentDetection",
  "agentSessionRef",
  "typeText",
  "sendKeys",
  "renamePane",
  "closePane",
  "createTab",
  "renameTab",
  "closeTab",
  "createSpace",
  "pushTopologyEvents",
  "pushPaneEvents",
] as const;

/** One declarable capability. */
export type MuxCapability = (typeof MUX_CAPABILITIES)[number];

/**
 * The route that consumes each capability — the evidence the set was derived rather than invented.
 *
 * Read as: "if this capability is absent, THAT is what degrades." Spec M10/06 turns each entry into
 * a UI rule (hide the meaningless, explain the expected), so keep the wording operator-legible.
 */
export const MUX_CAPABILITY_ROUTES = {
  paneGrid: "GET /api/pane/:id — the live mirror. Colour only; a rendered grid, never an emulator (ADR 0008).",
  gridScrollback:
    "GET /api/pane/:id?lines=N — a read that reaches behind the viewport, which is what makes the mirror's 'Load older' meaningful (see MuxPane.readableLines).",
  agentDetection:
    "GET /api/snapshot — the split into `agents` and `shellPanes` and the triage sort (STATUS_RANK) both need the mux to say which agent a pane holds and how it is doing.",
  agentSessionRef:
    "GET /api/pane/:id/history — the journal keys an on-disk log off the session an agent named. Without this, history is absent, not empty (bridge/journal/registry.ts).",
  typeText: "POST /api/pane/:id/reply — step one, the literal text.",
  sendKeys: "POST /api/pane/:id/reply (step two, the submit key) and POST /api/pane/:id/keys (the Keys tray).",
  renamePane: "POST /api/pane/:id/rename — set or clear a pane's operator-chosen label.",
  closePane: "POST /api/pane/:id/close — kill the pane and the agent in it.",
  createTab: "POST /api/tab — a new tab in a space, opening a fresh shell.",
  renameTab: "POST /api/tab/:id/rename.",
  closeTab: "POST /api/tab/:id/close — a bulk pane-close.",
  createSpace: "POST /api/workspace — a new space, opening a fresh shell.",
  pushTopologyEvents:
    "bridge/event-poker.ts — panes/tabs/spaces appearing, closing or being renamed arrive as a push, so the snapshot poll can idle. Absent ⇒ the adapter polls to keep the same promise, and the poker learns nothing.",
  pushPaneEvents:
    "bridge/event-poker.ts — one pane's content or status changing arrives as a push. Same fallback, same promise.",
} satisfies Record<MuxCapability, string>;

/**
 * An adapter's declaration.
 *
 * `supports` is TOTAL over {@link MUX_CAPABILITIES} — every capability is answered yes or no, so a
 * capability added later cannot read as "supported" by omission on an adapter nobody revisited.
 */
export interface MuxCapabilityDeclaration {
  readonly supports: Readonly<Record<MuxCapability, boolean>>;
  /**
   * Neutral key spellings (bridge/mux/keys.ts) this multiplexer refuses, canonicalised.
   *
   * A key is not a capability: `sendKeys` is one door, and behind it every multiplexer has its own
   * holes. Herdr's are documented and enumerated (HERDR_API.md § key grammar — the paging and edit
   * keys), so the Keys tray can grey exactly those buttons instead of discovering them by failing.
   */
  readonly unsupportedKeys: readonly string[];
  /** Per-capability operator-facing reason, shown where a control is explained rather than hidden. */
  readonly notes: Readonly<Partial<Record<MuxCapability, string>>>;
}

/** What an adapter passes to {@link declareCapabilities}. Anything omitted is declared ABSENT. */
export interface MuxCapabilityInput {
  readonly supports: readonly MuxCapability[];
  readonly unsupportedKeys?: readonly string[];
  readonly notes?: Readonly<Partial<Record<MuxCapability, string>>>;
}

/**
 * Build a total declaration from the list an adapter claims.
 *
 * Fail-closed on purpose: the default for a capability is `false`, so adding one to
 * {@link MUX_CAPABILITIES} degrades every existing adapter's UI rather than silently promising
 * behaviour none of them implement.
 */
export function declareCapabilities(input: MuxCapabilityInput): MuxCapabilityDeclaration {
  const claimed = new Set<MuxCapability>(input.supports);
  // Spelled out rather than mapped over MUX_CAPABILITIES, and that is the point: the compiler now
  // demands an answer for every capability, so adding one to the list above fails the build here
  // until someone decides what it means. A `fromEntries` map would have silently produced `false`.
  const supports = {
    paneGrid: claimed.has("paneGrid"),
    gridScrollback: claimed.has("gridScrollback"),
    agentDetection: claimed.has("agentDetection"),
    agentSessionRef: claimed.has("agentSessionRef"),
    typeText: claimed.has("typeText"),
    sendKeys: claimed.has("sendKeys"),
    renamePane: claimed.has("renamePane"),
    closePane: claimed.has("closePane"),
    createTab: claimed.has("createTab"),
    renameTab: claimed.has("renameTab"),
    closeTab: claimed.has("closeTab"),
    createSpace: claimed.has("createSpace"),
    pushTopologyEvents: claimed.has("pushTopologyEvents"),
    pushPaneEvents: claimed.has("pushPaneEvents"),
  } satisfies Record<MuxCapability, boolean>;
  return {
    supports,
    unsupportedKeys: input.unsupportedKeys ?? [],
    notes: input.notes ?? {},
  };
}

/** Whether `capability` is declared. The one question a route may ask about an adapter. */
export function supportsCapability(
  declaration: MuxCapabilityDeclaration,
  capability: MuxCapability,
): boolean {
  return declaration.supports[capability];
}

/** The declared capabilities, sorted — for the config surface (M10/06), the matrix and tests. */
export function declaredCapabilities(declaration: MuxCapabilityDeclaration): MuxCapability[] {
  return MUX_CAPABILITIES.filter((cap) => declaration.supports[cap]).toSorted();
}
