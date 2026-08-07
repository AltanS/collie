import { envBool } from "../config.ts";
import { deriveMode, type Enrollment, type ModeResolution } from "./mode.ts";
import type { PackMode } from "../types.ts";

// Mode-scoped configuration: the settings that only mean anything once this collie is in a pack.
//
// This deliberately does NOT live on `Config` in bridge/config.ts, and the reason is the zero-tax
// contract rather than taste. PACK_PROTOCOL.md §11 promises a solo instance "no new env key" and no
// new configuration surface; `bridge/solo-baseline.test.ts` enforces exactly that by pinning
// `keyof Config` and the `COLLIE_*` literals `config.ts` names. A pack key on `Config` would be a
// key every solo deployment carries, reads and can typo — so pack settings live behind the mode,
// parsed in the same env-pure style (the reader itself is imported from config.ts, not re-written).
//
// Solo resolves this whole module from `null` + an env with none of these keys set, and gets a
// value that changes nothing.

/** The federation-shaped runtime facts, resolved once at startup, before anything is wired. */
export interface PackRuntime {
  /** This collie's role (PACK_PROTOCOL.md §3). `solo` is the default and needs no configuration. */
  readonly mode: PackMode;
  /**
   * Peer mode only: whether this peer keeps serving its own browser front door (the PWA, `/api/*`
   * and the browser gates) to its own operator.
   *
   * **Default false, and that default is the point.** §3 says a peer serves no PWA; silently leaving
   * one up as a side effect of enrollment would put a second, unaudited browser surface on the
   * tailnet that nobody chose. An operator who genuinely wants to keep browsing their peer directly
   * says so with `COLLIE_PEER_BROWSER=1` — a stated choice, made once, visible in the unit file.
   *
   * Always false outside peer mode: a lead and a solo instance serve the browser unconditionally,
   * so the flag has nothing to say about them and must never read as "the lead turned its UI off".
   */
  readonly peerServesBrowser: boolean;
  /** A one-line explanation when the enrollment state is self-contradictory; `null` when coherent. */
  readonly conflict: string | null;
}

/** Env var an operator sets on a peer to keep that peer's own browser front door. Peer mode only. */
export const PEER_BROWSER_ENV = "COLLIE_PEER_BROWSER";

/**
 * Resolve the pack runtime: a pure function of the trust store's contents and the environment, in
 * that order of authority. Mode is never read from an env var — an operator-maintained mode flag is
 * exactly the thing that drifts out of agreement with the roster (PACK_PROTOCOL.md §3).
 *
 * `enrollment` is `null` when no trust store exists, which is every solo instance. Note what does
 * *not* happen on that path: no file is opened, no key material is read or generated, no timer is
 * armed and no listener is bound. The trust store reader lands with M4/02; this function is the seam
 * it plugs into, and it is deliberately given the state rather than fetching it.
 */
export function resolvePackRuntime(
  enrollment: Enrollment | null,
  env: Record<string, string | undefined> = process.env,
): PackRuntime {
  const { mode, conflict }: ModeResolution = deriveMode(enrollment);
  return {
    mode,
    peerServesBrowser: mode === "peer" ? envBool(PEER_BROWSER_ENV, false, env) : false,
    conflict,
  };
}

/**
 * The solo runtime, spelled out once so the startup path reads as a statement rather than as a
 * `null` someone has to decode. Identical to `resolvePackRuntime(null)` and pinned as such by the
 * tests — it exists for legibility, not to short-circuit anything.
 */
export const SOLO_RUNTIME: PackRuntime = {
  mode: "solo",
  peerServesBrowser: false,
  conflict: null,
};
