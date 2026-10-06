// The composer's direct-terminal mode, as a controller with no framework (web/src/hooks/
// use-direct-typing.ts and use-ordered-key-sender.ts): while it is armed, what you type goes to the
// pane as keystrokes with no trailing Enter, and the textarea never holds a draft.
//
// How it is wired (the lead's composer):
//   - one controller per composer instance, built in setup with the instance's `handle.signal`. A pane
//     switch is an unmount (REMIX3.md rule 3), so the abort IS web's "reset on a new paneKey".
//   - while `active`, the textarea forwards `beforeinput`, `input`, `compositionstart`,
//     `compositionend` and `keydown` to the matching `on...` method below. While not active every
//     method is a no-op, so a forwarding handler can stay mounted.
//   - the textarea stays uncontrolled (REMIX3.md, "Forms, inputs and the composer"). The controller
//     clears the field itself after it has sent what was typed, and leaves it alone mid-composition.
//   - `onChange` fires on every change of `active` or `busy`, from timers and promises too, so it
//     must be routed through `scheduleUpdate`.
//
// Arming is an explicit, named choice (the "Type" toggle), never a gesture: this is the one write path
// with no reviewable payload, and what stands in for review is that you are LOOKING at the pane.
// Hence the mode dies with that view: a hidden tab, an idle pause (the lead calls `disarm()`), a
// pane switch (the signal), a failed batch. It is never persisted and never restored.
//
// Two deliberate omissions, as in web/: no connection check (a lost bridge shows as a failed batch,
// which already disarms), and no reply-guard pre-flight (typing into an unrecognised screen is the
// whole point). Do not "harden" the path with either.
import { t } from "@web/lib/i18n";
import { textToKeySequence } from "@web/lib/key-queue";

import { realTimers, type KeyTimers } from "./keys-tray";

// ── Pure parts ─────────────────────────────────────────────────────────────────────────────────────

// A Map, not an object literal: the lookup key is whatever `KeyboardEvent.key` says, and an object
// would answer for inherited names ("constructor") with something that is not a wire key.
const SPECIAL_KEYS = new Map([
  ["Escape", "Escape"],
  ["Tab", "Tab"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
]);

/** Android's virtual Backspace and Enter arrive as `beforeinput` with no useful keydown. */
export function keyForInputType(inputType: string): string | null {
  if (inputType === "deleteContentBackward") return "Backspace";
  if (inputType === "insertLineBreak" || inputType === "insertParagraph") return "Enter";
  return null;
}

/** Keys that change no textarea value still need wire names. Printable text arrives via `input`. */
export function keyForKeyDown(key: string): string | undefined {
  if (key === "Backspace") return "Backspace";
  if (key === "Enter") return "Enter";
  return SPECIAL_KEYS.get(key);
}

/**
 * Drop the part of `next` that a finished IME composition already sent. Gboard can follow
 * `compositionend` with one ordinary input carrying the same word: sending it twice would double a
 * swipe. Any suffix typed in the same event (often the auto-inserted space) is kept.
 */
export function withoutCommitted(next: string, committed: string): string {
  return next.startsWith(committed) ? next.slice(committed.length) : next;
}

/** One request never carries more than this many keys; the rest waits behind it, in order. */
export const MAX_BATCH = 64;

export interface OrderedKeySender {
  /** Queue keys. The first leaves at once; later ones ride the next batch. */
  enqueue(keys: readonly string[]): void;
  /** Forget what has not left yet. A call already on the wire cannot be recalled. */
  reset(): void;
  /** Stop for good: nothing queued leaves, nothing reports afterwards. */
  dispose(): void;
  /** A batch is in flight. */
  readonly busy: boolean;
}

/**
 * Serialise bursts of keys through Herdr's one-shot RPC. Ordering is guaranteed inside one
 * `send_keys` array and not across concurrent connections, so one batch stays in flight while later
 * input accumulates into the next. This is backpressure, not a typing delay: the first key leaves at
 * once, and a slow round trip only makes the next batch bigger. A failed batch stops everything and
 * drops what had not left: the target's input state is unknown, so never resume blind.
 */
export function createOrderedKeySender(
  send: (keys: string[]) => Promise<boolean>,
  onFailure: () => void,
  onBusy: () => void = () => {},
): OrderedKeySender {
  let pending: string[] = [];
  let inFlight = false;
  let generation = 0;
  let disposed = false;

  const pump = (): void => {
    if (inFlight || pending.length === 0) return;
    const batch = pending.splice(0, MAX_BATCH);
    const mine = generation;
    inFlight = true;
    void (async () => {
      try {
        let ok = false;
        try {
          ok = await send(batch);
        } catch {
          // A thrown transport failure stops the same way a false answer does.
        }
        if (!ok && mine === generation && !disposed) {
          pending = [];
          generation += 1;
          onFailure();
        }
      } finally {
        inFlight = false;
        if (pending.length > 0) pump();
        else if (!disposed) onBusy();
      }
    })();
  };

  return {
    enqueue(keys) {
      if (keys.length === 0 || disposed) return;
      pending.push(...keys);
      if (!inFlight) onBusy();
      pump();
    },
    reset() {
      generation += 1;
      pending = [];
      if (!inFlight && !disposed) onBusy();
    },
    dispose() {
      disposed = true;
      generation += 1;
      pending = [];
    },
    get busy() {
      return inFlight || pending.length > 0;
    },
  };
}

// ── The controller ─────────────────────────────────────────────────────────────────────────────────

/** The textarea, as far as the controller touches it. */
export interface FieldLike {
  focus(): void;
  blur(): void;
}

/** The part of `document` the controller listens to. */
export interface VisibilitySource extends EventTarget {
  readonly visibilityState: string;
}

type Tone = "info" | "success";

export interface DirectTypingOptions {
  /** Sends keys as ONE call and resolves true when the bridge took them. */
  send: (keys: string[]) => Promise<boolean>;
  /** The composer instance's signal. Its abort disarms silently and ends every timer and listener. */
  signal: AbortSignal;
  /** `active` or `busy` changed. May come from a timer or a promise: route it through `scheduleUpdate`. */
  onChange?: () => void;
  /** The pane takes keys at all (a write gate). Default: yes. */
  canActivate?: () => boolean;
  /**
   * The durable reply draft, read AT the moment of arming and never captured. The password-prompt
   * handoff clears the draft and arms in the same tick: a value captured at render would still be the
   * secret and would refuse the very remedy being offered.
   */
  replyDraft?: () => string;
  /** The composer textarea, for the keyboard: focused on arm, blurred after an unasked disarm. */
  field?: () => FieldLike | null | undefined;
  /** After a deliberate disarm: put the caret back in the draft. */
  focusInput?: () => void;
  /** After a successful arm, before the focus (web's `onActivate`). */
  onActivate?: () => void;
  /** The status channel. The text is already translated. */
  notify?: (text: string, tone: Tone) => void;
  timers?: KeyTimers;
  /** Default: the page's `document`. */
  visibility?: VisibilitySource;
}

/** Why the mode ended. `stopped` is the Stop button, `interrupted` the view going stale. */
export type DisarmKind = "stopped" | "interrupted" | "silent";

/** What the field's events need from an event. A DOM event with `currentTarget` fits. */
export interface FieldEvent {
  currentTarget: { value: string } | null;
  isComposing?: boolean;
  data?: string | null;
}

export interface BeforeInputEvent {
  inputType: string;
  isComposing: boolean;
  preventDefault(): void;
}

export interface KeyDownEvent {
  key: string;
  preventDefault(): void;
}

export interface DirectTyping {
  /** Armed. */
  readonly active: boolean;
  /** Keys are still on their way (a batch in flight or queued). */
  readonly busy: boolean;
  /**
   * Arm. Refused (false) when the pane takes no keys or a reply draft is waiting: a buffered reply
   * and live keystrokes cannot share one field, so the draft stays put and the status says so.
   */
  arm(): boolean;
  /**
   * End the mode. The Stop button passes "stopped" (says so), the idle lock and other stale views the
   * default "interrupted" (says so), a send that already reset the field "silent". No-op when idle.
   */
  disarm(kind?: DisarmKind): void;
  onBeforeInput(event: BeforeInputEvent): void;
  onInput(event: FieldEvent): void;
  onCompositionStart(): void;
  onCompositionEnd(event: FieldEvent): void;
  onKeyDown(event: KeyDownEvent): void;
}

function clearField(event: FieldEvent): void {
  if (event.currentTarget !== null) event.currentTarget.value = "";
}

export function createDirectTyping(opts: DirectTypingOptions): DirectTyping {
  const timers = opts.timers ?? realTimers;
  let active = false;
  let backgrounded = false;
  let composing = false;
  let committed: string | null = null;
  let pendingBlur: number | null = null;
  let disposed = false;

  const changed = (): void => {
    if (!disposed) opts.onChange?.();
  };
  const say = (text: string, tone: Tone): void => {
    if (!disposed) opts.notify?.(text, tone);
  };

  const sender = createOrderedKeySender(
    opts.send,
    () => {
      // A failed batch makes the target's state unknown: end the mode, and put the phone keyboard
      // away too, or continued typing silently becomes a buffered Reply with an Enter on its end.
      resetMode();
      dropKeyboard();
    },
    changed,
  );

  const cancelPendingBlur = (): void => {
    if (pendingBlur === null) return;
    timers.clearTimeout(pendingBlur);
    pendingBlur = null;
  };

  /**
   * Put the phone keyboard away after a disarm nobody asked for. Deferred, because a focus already
   * queued behind a synchronous blur would undo it. Ownership is settled by cancellation: a re-arm
   * and the abort cancel a pending blur first, so an old disarm never reaches a newer session.
   */
  function dropKeyboard(): void {
    cancelPendingBlur();
    pendingBlur = timers.setTimeout(() => {
      pendingBlur = null;
      opts.field?.()?.blur();
    }, 0);
  }

  /** Disarm and forget the transient state. Leaves the field and its focus alone. */
  function resetMode(): void {
    composing = false;
    committed = null;
    if (!active) return;
    active = false;
    changed();
  }

  // A hidden document ends the mode, but the notice has to come on the way BACK: a status set while
  // hidden is gone before anyone can read it, and the confusing failure is a still-focused field
  // whose next characters land in the reply draft instead of the terminal. Mounted for the whole
  // life of the controller, not keyed on `active`: hiding is what disarms, so a listener tied to
  // `active` would tear itself down in the same turn and nobody would report the return trip.
  const source: VisibilitySource | undefined =
    opts.visibility ?? globalThis.document;
  const onVisibility = (): void => {
    if (source === undefined) return;
    if (source.visibilityState === "hidden") {
      if (!active) return;
      backgrounded = true;
      resetMode();
      // Away with the keyboard too: a primed field outlasts the notice, and typing into it is
      // exactly the mistake the notice warns about.
      dropKeyboard();
      return;
    }
    if (!backgrounded) return;
    backgrounded = false;
    say(t("directTyping.status.backgrounded"), "info");
  };
  source?.addEventListener("visibilitychange", onVisibility, { signal: opts.signal });

  opts.signal.addEventListener(
    "abort",
    () => {
      disposed = true;
      active = false;
      composing = false;
      committed = null;
      cancelPendingBlur();
      sender.dispose();
    },
    { once: true },
  );

  return {
    get active() {
      return active;
    },
    get busy() {
      return sender.busy;
    },

    arm() {
      if (disposed || opts.canActivate?.() === false) return false;
      if ((opts.replyDraft?.() ?? "").length > 0) {
        say(t("directTyping.status.draftPending"), "info");
        return false;
      }
      opts.onActivate?.();
      // A new session owns the field: a blur still pending belongs to an older one.
      cancelPendingBlur();
      composing = false;
      committed = null;
      backgrounded = false;
      active = true;
      changed();
      say(t("directTyping.status.armed"), "success");
      // Focus synchronously, while the tap still carries user activation: a deferred focus selects
      // the field but a phone may refuse to raise its keyboard.
      opts.field?.()?.focus();
      opts.focusInput?.();
      return true;
    },

    disarm(kind = "interrupted") {
      if (!active) return;
      resetMode();
      opts.focusInput?.();
      if (kind === "stopped") say(t("directTyping.status.disarmed"), "info");
      else if (kind === "interrupted") say(t("directTyping.status.interrupted"), "info");
    },

    // Android virtual Backspace and Enter can arrive as `beforeinput` with no useful keydown.
    onBeforeInput(event) {
      if (!active) return;
      const key = keyForInputType(event.inputType);
      if (key === null) return;
      // Backspace inside an active IME edits the candidate. Enter commits and must still reach the
      // terminal: Gboard commonly marks that insertParagraph as composing.
      if (event.isComposing && key === "Backspace") return;
      event.preventDefault();
      sender.enqueue([key]);
    },

    onInput(event) {
      if (!active || event.currentTarget === null) return;
      if (event.isComposing === true || composing) return;
      const next = event.currentTarget.value;
      if (committed !== null) {
        const sent = committed;
        committed = null;
        const rest = withoutCommitted(next, sent);
        if (rest.length > 0) sender.enqueue(textToKeySequence(rest));
        clearField(event);
        return;
      }
      if (next.length === 0) return;
      sender.enqueue(textToKeySequence(next));
      clearField(event);
    },

    onCompositionStart() {
      if (!active) return;
      composing = true;
      committed = null;
    },

    onCompositionEnd(event) {
      if (!active) return;
      composing = false;
      const text = event.currentTarget?.value || event.data || "";
      if (text.length === 0) return;
      committed = text;
      sender.enqueue(textToKeySequence(text));
      clearField(event);
    },

    onKeyDown(event) {
      if (!active) return;
      const key = keyForKeyDown(event.key);
      if (key === undefined) return;
      event.preventDefault();
      sender.enqueue([key]);
    },
  };
}
