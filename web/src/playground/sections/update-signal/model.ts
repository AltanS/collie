// Sample facts for the "Update signal" round: the five cases the Case switch offers, and what each
// one says. Nothing here calls the bridge.

export type SignalCase = "quiet" | "update" | "busy" | "both" | "urgent";

export const SIGNAL_CASES = [
  { value: "quiet", label: "Quiet" },
  { value: "update", label: "Update" },
  { value: "busy", label: "Busy" },
  { value: "both", label: "Both" },
  { value: "urgent", label: "Urgent" },
] as const satisfies readonly { value: SignalCase; label: string }[];

/** Which signals a case turns on. `urgent` is an update with an Urgent line in its CHANGELOG
 *  (bridge/update.ts): today's red band, and the beads stay ink for it. */
export interface Signals {
  readonly update: boolean;
  readonly busy: boolean;
  readonly urgent: boolean;
}

const SIGNALS = {
  quiet: { update: false, busy: false, urgent: false },
  update: { update: true, busy: false, urgent: false },
  busy: { update: false, busy: true, urgent: false },
  both: { update: true, busy: true, urgent: false },
  urgent: { update: true, busy: false, urgent: true },
} as const satisfies Record<SignalCase, Signals>;

export interface SignalRead {
  readonly signal: SignalCase;
  readonly signals: Signals;
}

/** The case a switch value names. A value that names none is a bug in the round, so it throws. */
export function signalsOf(value: string): SignalRead {
  const found = SIGNAL_CASES.find((c) => c.value === value);
  if (found === undefined) throw new Error(`update-signal: no case "${value}"`);
  return { signal: found.value, signals: SIGNALS[found.value] };
}

export const RELEASE = {
  version: "1.27.1",
  text: "2 fixes",
  urgentReason: "A paired device stays paired after you revoke it.",
} as const;

export const BUSY_TEXT = "bluefin: CPU above 90% for 12 min";

/** The classes that dress the mark, written out whole so Tailwind-free CSS in playground.css finds
 *  them. Three beads per signal, on different beads; the orbit turns slowly while either is on. */
export function beadClasses(signals: Signals): string | undefined {
  const ready = signals.update && !signals.urgent;
  if (!ready && !signals.busy) return undefined;
  return ["upd-beads", "upd-slow", ready ? "upd-ready" : "", signals.busy ? "upd-busy" : ""].filter(Boolean).join(" ");
}
