// What the islands of ONE pane page share (S3). The static shell's pane screen is one component, and
// its setup closure ties the screen, the composer, the sheets and the header's ⋮ together. In an islands
// document those are separate islands (screen, composer, sheets, header-actions): they meet here, in
// module state, which every island of the page shares (the chunks Vite splits share one instance of
// each module).
//
// THE SCREEN ISLAND OWNS IT. `screen` (islands/screen.tsx) opens the controller for its pane in setup
// and closes it when it leaves; every other island reads `paneController.get()` and finds `null` while
// no pane is on screen. What the screen derives from the read (the card, the terminal's draft, the
// write gate, the write target) it publishes after each commit, and the others subscribe to the
// controller's `state` store, never to the screen.
import type { Scope } from "@web/lib/scope";
import type { AgentView } from "@web/lib/types";

import type { Find } from "../lib/find";
import { createStore, type Store } from "../lib/store";
import type { WriteTarget } from "../routes/pane/answer";
import type { DialogCard } from "../routes/pane/cards";
import type { WriteGate } from "../routes/pane/data";
import { SheetPeek } from "../ui/sheet";

/** What the screen read off the pane, published after each of its commits. */
export interface PaneView {
  pane: AgentView | undefined;
  card: DialogCard | null;
  dialogOwns: boolean;
  rawDraft: string | null;
  /** `screenToken` of the read on screen ("" for a blank screen). */
  token: string;
  gate: WriteGate;
  readOnly: boolean;
  /** Every pane of the herd (agents and shells), for the switcher and the actions sheet. */
  herd: readonly AgentView[];
  /** The pane's own `cwd` is known: the belt offers Changes. */
  changes: boolean;
  /** History can open (a session and a log). */
  history: boolean;
  zenAvailable: boolean;
  /** Find and Copy output have text to work on. */
  hasText: boolean;
}

/** The page's own state that more than one island moves. */
export interface PaneUi {
  zen: boolean;
  /** The composer's field has focus (the strips fold for its keyboard). */
  composerFocused: boolean;
  /** Bumped on every send: the Terminal jumps to its tail. */
  tailRev: number;
}

/** The screen's own acts, handed to the sheets and the header (registered by the screen island). */
export interface PaneActs {
  openFind(): Promise<void>;
  copyOutput(): Promise<void>;
  enterZen(): void;
  leaveZen(): void;
  goToPane(pane: AgentView): void;
  goUp(): void;
}

export interface PaneController {
  paneId: string;
  scope: Scope;
  /** The `paneScopeKey`: the pane store's key. */
  key: string;
  view: Store<PaneView | null>;
  ui: Store<PaneUi>;
  find: Find;
  peek: SheetPeek;
  acts: PaneActs;
  target(): WriteTarget;
}

const NOOP_ACTS: PaneActs = {
  openFind: () => Promise.resolve(),
  copyOutput: () => Promise.resolve(),
  enterZen: () => {},
  leaveZen: () => {},
  goToPane: () => {},
  goUp: () => {},
};

/** The controller of the pane on screen, or null on the dashboard. */
export const paneController = createStore<PaneController | null>(null);

/** Open the controller for a pane (the screen island's setup). Returns it; `signal` closes it. */
export function openPaneController(
  init: { paneId: string; scope: Scope; key: string; find: Find; target: () => WriteTarget },
  signal: AbortSignal,
): PaneController {
  const controller: PaneController = {
    ...init,
    view: createStore<PaneView | null>(null),
    ui: createStore<PaneUi>({ zen: false, composerFocused: false, tailRev: 0 }),
    peek: new SheetPeek(),
    acts: { ...NOOP_ACTS },
  };
  paneController.set(controller);
  // Zen takes the header out: the header is server HTML, so the class goes on `<html>`, which every
  // document keeps across a soft navigation (`data-rmx-preserve-attrs="class style"`).
  const zen = (): void => {
    document.documentElement.classList.toggle("zen", controller.ui.get().zen);
  };
  controller.ui.subscribe(zen, signal);
  signal.addEventListener(
    "abort",
    () => {
      if (paneController.get() === controller) paneController.set(null);
      document.documentElement.classList.remove("zen");
    },
    { once: true },
  );
  return controller;
}

/** The send landed: the Terminal follows the tail again. */
export function noteSent(controller: PaneController): void {
  controller.ui.update((ui) => ({ ...ui, tailRev: ui.tailRev + 1 }));
}
