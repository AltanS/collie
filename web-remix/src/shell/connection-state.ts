// The one answer to "is Collie live, in trouble, or lost", for everything that draws it: the mark's
// bloom, the connection strip, the boot splash. web/ derives it in three hooks off ONE shared clock
// (web/src/hooks/use-connection-lost.ts over web/src/lib/connection-health.ts); this is the same
// derivation without React, so a mark and a strip can never disagree.
//
// The anchor is web's `effectiveAnchor()`: the last PROVABLY LIVE moment (a snapshot or pane answer
// stamps it through `markLive`; web's own `fetchPane` already does, `loadSnapshot` does here), with a
// wake grace and a latch once the red state has shown. The thresholds are web's TROUBLE_MS (4 s,
// amber, never latches) and CONNECTION_LOST_MS (15 s, red, latches until a live poll). A long upload
// suspends both: the uplink is busy, not dead.
//
// `connecting` is poll-truth, as web's `isConnecting`: a failed snapshot, no snapshot yet, Herdr
// disconnected, or a load stalled mid-flight (lib/busy.ts, 2.5 s). `navigator.onLine` is copy only.
import { TypedEventTarget } from "remix/component";

import { CONNECTION_LOST_MS, TROUBLE_MS, effectiveAnchor, isLongUpload, latchLost, subscribeHealth } from "@web/lib/connection-health";
import { isConnecting } from "@web/lib/connection";
import type { BridgeStatus } from "@web/lib/types";

import { busy, type BusyModel } from "../lib/busy";
import { snapshot } from "../lib/data";

export interface ConnectionState {
  /** The data on screen is not live. */
  connecting: boolean;
  /** Not live for TROUBLE_MS: the mark blooms, the amber strip shows. */
  trouble: boolean;
  /** Not live for CONNECTION_LOST_MS, latched: the mark stills, the red strip shows. */
  lost: boolean;
}

export interface ConnectionInput {
  bridge: BridgeStatus | undefined;
  error: boolean;
  stalled: boolean;
  /** The shared escalation anchor, epoch ms. */
  anchor: number;
  now: number;
  uploading: boolean;
}

/** A reading together with the facts it came from, so the next threshold can be timed. */
interface Reading {
  state: ConnectionState;
  input: ConnectionInput;
}

export const LIVE: ConnectionState = { connecting: false, trouble: false, lost: false };

/** Pure: the three readings from the facts, as web's `useNotLiveFor` with `latch` aside. */
export function deriveConnection(input: ConnectionInput): ConnectionState {
  const connecting = isConnecting({ bridge: input.bridge, error: input.error, stalled: input.stalled });
  if (!connecting) return LIVE;
  const quiet = input.uploading ? Number.NEGATIVE_INFINITY : input.now - input.anchor;
  return { connecting, trouble: quiet >= TROUBLE_MS, lost: quiet >= CONNECTION_LOST_MS };
}

/** Ms until the next threshold is crossed, or null when none is pending (live, uploading, or lost). */
export function nextCrossing(input: ConnectionInput, state: ConnectionState): number | null {
  if (!state.connecting || input.uploading || state.lost) return null;
  const threshold = state.trouble ? CONNECTION_LOST_MS : TROUBLE_MS;
  return Math.max(0, threshold - (input.now - input.anchor));
}

export function sameConnection(a: ConnectionState, b: ConnectionState): boolean {
  return a.connecting === b.connecting && a.trouble === b.trouble && a.lost === b.lost;
}

/**
 * The shared reading. It listens (the snapshot, the health clock, the busy model, focus and online)
 * only while somebody is subscribed, and every listener ends with the last subscriber's signal.
 */
export class ConnectionWatch extends TypedEventTarget<{ change: Event }> {
  #state: ConnectionState = LIVE;
  #count = 0;
  #stop: (() => void) | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #model: BusyModel;

  constructor(model: BusyModel = busy) {
    super();
    this.#model = model;
    this.#state = this.#derive().state;
  }

  /** The reading now. Without a subscriber nothing keeps it fresh, so it is derived on the read. */
  get state(): ConnectionState {
    if (this.#count === 0) this.#state = this.#derive().state;
    return this.#state;
  }

  /** Call `listener` on every change until `signal` aborts. */
  subscribe(listener: () => void, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.addEventListener("change", listener, { signal });
    this.#count++;
    if (this.#count === 1) this.#start();
    signal.addEventListener(
      "abort",
      () => {
        this.#count--;
        if (this.#count === 0) this.#end();
      },
      { once: true },
    );
  }

  #derive(): Reading {
    const s = snapshot.get();
    const input: ConnectionInput = {
      bridge: s.data?.bridge,
      error: s.error !== undefined,
      stalled: this.#model.view.stalled,
      anchor: effectiveAnchor(),
      now: Date.now(),
      uploading: isLongUpload(),
    };
    return { state: deriveConnection(input), input };
  }

  #recompute = (): void => {
    const { state, input } = this.#derive();
    // The red state latches the moment a consumer sees it, so a mid-outage app switch cannot
    // downgrade it (web's `latchLost`); the call is idempotent and re-enters this method once.
    if (state.lost) latchLost();
    clearTimeout(this.#timer);
    const wait = nextCrossing(input, state);
    if (wait !== null) this.#timer = setTimeout(this.#recompute, wait + 5);
    if (sameConnection(this.#state, state)) return;
    this.#state = state;
    this.dispatchEvent(new Event("change"));
  };

  #start(): void {
    const controller = new AbortController();
    this.#stop = () => controller.abort();
    const { signal } = controller;
    snapshot.subscribe(this.#recompute, signal);
    this.#model.addEventListener("change", this.#recompute, { signal });
    const stopHealth = subscribeHealth(this.#recompute);
    signal.addEventListener("abort", stopHealth, { once: true });
    // Timers freeze while a phone sleeps; these re-measure real elapsed time on wake.
    window.addEventListener("focus", this.#recompute, { signal });
    window.addEventListener("online", this.#recompute, { signal });
    this.#recompute();
  }

  #end(): void {
    this.#stop?.();
    this.#stop = null;
    clearTimeout(this.#timer);
  }
}

/** The app's one watch. */
export const connection = new ConnectionWatch();
