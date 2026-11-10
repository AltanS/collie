// A door is an agent's own way into its live session (ADR 0141): a call that hands the session a user
// message, with no key typed into the pane. The Send Protocol tries the pane's door first and types into
// the screen only where there is none, or where the door refuses before it took the text.
//
// THE SEAM is `preflight → submit → prove` (ADR 0141 point 1):
//
//   preflight  finds the door and binds it to the pane and its session. It touches nothing. Every way it
//              can fail, a throw included, is a refusal: nothing was sent, and the screen path runs.
//   submit     hands over the text with the request id. Only a bound door has it, so no text reaches a
//              door that was not bound first. Once it was called, the text may have reached the agent:
//              a throw, a timeout or a lost answer is `uncertain`, never a refusal, so it is never typed
//              again (point 2). Only the door's own explicit refusal falls back.
//   prove      is the journal, never the door (point 4): what `submit` answers is a hint.
//
// The registry is keyed by the harness id the multiplexer reports for the pane.

/** The pane a send is for, as the bridge's snapshot names it. */
export interface DoorTarget {
  readonly session: string;
  readonly paneId: string;
  readonly harness: string;
}

/** The send a bound door is handed: the request id travels with the text, so a repeat replays. */
export interface DoorSend {
  readonly requestId: string;
  readonly text: string;
}

/**
 * What the agent answered. `taken`, `queued` and `replayed` are hints (ADR 0024): the agent says it took
 * a message, not that its log holds this text once. `refused` says the agent took nothing.
 */
export type DoorAnswer = { readonly kind: "taken" } | { readonly kind: "queued" } | { readonly kind: "replayed" } | { readonly kind: "refused"; readonly why: string };

/** A door bound to one pane and session by its preflight. */
export interface BoundDoor {
  submit(send: DoorSend, signal: AbortSignal): Promise<DoorAnswer>;
}

/** A preflight's answer: the bound door, or why there is none. */
export type Preflight = { readonly ok: true; readonly door: BoundDoor } | { readonly ok: false; readonly why: string };

export interface Door {
  /** The harness id this door serves: the receipt's `via` when it sends. */
  readonly id: string;
  preflight(target: DoorTarget, signal: AbortSignal): Promise<Preflight>;
}

/** The bridge's doors by harness id. */
export type DoorRegistry = ReadonlyMap<string, Door>;

/** A registry of `doors`; two doors for one harness is a programming error. */
export function doorRegistry(doors: readonly Door[]): DoorRegistry {
  const byId = new Map<string, Door>();
  for (const door of doors) {
    if (byId.has(door.id)) throw new Error(`two doors for harness ${door.id}`);
    byId.set(door.id, door);
  }
  return byId;
}

/**
 * One door attempt's end:
 * - `refused`: nothing reached the agent; the send goes on by the screen (ADR 0141 point 2).
 * - `submitted`: the agent answered a hint; the journal settles the send.
 * - `uncertain`: `submit` was called and gave no answer that says nothing arrived; never retyped.
 */
export type DoorTry =
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "submitted"; readonly answer: Exclude<DoorAnswer, { kind: "refused" }> }
  | { readonly kind: "uncertain"; readonly why: string };

class DoorTimeout extends Error {}

/** `work` with the signal it is given aborted and its answer a {@link DoorTimeout} after `ms`. */
async function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      control.abort();
      reject(new DoorTimeout(`no answer in ${String(ms)} ms`));
    }, Math.max(0, ms));
  });
  try {
    return await Promise.race([work(control.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Preflight then submit, inside `budgetMs` in all (the pane lock's time left). Never throws. Time spent
 * in preflight comes off submit's share. `now` is the caller's clock.
 */
export async function tryDoor(door: Door, target: DoorTarget, send: DoorSend, budgetMs: number, now: () => number = Date.now): Promise<DoorTry> {
  const start = now();
  let bound: Preflight;
  try {
    bound = await within(budgetMs, (signal) => door.preflight(target, signal));
  } catch (err) {
    return { kind: "refused", why: `preflight: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!bound.ok) return { kind: "refused", why: bound.why };
  let answer: DoorAnswer;
  try {
    answer = await within(budgetMs - (now() - start), (signal) => bound.door.submit(send, signal));
  } catch (err) {
    return { kind: "uncertain", why: `submit: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (answer.kind === "refused") return { kind: "refused", why: answer.why };
  return { kind: "submitted", answer };
}
