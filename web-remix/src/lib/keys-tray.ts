// The Keys tray's logic, with no DOM and no Remix (web/'s use-key-queue.ts, use-pending-confirm.ts,
// use-action-echo.ts and use-hold-repeat.ts, as plain objects). `composer/keys-tray.tsx` draws it;
// `keys-tray.test.ts` drives every piece here with a hand-cranked clock.
//
// Each object keeps its own state and calls the `onChange` it was given after a change. The owner
// decides how to wake its component: a handler may update at once, a timer or a promise goes through
// `scheduleUpdate` (REMIX3.md rule 1). Nothing here updates anything itself.
//
// Composition rules (web's `useKeyQueue`):
//   - Shift, Ctrl and Alt are checkboxes. Each cycles off, once, locked, off, on its own.
//   - Any armed modifier, or any queued key, makes the tray "composing". A press then STAGES (the
//     key, composed with the armed modifiers, joins the queue) instead of firing.
//   - A staged press spends every `once` modifier. A `locked` one stays armed, across presses and
//     across a Send, until it is cycled off or Clear drops everything.
//   - `take()` hands the whole queue back as ONE array, for ONE send call: Herdr guarantees the
//     order inside one `send_keys` array and not across calls.
import { composeKey, MODIFIER_ORDER, nextModMode, normalizeBaseChar } from "@web/lib/key-queue";
import type { Modifier, ModMode } from "@web/lib/key-queue";

export type { Modifier, ModMode };

// ── Timers ─────────────────────────────────────────────────────────────────────────────────────────

/** The two timer calls everything below needs. A test passes a fake clock. */
export interface KeyTimers {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const realTimers: KeyTimers = {
  setTimeout: (fn, ms) => Number(globalThis.setTimeout(fn, ms)),
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

// ── The queue and the modifiers ────────────────────────────────────────────────────────────────────

/** The mode of each of the three modifiers. */
export interface ModState {
  readonly ctrl: ModMode;
  readonly alt: ModMode;
  readonly shift: ModMode;
}

const ALL_OFF: ModState = { ctrl: "off", alt: "off", shift: "off" };

/** What `press` decided: fire these keys now, or the keys went onto the queue. */
export type PressResult = { mode: "fire"; keys: string[] } | { mode: "queued" };

/** What a preset tap decided: as `PressResult`, plus "this danger chord needs its second tap". */
export type PresetResult = PressResult | { mode: "confirm" };

/** Every `once` modifier is spent; `locked` stays. The whole point of locking. */
function settleMods(cur: ModState): ModState {
  return {
    ctrl: cur.ctrl === "once" ? "off" : cur.ctrl,
    alt: cur.alt === "once" ? "off" : cur.alt,
    shift: cur.shift === "once" ? "off" : cur.shift,
  };
}

export class KeyQueue {
  #queue: readonly string[] = [];
  #mods: ModState = ALL_OFF;
  readonly #onChange: () => void;

  constructor(onChange: () => void = () => {}) {
    this.#onChange = onChange;
  }

  /** The staged keys. A new array after every change, so an identity check sees it. */
  get queue(): readonly string[] {
    return this.#queue;
  }

  get mods(): ModState {
    return this.#mods;
  }

  /** The armed modifiers in canonical order: what `composeKey` and the strip's ghost chip read. */
  get activeMods(): Modifier[] {
    return MODIFIER_ORDER.filter((m) => this.#mods[m] !== "off");
  }

  /** A modifier is armed or a key is staged: presses stage instead of firing. */
  get composing(): boolean {
    return this.#queue.length > 0 || this.activeMods.length > 0;
  }

  /** One tap on a modifier: off, once, locked, off. The other two are left alone. */
  arm(m: Modifier): void {
    this.#mods = { ...this.#mods, [m]: nextModMode(this.#mods[m]) };
    this.#onChange();
  }

  /** Fire immediately when idle; stage (composed with the armed modifiers, then settle) when not. */
  press(keys: readonly string[]): PressResult {
    if (!this.composing) return { mode: "fire", keys: [...keys] };
    const mods = this.activeMods;
    this.#queue = [...this.#queue, ...keys.map((k) => composeKey(mods, k))];
    this.#mods = settleMods(this.#mods);
    this.#onChange();
    return { mode: "queued" };
  }

  /** The one-char input: the last printable ASCII char, composed with the armed modifiers, staged. */
  pushBase(raw: string): boolean {
    const base = normalizeBaseChar(raw);
    if (base === null) return false;
    this.#queue = [...this.#queue, composeKey(this.activeMods, base)];
    this.#mods = settleMods(this.#mods);
    this.#onChange();
    return true;
  }

  removeAt(index: number): void {
    if (index < 0 || index >= this.#queue.length) return;
    this.#queue = this.#queue.filter((_, i) => i !== index);
    this.#onChange();
  }

  /** The one escape hatch: drop the queue and release every modifier, `locked` ones too. */
  clear(): void {
    if (this.#queue.length === 0 && !this.composing) return;
    this.#queue = [];
    this.#mods = ALL_OFF;
    this.#onChange();
  }

  /** The whole queue as one array for one send. Spends `once`, keeps `locked`. */
  take(): string[] {
    const taken = [...this.#queue];
    this.#queue = [];
    this.#mods = settleMods(this.#mods);
    this.#onChange();
    return taken;
  }
}

// ── The two-tap confirm ────────────────────────────────────────────────────────────────────────────

/** Armed ids disarm after this long (web's `usePendingConfirm`). */
export const CONFIRM_MS = 3000;

export interface PendingConfirm {
  /** The armed id, or null. */
  readonly pending: string | null;
  /** True when `id` was already armed (the confirming tap). The first tap arms it and returns false. */
  confirm(id: string): boolean;
  reset(): void;
  dispose(): void;
}

export function createPendingConfirm(
  timers: KeyTimers,
  onChange: () => void,
  ms: number = CONFIRM_MS,
): PendingConfirm {
  let pending: string | null = null;
  let timer: number | null = null;
  const stop = (): void => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
  };
  const reset = (): void => {
    stop();
    if (pending === null) return;
    pending = null;
    onChange();
  };
  return {
    get pending() {
      return pending;
    },
    confirm(id) {
      if (pending === id) {
        reset();
        return true;
      }
      stop();
      pending = id;
      timer = timers.setTimeout(() => {
        timer = null;
        pending = null;
        onChange();
      }, ms);
      onChange();
      return false;
    },
    reset,
    dispose: stop,
  };
}

/** A preset button's shape (`CtrlDef` of web/src/lib/operator-keys.ts, kept structural). */
export interface PresetLike {
  label: string;
  keys: readonly string[];
  danger?: boolean;
}

/**
 * A tap on a Ctrl preset. Composing: it stages (the Send review is the confirm, so no second tap).
 * Idle: a danger chord (`ctrl+d`, `ctrl+z`) arms the two-tap first and fires on the second.
 */
export function pressPreset(queue: KeyQueue, confirm: PendingConfirm, item: PresetLike): PresetResult {
  if (!queue.composing && item.danger === true && !confirm.confirm(item.label)) return { mode: "confirm" };
  return queue.press(item.keys);
}

/** The strip's Send: the whole queue as one array, and any stray confirm dropped. Empty means skip. */
export function takeForSend(queue: KeyQueue, confirm: PendingConfirm): string[] {
  const keys = queue.take();
  confirm.reset();
  return keys;
}

// ── The press echo ─────────────────────────────────────────────────────────────────────────────────

/** How long the check holds after a successful press (web's `ECHO_DONE_MS`). */
export const ECHO_DONE_MS = 700;

/** `pending` in flight, `done` the check flash, `idle` resting (a failed press lands here too: the
 *  error belongs to the status channel, not to a second surface on the key). */
export type EchoPhase = "idle" | "pending" | "done";

export interface EchoOptions {
  doneMs?: number;
  /** A haptic tick, on the press and not on the check. */
  onPress?: () => void;
}

export interface ActionEcho {
  phaseOf(id: string): EchoPhase;
  /** Run one press under the echo. `action` resolves true when the bridge took it. Never throws. */
  run(id: string, action: () => Promise<boolean>): Promise<void>;
  dispose(): void;
}

export function createActionEcho(timers: KeyTimers, onChange: () => void, options: EchoOptions = {}): ActionEcho {
  const doneMs = options.doneMs ?? ECHO_DONE_MS;
  // Sparse: only a non-idle key has an entry.
  const phases = new Map<string, EchoPhase>();
  const clocks = new Map<string, number>();
  let disposed = false;

  const set = (id: string, phase: EchoPhase): void => {
    if (phase === "idle") {
      if (!phases.delete(id)) return;
    } else {
      if (phases.get(id) === phase) return;
      phases.set(id, phase);
    }
    onChange();
  };

  return {
    phaseOf: (id) => phases.get(id) ?? "idle",
    async run(id, action) {
      // A second press of the same key restarts its own cycle; a stale check must not cut it short.
      const running = clocks.get(id);
      if (running !== undefined) {
        timers.clearTimeout(running);
        clocks.delete(id);
      }
      set(id, "pending");
      options.onPress?.();
      let ok = false;
      try {
        ok = await action();
      } catch {
        ok = false;
      }
      if (disposed) return;
      if (!ok) {
        set(id, "idle");
        return;
      }
      set(id, "done");
      clocks.set(
        id,
        timers.setTimeout(() => {
          clocks.delete(id);
          if (!disposed) set(id, "idle");
        }, doneMs),
      );
    },
    dispose() {
      disposed = true;
      for (const id of clocks.values()) timers.clearTimeout(id);
      clocks.clear();
      phases.clear();
    },
  };
}

// ── Hold to repeat ─────────────────────────────────────────────────────────────────────────────────
//
// A ONE-IN-FLIGHT PUMP, not a fixed-cadence emitter, and that is a correctness rule: Herdr's RPC is
// one-shot, so ordering across two concurrent `send_keys` calls is not guaranteed, only inside one
// array. Repeats pile up locally and leave as one array whenever the previous call has answered. A
// slow tailnet therefore makes bigger batches, never more calls.

/** A hold must outlast this before repeat engages; shorter is an ordinary tap. */
export const HOLD_DELAY_MS = 350;
/** The local accumulator's beat once engaged. The network paces the sends, not this. */
export const REPEAT_MS = 90;
/** One flushed array never carries more than this many keys. */
export const MAX_BATCH = 25;
/** Dead-man: if a pointerup is lost, the repeat still stops. */
export const MAX_HOLD_MS = 4_000;

export interface HoldRepeatOptions {
  /** Read at pointerdown. False means no repeat (pass "not composing and not disabled"). */
  enabled?: () => boolean;
  /** `holding` or `count` changed. Fires on every tick: route it through `scheduleUpdate`. */
  onChange?: () => void;
  /** The hold engaged: one haptic tick, never one per repeat. */
  onEngage?: () => void;
}

export interface HoldRepeat {
  /** The key being held (repeat engaged), or null. */
  readonly holding: string | null;
  /** Repeats counted for this hold: the "x12" readout. */
  readonly count: number;
  pointerDown(key: string): void;
  pointerUp(): void;
  pointerCancel(): void;
  /** Call from the button's click. True means a hold just ended and this click is its echo: swallow it. */
  consumeClick(): boolean;
  dispose(): void;
}

/**
 * @param send Sends the keys as ONE call and resolves when the bridge has answered. A falsy answer
 *             stops the hold: a refused key must not keep hammering.
 */
export function createHoldRepeat(
  send: (keys: string[]) => Promise<boolean>,
  timers: KeyTimers = realTimers,
  options: HoldRepeatOptions = {},
): HoldRepeat {
  let engageTimer: number | null = null;
  let tickTimer: number | null = null;
  let deadman: number | null = null;
  let heldKey: string | null = null;
  let pending = 0;
  let inFlight = false;
  // Set once a hold engages, so the click the release synthesizes is swallowed.
  let engaged = false;
  let disposed = false;
  let holding: string | null = null;
  let count = 0;

  const changed = (): void => {
    if (!disposed) options.onChange?.();
  };

  const clearEngage = (): void => {
    if (engageTimer !== null) timers.clearTimeout(engageTimer);
    engageTimer = null;
  };
  const stopTimers = (): void => {
    clearEngage();
    if (tickTimer !== null) timers.clearTimeout(tickTimer);
    if (deadman !== null) timers.clearTimeout(deadman);
    tickTimer = null;
    deadman = null;
  };

  // Drain the accumulator, one call at a time. Each completion pumps again: a hold self-clocks to
  // whatever the network is doing.
  const pump = (): void => {
    if (inFlight || pending === 0 || heldKey === null) return;
    const key = heldKey;
    const n = Math.min(pending, MAX_BATCH);
    pending -= n;
    inFlight = true;
    void (async () => {
      try {
        let ok = false;
        try {
          ok = await send(Array<string>(n).fill(key));
        } catch {
          ok = false;
        }
        if (!ok) {
          // A refused key means the pane takes no input: stop.
          pending = 0;
          heldKey = null;
          stopTimers();
          if (holding !== null) {
            holding = null;
            count = 0;
            changed();
          }
        }
      } finally {
        inFlight = false;
        if (!disposed) pump();
      }
    })();
  };

  // End the hold: stop counting, flush the remainder, drop the visual state. `heldKey` stays until
  // the pump drains, so the trailing flush still knows its key.
  const release = (): void => {
    stopTimers();
    if (heldKey !== null) pump();
    if (pending === 0) heldKey = null;
    holding = null;
    count = 0;
    changed();
  };

  const scheduleTick = (): void => {
    tickTimer = timers.setTimeout(() => {
      pending += 1;
      count += 1;
      changed();
      pump();
      if (tickTimer !== null) scheduleTick();
    }, REPEAT_MS);
  };

  const engage = (key: string): void => {
    engageTimer = null;
    engaged = true;
    heldKey = key;
    pending = 1;
    holding = key;
    count = 1;
    options.onEngage?.();
    changed();
    pump();
    scheduleTick();
    deadman = timers.setTimeout(release, MAX_HOLD_MS);
  };

  const lift = (): void => {
    clearEngage();
    if (engaged) release();
  };

  return {
    get holding() {
      return holding;
    },
    get count() {
      return count;
    },
    pointerDown(key) {
      engaged = false;
      if (disposed || options.enabled?.() === false) return;
      clearEngage();
      engageTimer = timers.setTimeout(() => engage(key), HOLD_DELAY_MS);
    },
    pointerUp: lift,
    pointerCancel: lift,
    consumeClick() {
      if (!engaged) return false;
      engaged = false;
      return true;
    },
    dispose() {
      disposed = true;
      stopTimers();
      heldKey = null;
      pending = 0;
    },
  };
}
