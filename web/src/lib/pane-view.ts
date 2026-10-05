// Which BODY a pane view draws: the terminal mirror, or the agent's own conversation.
//
// ── ONE STANDING PER-DEVICE VALUE, AND NO PER-PANE OVERRIDE ──────────────────
// This is ADR 0071's shape, the one `lib/pane-order.ts` next door already uses: a choice the
// operator makes once and finds again where settings live. It is deliberately NOT per pane. A
// per-pane override would be a thing you touch often, which would then demand a one-tap switch,
// which would demand header or belt width — and 1.9.0 spent a whole milestone clearing exactly
// that.
//
// ── CHAT IS THE DEFAULT (1.17.0, ADR 0082) ───────────────────────────────────
// Until 1.16 this value sat behind an opt-in (`chatExperiment`, Settings → Experiments) and the
// recorded decision was "Terminal is the default, and the default flips in 2.0". It flipped in
// 1.17.0 instead, and the gate is gone: this value alone says which body a pane with a session
// draws, and its default IS the flip. A device that had chosen the terminal keeps it. A stored
// `chatExperiment` is ignored on load, whatever it holds (hooks/use-dash-prefs.ts).

import type { JsonValue } from "./json";

export const PANE_VIEWS = ["terminal", "chat"] as const;
export type PaneView = (typeof PANE_VIEWS)[number];

/** A stored value as a body; anything unknown reads as `chat`, the default (ADR 0082). */
export function coercePaneView(raw: JsonValue | undefined): PaneView {
  return PANE_VIEWS.find((v) => v === raw) ?? "chat";
}
