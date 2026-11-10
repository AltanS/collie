// The Surface: what the bridge says about one pane's keyboard, as three claims with one authority
// each (M56 README, the shared contract; experiments/reader-stability/ARCHITECTURE.md section 1).
// This file holds the contract's types, the free rule and the one short hash the surface code uses.
// It is pure: no DOM, no Bun API, no harness name.

/** Why a claim is `unknown`. `contested` comes from a hook edge that disagrees with a young read (spec 11). */
export type SurfaceReason = "no-match" | "contested" | "stale" | "torn";

/**
 * The version of the readers that make a Surface: the fold, the cues and the lift. A lead reads a
 * member's on the crew hello (`surfaceVersion`) to show which reader a member's panes were judged by,
 * and the counters of two versions are never mixed up. Bump it in the commit that changes what a
 * screen reads as (a cue rule, a fold rule, a lift rule). A profile change is not a reader change: the
 * profile's own version range says which binary it covers.
 */
export const SURFACE_VERSION = 3;

export type AskKind = "permission" | "question" | "menu";
/**
 * How an ask is answered. `keys`: the bridge walks and confirms on the screen through the key gate.
 * `hook`: a hook holds the ask and answers it (spec 12). `program`: a program session answers it on
 * its own channel by the program's ask id, and no key is sent (spec 14).
 */
export const ASK_CHANNELS = ["hook", "keys", "program"] as const;
export type AskChannel = (typeof ASK_CHANNELS)[number];

/** One option of an ask: a stable id within the ask and the label the screen shows. */
export interface AskOption {
  readonly id: string;
  readonly label: string;
}

/**
 * A dialog the bridge can answer. In spec 04 the ask is only lifted and shown; ids become single use
 * and answers go through the key gate in spec 08.
 */
export interface Ask {
  readonly id: string;
  readonly kind: AskKind;
  readonly options: readonly AskOption[];
  readonly channel: AskChannel;
  /** A short hash over the kind and the dialog's own signature (option labels in order included). */
  readonly hash: string;
}

export type SurfaceTurn = "idle" | "running" | "unknown";
export type SurfaceModal = "none" | { readonly ask: Ask } | "unreadable" | "unknown";
export type SurfaceComposer = "empty" | "draft" | "unreachable" | "unknown";

export interface Surface {
  /** The revision of the screen read this Surface came from. */
  readonly revision: number;
  readonly turn: SurfaceTurn;
  readonly modal: SurfaceModal;
  readonly composer: SurfaceComposer;
  readonly reason?: SurfaceReason;
  /**
   * A request proved that the input box this read shows does not take keys: a probe character typed
   * there showed up elsewhere or nowhere, and a second read showed the same rows (2026-10-25). The image is a
   * stale one of an earlier layout, so its composer claim is a reading, not the box. Set by the bridge
   * on the reads that show the same box rows as the proven one, and gone at the first read that differs.
   */
  readonly staleFrame?: true;
}

/**
 * The name of the rows an input box stands on, for "the same stale image again": a short hash of the
 * rows from the box's top edge to its bottom edge, trailing blanks cut. The Send Protocol names the box
 * it proved stale with it, and the bridge's Surface compares each later read's box with that name.
 */
export function frameImageKey(texts: readonly string[], top: number, bottom: number): string {
  return shortHash(texts.slice(top, bottom + 1).map((text) => text.trimEnd()).join("\n"));
}

/** The free rule: the turn is idle, no modal is up and the composer is empty. Nothing else is free. */
export function isFree(surface: Surface): boolean {
  return surface.turn === "idle" && surface.modal === "none" && surface.composer === "empty";
}

/** The ask a modal claim carries, or null when the claim is one of the three words. */
export function askOf(modal: SurfaceModal): Ask | null {
  return modal === "none" || modal === "unreadable" || modal === "unknown" ? null : modal.ask;
}

/** The modal claim as one word: `none`, `ask`, `unreadable` or `unknown`. For logs and counters. */
export function modalWord(modal: SurfaceModal): "none" | "ask" | "unreadable" | "unknown" {
  return modal === "none" || modal === "unreadable" || modal === "unknown" ? modal : "ask";
}

/**
 * A short, stable hash of a text: 53 bits of cyrb53, as 14 hex digits. Not a secret and not a
 * checksum against an attacker, only a name for "the same rows" in a log line or an ask.
 */
export function shortHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(16).padStart(14, "0");
}
