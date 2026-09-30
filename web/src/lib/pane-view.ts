// Which BODY a pane view draws: the terminal mirror, or the agent's own conversation.
//
// ── ONE STANDING PER-DEVICE VALUE, AND NO PER-PANE OVERRIDE ──────────────────
// This is ADR 0071's shape, the one `lib/pane-order.ts` next door already uses: a choice the
// operator makes once and finds again where settings live. It is deliberately NOT per pane. A
// per-pane override would be a thing you touch often, which would then demand a one-tap switch,
// which would demand header or belt width — and 1.9.0 spent a whole milestone clearing exactly
// that. It would also make "the default" mean two things, which matters because the recorded
// decision is a sentence about a global default: **Terminal is the default, and the default flips
// in 2.0.**
//
// ── WHY THE STORED DEFAULT IS `chat` AND THE APP'S DEFAULT IS STILL TERMINAL ─
// Two values hold this up, and they are not the same question:
//
//   * `DashPrefs.chatExperiment` — has this device opted in at all? OFF by default, written from
//     one row in Settings → Experiments. While it is off no pane draws chat and the pane menu
//     shows no switch, so a device that never opens that row is byte-identical to 1.14.
//   * `DashPrefs.paneView` — once opted in, which body? This module's value, written from one
//     place, the pane's ⋮ menu.
//
// `paneView` is never read while the experiment is off, so its default is not "what Collie shows
// you"; it is "what opting in hands you". Opting in and watching nothing happen is the failure the
// spec names by name, so opting in draws the chat at once and the ⋮ row is how you go back. The
// happy consequence: when the gate goes away in 2.0, this default IS the flip, with no second edit.

import type { JsonValue } from "./json";

export const PANE_VIEWS = ["terminal", "chat"] as const;
export type PaneView = (typeof PANE_VIEWS)[number];

/**
 * A stored value as a body; anything unknown reads as `chat`.
 *
 * `chat` rather than `terminal` for the reason in the header: this value is only consulted behind
 * the experiment gate, so "unrecognised" here means "opted in, and the stored choice is unreadable",
 * and the honest answer to that is the body opting in asked for.
 */
export function coercePaneView(raw: JsonValue | undefined): PaneView {
  return PANE_VIEWS.find((v) => v === raw) ?? "chat";
}
