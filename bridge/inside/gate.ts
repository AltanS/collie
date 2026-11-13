// Whether this bridge opens the inside socket (M99, decision 12 "opt-in").
//
// The socket opens only when the operator turned the inside wire on for this instance. Until
// `collie link` (spec 09) exists, the one switch is the config setting `COLLIE_INSIDE` (`inside` in
// `[bridge]`), off by default; that spec adds "a harness is linked" as the second way in, and the
// setting set to off stays the kill switch. Off means: no socket, no `inside` field in the hook
// target file, no part can bind, and every send, ask and wake keeps the screen path unchanged.
//
// It also needs the hook edges (the placement runs on their targets) and a platform with Unix
// sockets the bridge can own: Windows keeps the screen path in 1.29.0 (decision 15).

/** What the gate reads. */
export interface InsideGateInput {
  /** `Config.inside`: the operator's switch. */
  readonly setting: boolean;
  /** Whether the bridge routes hook edges (the placement needs their targets). */
  readonly edges: boolean;
  /** `process.platform`. */
  readonly platform: string;
}

/** Why the socket is closed, or `open`. Logged once at boot. */
export type InsideGate = "open" | "off" | "no-edges" | "platform";

/** The gate. Pure. */
export function insideGate(input: InsideGateInput): InsideGate {
  if (!input.setting) return "off";
  if (input.platform === "win32") return "platform";
  return input.edges ? "open" : "no-edges";
}
