// The header is a CLAIM, not a child (REMIX3.md, "The header is a claim"; rule 6).
//
// web/src/components/app-header.tsx mounts one header above the outlet and lets routes portal into
// it. Remix has no portals, so the header is a model in context instead: the Shell provides one
// `HeaderModel`, the header host (`shell/header.tsx`) draws from `model.current` and re-renders on
// `change`, and a route states what it wants through an owner token:
//
//   const owner = headerOf(handle).owner(handle.signal);    // in setup; released on unmount
//   handle.queueTask(() => owner.claim({ center, right, width: "wide" }));   // in render, after commit
//
// THE RULES, each one a test in header-model.test.ts:
//   - Last claim wins. Whoever claimed most recently owns the row.
//   - A release by a stale owner does nothing. The leaving route's teardown and the arriving route's
//     claim may land in either order during one navigation; the arriving route keeps the row.
//   - The comparison is shallow (two levels: the claim's fields, then the fields of `center`, `right`
//     and `override`). A route re-rendering on every poll and claiming the same values wakes nobody.
//     So claims carry plain data and callbacks made ONCE in setup, never fresh nodes or closures.
import { TypedEventTarget } from "remix/component";
import type { RemixNode } from "remix/component";

import type { AgentStatus } from "@web/lib/types";

export type HeaderWidth = "column" | "wide" | "full";

/** The pane's identity block (web/src/components/agent-chat.tsx, the header's center). */
export interface PaneCenter {
  kind: "pane";
  /** The pane's name, or the gone line. Carries `data-glide="name"`. */
  name: string;
  /** Line 2, left: the workspace label as the multiplexer reported it. */
  workspace: string;
  /** Line 2, right: host, session and cache, already formatted; "" draws nothing. */
  meta?: string;
  status?: AgentStatus;
  /** The harness name for the 16 px tile; "" or absent draws no tile. */
  agent?: string;
  /** Tap on the name line (web/: Pane settings). */
  onName?: () => void;
  /** Tap on the workspace line (web/: the space overview). */
  onWorkspace?: () => void;
}

/**
 * Anything else: a render function made once in setup and drawn by the host. Bump `rev` when what
 * it draws changes; the render function's identity alone never does.
 */
export interface CustomSlot {
  kind: "custom";
  render: () => RemixNode;
  rev?: number | string;
}

export type HeaderCenter = PaneCenter | CustomSlot;

/** The pane's ⋮: one 44 px button; `onOpen` absent keeps the column empty (the pane is gone). */
export interface MenuRight {
  kind: "menu";
  label: string;
  onOpen?: () => void;
}

export type HeaderRight = MenuRight | CustomSlot;

/** Settings, Crew, Updates and the find bar: the route takes the whole row. */
export interface HeaderOverride {
  /** The h1. */
  title: string;
  /** A second line under the h1 (web/ Files: the workspace label and the root folder), 12 px muted. */
  subtitle?: string;
  /** The back arrow's accessible name. */
  backLabel: string;
  onBack: () => void;
  /** Extra controls after the title (the find bar's arrows), drawn by the host. */
  trailing?: CustomSlot;
}

export interface HeaderClaim {
  center?: HeaderCenter | null;
  right?: HeaderRight | null;
  override?: HeaderOverride | null;
  /** "Collie" over "on <mux>" beside the mark: dashboard and space only. */
  wordmark?: boolean;
  width?: HeaderWidth;
  /** Zen: the row leaves through Collapse; the element, its rule slot and its inset stay. */
  hidden?: boolean;
  /** The mark's tap: home from the dashboard, up from a pane (the in-app back arrow). */
  home?: (() => void) | null;
  /** The mark's accessible name when it goes up rather than home. */
  homeLabel?: string;
  /** Glide key of the identity this header shows, so a back glide can find its row. */
  glideKey?: string;
}

export interface ResolvedClaim {
  center: HeaderCenter | null;
  right: HeaderRight | null;
  override: HeaderOverride | null;
  wordmark: boolean;
  width: HeaderWidth;
  hidden: boolean;
  home: (() => void) | null;
  homeLabel: string;
  glideKey: string;
}

/** What a route gets when nobody claims the row: the bare shell, mark and floor and rule. */
export const UNCLAIMED: ResolvedClaim = {
  center: null,
  right: null,
  override: null,
  wordmark: false,
  width: "full",
  hidden: false,
  home: null,
  homeLabel: "",
  glideKey: "",
};

function resolve(claim: HeaderClaim): ResolvedClaim {
  return {
    center: claim.center ?? null,
    right: claim.right ?? null,
    override: claim.override ?? null,
    wordmark: claim.wordmark ?? false,
    width: claim.width ?? "full",
    hidden: claim.hidden ?? false,
    home: claim.home ?? null,
    homeLabel: claim.homeLabel ?? "",
    glideKey: claim.glideKey ?? "",
  };
}

/** A slot object: what a claim's `center`, `right` and `override.trailing` hold. */
export type HeaderSlot = HeaderCenter | HeaderRight;

/** Field by field, by identity. Not recursive on purpose: slots are flat data. */
export function sameSlot(a: HeaderSlot | null, b: HeaderSlot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.kind === "custom" && b.kind === "custom") return a.render === b.render && a.rev === b.rev;
  if (a.kind === "menu" && b.kind === "menu") return a.label === b.label && a.onOpen === b.onOpen;
  if (a.kind === "pane" && b.kind === "pane") {
    return (
      a.name === b.name &&
      a.workspace === b.workspace &&
      a.meta === b.meta &&
      a.status === b.status &&
      a.agent === b.agent &&
      a.onName === b.onName &&
      a.onWorkspace === b.onWorkspace
    );
  }
  return false;
}

/** Two levels: the claim's fields, and the fields of each slot object. */
export function sameClaim(a: ResolvedClaim, b: ResolvedClaim): boolean {
  return (
    a.wordmark === b.wordmark &&
    a.width === b.width &&
    a.hidden === b.hidden &&
    a.home === b.home &&
    a.homeLabel === b.homeLabel &&
    a.glideKey === b.glideKey &&
    sameSlot(a.center, b.center) &&
    sameSlot(a.right, b.right) &&
    sameOverride(a.override, b.override)
  );
}

function sameOverride(a: HeaderOverride | null, b: HeaderOverride | null): boolean {
  if (a === null || b === null) return a === b;
  return a.title === b.title && a.subtitle === b.subtitle && a.backLabel === b.backLabel && a.onBack === b.onBack && sameSlot(a.trailing ?? null, b.trailing ?? null);
}

export interface HeaderOwner {
  /** Take the row with this claim. A no-op (no `change`) when it equals what the row already shows. */
  claim(claim: HeaderClaim): void;
  /** Give the row back, if this owner still holds it. Also runs when the owner's signal aborts. */
  release(): void;
}

export class HeaderModel extends TypedEventTarget<{ change: Event }> {
  #owner: symbol | null = null;
  #claim: ResolvedClaim = UNCLAIMED;

  /** What the row shows now. The same object until a real change. */
  get current(): ResolvedClaim {
    return this.#claim;
  }

  /** Who holds the row, for tests and the dev overlay. */
  get held(): boolean {
    return this.#owner !== null;
  }

  owner(signal?: AbortSignal): HeaderOwner {
    const token = Symbol("header-owner");
    const release = (): void => {
      if (this.#owner !== token) return;
      this.#owner = null;
      this.#set(UNCLAIMED);
    };
    signal?.addEventListener("abort", release, { once: true });
    return {
      claim: (claim) => {
        if (signal?.aborted) return;
        this.#owner = token;
        this.#set(resolve(claim));
      },
      release,
    };
  }

  #set(next: ResolvedClaim): void {
    if (sameClaim(this.#claim, next)) return;
    this.#claim = next;
    this.dispatchEvent(new Event("change"));
  }
}
