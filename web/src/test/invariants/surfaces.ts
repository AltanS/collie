// Every Surface (M102 spec 15, part 1a): the full product of the Surface's fields, from the type in
// lib/surface/surface.ts. The generated suites run each one through the bridge's gates and the phone's
// send slot. A field the type gains must be added here, or the product misses it: the guard test in
// send-slot.invariants.test.ts compares the axes with the closed lists the product reads.
//
// Pure: no DOM, no Bun API.

import { ASK_CHANNELS, askOf, type Ask, type AskChannel, type AskKind, type Surface, type SurfaceComposer, type SurfaceModal, type SurfaceReason, type SurfaceTurn } from "../../lib/surface/surface";
import { product } from "./seed";

export const TURNS: readonly SurfaceTurn[] = ["idle", "running", "unknown"];
export const ASK_KINDS: readonly AskKind[] = ["permission", "question", "menu"];
export const COMPOSERS: readonly SurfaceComposer[] = ["empty", "draft", "unreachable", "unknown"];
/** `undefined` is a Surface with no reason. */
export const REASONS: readonly (SurfaceReason | undefined)[] = [undefined, "no-match", "contested", "stale", "torn"];
export const FIELDS: readonly ("secret" | undefined)[] = [undefined, "secret"];
export const STALE_FRAMES: readonly (true | undefined)[] = [undefined, true];

/** An ask of one kind on one channel, with two options, the way a reader lifts a Yes/No dialog. */
export function askOfKind(kind: AskKind, channel: AskChannel): Ask {
  return {
    id: `ask-${kind}-${channel}`,
    kind,
    channel,
    options: [
      { id: "1", label: "Yes" },
      { id: "2", label: "No" },
    ],
    hash: `h-${kind}-${channel}`,
  };
}

/** Every modal claim: the three words and one ask per kind and channel. */
export const MODALS: readonly SurfaceModal[] = ["none", "unreadable", "unknown", ...ASK_KINDS.flatMap((kind) => ASK_CHANNELS.map((channel) => ({ ask: askOfKind(kind, channel) })))];

/** One generated Surface and the name a failure prints for it. */
export interface SurfaceCase {
  readonly id: string;
  readonly surface: Surface;
}

function modalId(modal: SurfaceModal): string {
  const ask = askOf(modal);
  return ask === null ? String(modal) : `ask:${ask.kind}:${ask.channel}`;
}

/** The name of a Surface in a failure message: every field, in a fixed order. */
export function surfaceId(surface: Surface): string {
  return [
    `turn=${surface.turn}`,
    `modal=${modalId(surface.modal)}`,
    `composer=${surface.composer}`,
    `reason=${surface.reason ?? "-"}`,
    `field=${surface.field ?? "-"}`,
    `staleFrame=${surface.staleFrame === true ? "1" : "-"}`,
  ].join(" ");
}

/** The full product: 3 turns x 12 modals x 4 composers x 5 reasons x 2 fields x 2 stale frames = 2880 Surfaces. */
export function allSurfaces(revision = 7): readonly SurfaceCase[] {
  return product({ turn: TURNS, modal: MODALS, composer: COMPOSERS, reason: REASONS, field: FIELDS, staleFrame: STALE_FRAMES }).map((axes) => {
    let surface: Surface = { revision, turn: axes.turn, modal: axes.modal, composer: axes.composer };
    if (axes.reason !== undefined) surface = { ...surface, reason: axes.reason };
    if (axes.field !== undefined) surface = { ...surface, field: axes.field };
    if (axes.staleFrame !== undefined) surface = { ...surface, staleFrame: axes.staleFrame };
    return { id: surfaceId(surface), surface };
  });
}

/** A Surface whose box is a known sign-in field: the secret path owns it, not the override (spec 12 decision 2). */
export function isSecret(surface: Surface): boolean {
  return surface.field === "secret";
}

/** A Surface where Collie READ a question or a permission: hard stop 6a, the card answers it (spec 12 decision 2). */
export function isReadAsk(surface: Surface): boolean {
  return askOf(surface.modal) !== null;
}

/** The Surfaces I4 holds on: not a known secret and not a read ask. */
export function overrideReaches(surface: Surface): boolean {
  return !isSecret(surface) && !isReadAsk(surface);
}
