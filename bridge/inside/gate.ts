// Whether this bridge opens the inside socket (M99, decision 12 "opt-in").
//
// `collie link <harness>` (spec 09) owns the on and off: the wire is on while at least one harness is
// linked on this machine (a link record, `bridge/inside/links.ts`). The setting `COLLIE_INSIDE`
// (`inside` in `[bridge]`) stays as an override: `off` is the kill switch whatever is linked, `on`
// opens the wire with no link (a test, a leg). Off means: no socket, no `inside` field in the hook
// target file, no part can bind, and every send, ask and wake keeps the screen path unchanged.
//
// It also needs the hook edges (the placement runs on their targets) and a platform with Unix
// sockets the bridge can own: Windows keeps the screen path in 1.29.0 (decision 15).
//
// A link made while the bridge runs reaches it with no restart: the bridge reads the records again
// every LINK_READ_MS and opens the socket once one is there. An unlink turns the data road off at the
// next read; the socket stays until the bridge stops, and a part on it changes nothing.

/** How often the bridge reads the link records again. One folder listing each time. */
export const LINK_READ_MS = 15_000;

/** What the gate reads. */
export interface InsideGateInput {
  /** `Config.inside`: the operator's override, or null when unset. */
  readonly setting: boolean | null;
  /** Whether a harness is linked now. */
  readonly linked: boolean;
  /** Whether the bridge routes hook edges (the placement needs their targets). */
  readonly edges: boolean;
  /** `process.platform`. */
  readonly platform: string;
}

/** Why the socket is closed, or `open`. Logged at boot. `unlinked`: no harness is linked yet. */
export type InsideGate = "open" | "off" | "unlinked" | "no-edges" | "platform";

/** Whether the wire is on, before the platform and the edges: the override, else a link. Pure. */
export function insideWanted(setting: boolean | null, linked: boolean): boolean {
  return setting ?? linked;
}

/** The gate. Pure. */
export function insideGate(input: InsideGateInput): InsideGate {
  if (input.setting === false) return "off";
  if (input.platform === "win32") return "platform";
  if (!input.edges) return "no-edges";
  return insideWanted(input.setting, input.linked) ? "open" : "unlinked";
}

/** A cached read of "is a harness linked", fresh at most every `ms`. */
export function linkReader(read: () => boolean, now: () => number = Date.now, ms: number = LINK_READ_MS): () => boolean {
  let at = Number.NEGATIVE_INFINITY;
  let value = false;
  return () => {
    const t = now();
    if (t - at >= ms) {
      at = t;
      try {
        value = read();
      } catch {
        value = false;
      }
    }
    return value;
  };
}
