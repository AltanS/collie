import { useEffect, useSyncExternalStore } from "react";

import { getMuxConfig, loadOperatorCommands, subscribeOperatorConfig } from "@/lib/operator-config";
import type { MuxCapability, MuxConfig, MuxTopologyLatency } from "@/lib/types";

// THE ONE QUESTION THE UI MAY ASK ABOUT THE MULTIPLEXER: "can you do this?" — never "which one are
// you?" (M10/06). Every control whose backing verb an adapter may lack comes through here, and the
// answer arrives already true for whichever multiplexer is underneath, so no component learns a
// name. scripts/check-mux-names.sh keeps it that way.
//
// ── The default is CAPABLE, and that direction is deliberate ────────────────────────────────────
//
// The bridge's own declaration fails CLOSED (bridge/mux/capabilities.ts: a capability nobody
// answered for is absent), because there the risk is promising behaviour no adapter implements.
// Here the risk is the opposite one and it is worse: a phone holding a cached bundle, or talking to
// a bridge mid-upgrade, would hide controls that work perfectly. An operator whose Rename button
// vanished for the length of a page cache has no way to tell that from a bug. So: no `mux` block,
// or a block that does not mention the capability, reads as PRESENT. A capability is absent only
// when a bridge said `false` about it.
//
// The cost of that choice is bounded and visible: a control that should have been hidden is offered
// once, the call answers `unsupported`, and the operator sees a refusal instead of an explanation.
// A control that should have been offered and was hidden is invisible, and invisible is unfixable.
//
// ── Where the words come from ───────────────────────────────────────────────────────────────────
//
// An explanation's text is the ADAPTER's own note, published on /api/config. It names the
// multiplexer because the adapter's author wrote the sentence, so nothing here interpolates a name
// into a template and nothing hard-codes one. {@link muxCapability} carries the note along with the
// answer precisely so a call site never has to go looking for it — the rule is "hide what is
// meaningless, explain what is expected", and an explanation with no words is neither.
//
// ── What the UI deliberately does NOT gate, and why ─────────────────────────────────────────────
//
//  • **Image upload.** Not a mux capability at all: the route takes the bridge's own config and
//    never the multiplexer (bridge/mux/capabilities.ts says so at the top). It writes a file to the
//    bridge host's disk and hands back a path — so no adapter can decline it, and a gate here would
//    be a gate on nothing.
//  • **Notifications.** Push/VAPID, a bridge capability that predates this one and rides the same
//    config object. A multiplexer has no opinion on it.
//  • **`paneGrid`.** It is what a pane view IS. A multiplexer that cannot hand over a rendered
//    screen has no pane view to gate a control inside — the whole route is the control, and the
//    read's own `unsupported` answer is what surfaces. Gating a button on it would explain the
//    absence of a screen ON that screen.
//  • **`pushTopologyEvents` / `pushPaneEvents`.** Not controls: an adapter without them keeps the
//    same promise by polling (bridge/mux/types.ts `watch`), so nothing an operator can see changes.
//    A future cadence tuner would read them here; a button never will.

/** Stable empty list — a fresh `[]` per render would re-run every memo downstream. */
const NO_KEYS: readonly string[] = [];

/** A capability's answer, and — when it is absent — the adapter's own reason. */
export interface MuxCapabilityState {
  /** Whether the control this capability backs can work. Absent data reads as `true`. */
  readonly capable: boolean;
  /**
   * The adapter's operator-facing reason, when it is absent AND the adapter supplied one.
   *
   * Empty when the capability is present (there is nothing to explain) and when the adapter
   * declined without a note. A call site renders an explanation only when this has words: an empty
   * box saying nothing is worse than the control quietly not being there.
   */
  readonly note: string;
  /** The multiplexer's name, for display and support only. Empty until the bridge has answered. */
  readonly mux: string;
}

/**
 * Answer one capability from a config block.
 *
 * Pure, and exported for that reason: every rule above is asserted against this rather than through
 * a rendered component.
 */
export function muxCapability(cfg: MuxConfig | null, capability: MuxCapability): MuxCapabilityState {
  const mux = cfg?.name ?? "";
  // `!== false` rather than `?? true` for the same reason spelled out above, one step finer: a
  // bridge that answered `undefined` for this capability has not said no.
  const capable = cfg?.capabilities?.[capability] !== false;
  return { capable, note: capable ? "" : (cfg?.notes?.[capability] ?? ""), mux };
}

/**
 * Whether a chord may be sent, given the multiplexer's refused-key list.
 *
 * A key is NOT a capability: `sendKeys` is one door, and behind it each multiplexer has its own
 * holes (bridge/mux/capabilities.ts). Both sides spell keys in the contract's neutral alphabet, so
 * this compares the chord's BASE key — the part after the modifiers — case-insensitively. A tray
 * button whose chord is refused is greyed rather than left to fail on the wire.
 */
export function keysSendable(keys: readonly string[], unsupported: readonly string[]): boolean {
  if (unsupported.length === 0) return true;
  const refused = new Set(unsupported.map((k) => k.toLowerCase()));
  return keys.every((chord) => {
    const parts = chord.split("+");
    // `ctrl++` splits to ["ctrl","",""] — the base is the last NON-EMPTY segment, or "+" itself.
    const base = parts.at(-1) === "" ? "+" : parts.at(-1)!;
    return !refused.has(base.toLowerCase());
  });
}

/** Subscribe to the one-shot `/api/config` read, kicking it on mount like the operator-row hooks. */
function useMuxConfig(): MuxConfig | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getMuxConfig, getMuxConfig);
}

/**
 * Ask one capability. The hook every gated control uses, and the only shape it should take.
 *
 * Composes WITH the app's existing locks — it never replaces one. A capability says whether a thing
 * is possible at all; the idle pause (ADR 0007), the read-only device, the send-mode arming
 * (send-mode-menu.tsx) and the composer's `composerReady` pre-flight all still say whether it may
 * happen NOW, and every one of them still has to agree.
 */
export function useMuxCapability(capability: MuxCapability): MuxCapabilityState {
  return muxCapability(useMuxConfig(), capability);
}

/**
 * The multiplexer's display name, for the header's "on <name>" line — display only.
 *
 * The ONE read of the name the UI is allowed, and it is not the question the module header bans:
 * nothing decides anything on this string, it is simply printed. Empty until a bridge has answered
 * (older bridge, cached page, read not back yet), and a call site must render NOTHING extra when it
 * is empty rather than invent a placeholder — "on unknown" is a worse header than no line at all.
 *
 * It rides the same one-shot `/api/config` store as every capability, so this adds no request.
 */
export function useMuxName(): string {
  return useMuxConfig()?.name ?? "";
}

/**
 * Where this multiplexer's mark is served, for the header's `<img>` — or `""` when there is none.
 *
 * The SAME kind of read as {@link useMuxName} and bound by the same rule: the URL is PRINTED into a
 * `src`, never chosen. Empty whenever the bridge did not publish one — an older bridge, an adapter
 * with no mark, a cached page, a read still in flight — and an empty answer means render no image
 * at all. There is no house fallback mark, deliberately: a generic glyph beside a name would say
 * "this is what that multiplexer looks like", which would be false.
 */
export function useMuxLogoUrl(): string {
  return useMuxConfig()?.logoUrl ?? "";
}

/**
 * Whether this multiplexer can hold more than one space.
 *
 * NOT a capability, and it is worth being clear why it lives in this file anyway: it is the same
 * question in the same voice — "what is true of the multiplexer underneath?" — answered off the same
 * one-shot config, so that no component ever learns a name to decide a layout on.
 *
 * The default is `true` (many), and that is the fail-OPEN direction this module already argues for:
 * a space strip over a single space is a strip with one chip in it, while a strip hidden on a
 * multiplexer that really has three is navigation the operator cannot reach and cannot diagnose.
 */
export function useMuxHasSpaces(): boolean {
  return useMuxConfig()?.spaces !== "one";
}

/**
 * How soon this bridge sees a change the operator made in their own terminal.
 *
 * NOT a capability and not a branch on a name — a DECLARED fact, published beside them, which the
 * UI reacts to rather than measuring for itself (ADR 0031). The one thing it decides is whether the
 * header says how fresh the herd is at all: under a multiplexer that pushes there is nothing to
 * reassure anybody about, and a running "synced 2s ago" would be a clock with no reader.
 *
 * `push` is the fail-open answer for absent data, for the module header's reason one step on: a
 * bridge that has not answered has not said it is ever stale, and inventing a staleness line for it
 * would be showing the operator an anxiety the bridge never expressed.
 */
export function muxTopologyLatency(cfg: MuxConfig | null): MuxTopologyLatency {
  return cfg?.topologyLatency ?? { kind: "push" };
}

/** {@link muxTopologyLatency}, as the hook a component subscribes through. */
export function useTopologyLatency(): MuxTopologyLatency {
  return muxTopologyLatency(useMuxConfig());
}

/** The neutral key spellings this multiplexer refuses. Empty until the bridge has answered. */
export function useMuxUnsupportedKeys(): readonly string[] {
  return useMuxConfig()?.unsupportedKeys ?? NO_KEYS;
}
