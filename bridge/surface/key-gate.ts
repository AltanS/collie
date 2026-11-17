// The key gate (M56 spec 05): the only way a named key leaves the bridge. Every caller that sends
// keys into a pane goes through `gateFor(mux)`, and the gate is the only caller of the adapter's
// `writeKeys` (a test in key-gate.test.ts greps for any other). Literal text is a separate call and
// never passes here; a line break inside a send is the profile's newline key, so it does.
//
// Two doors, one counter:
//  - `press`: a person's tap (the Keys board, a dialog button, the direct typing mode) and the old
//    reply route's submit. No revision check: the gate refuses a stale protocol token, never a person.
//  - `mint` then `commit`: the Send Protocol, and an Ask answer (M56 spec 08). A token names the
//    allowed keys, the read revision it was taken on, its origin and a 150 ms lifetime. `commit`
//    refuses a token that is spent, unknown or older than its lifetime (`stale_token`) and one whose
//    revision is not the newest (`stale_surface`). An Ask answer is a person's tap bound to the read
//    the bridge checked it on: its token carries origin `person_tap`, and only it may carry Escape
//    (a Cancel the person chose).
//
// The revision here is the gate's own, per pane: it moves on every read the protocol notes and on
// every write that reaches the pane through the bridge (a key from either door, a text write the
// protocol notes). So a tap on the Keys board between the protocol's last read and its Enter makes the
// token stale, and the Enter is not sent. The multiplexer's revision cannot serve here: Herdr answers
// every visible read with revision 0.
//
// Escape is never cleanup: a protocol token cannot carry it. A person may press it.

import { muxRefused, type MuxAck, type MuxAdapter, type MuxRefusalOutcome } from "../mux/types.ts";
import { PANE_BUSY, type PaneLockFiles } from "./pane-lock.ts";

/** How long a protocol token lives, in ms. */
export const TOKEN_LIFETIME_MS = 150;

/** How long a person's press may hold the machine-wide pane lock (pane-lock.ts): one key call's bound. */
export const PRESS_SPAN_MS = 10_000;
/** How long a person's tap waits for a pane another bridge writes into (M102 spec 16): then refused, or a Stop goes anyway. */
export const LOCK_WAIT_MS = 1_500;
/** The pause between two tries at that pane's lock. */
export const LOCK_POLL_MS = 50;

/** Who is sending. `protocol` is the Send Protocol; the other two never meet a revision check. */
export type KeyOrigin = "person_tap" | "legacy_reply" | "protocol";

/** How many key sends each origin made through one gate. */
export interface KeySendCounts {
  person_tap: number;
  legacy_reply: number;
  protocol: number;
}

/** Who may hold a token: the Send Protocol, or a person's tap on an ask the bridge answers. */
export type TokenOrigin = "protocol" | "person_tap";

/** A token: the keys it allows, the revision it was minted on, its origin, and when it dies. */
export interface KeyToken {
  readonly id: number;
  readonly paneId: string;
  readonly keys: readonly string[];
  readonly revision: number;
  readonly origin: TokenOrigin;
  readonly expiresAt: number;
}

export type GateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "stale_token" | "stale_surface"; readonly detail: string }
  | { readonly ok: false; readonly reason: "mux"; readonly refusal: MuxRefusalOutcome };

/** What the gate needs of a multiplexer: the one raw key call. */
export type KeyWriter = Pick<MuxAdapter, "writeKeys">;

const ESCAPE = /^(?:escape|esc)$/iu;

export class KeyGate {
  private readonly revisions = new Map<string, number>();
  private readonly live = new Map<number, KeyToken>();
  private readonly sends: KeySendCounts = { person_tap: 0, legacy_reply: 0, protocol: 0 };
  private nextId = 1;
  private nextHold = 1;
  /** The machine-wide pane lock (M102 spec 16), once the bridge shares one ({@link share}). */
  private paneLock: Pick<PaneLockFiles, "take" | "release"> | null = null;

  constructor(
    private readonly mux: KeyWriter,
    private readonly now: () => number = () => Date.now(),
    /** The pause between two tries at a pane another bridge holds ({@link hold}); a test hands in its own. */
    private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Share the machine-wide pane lock (M102 spec 16): from here on a person's press and every {@link hold}
   * take it for their span, so another bridge's send on the pane refuses them, and they refuse it. A
   * press inside this bridge's own send joins that send's hold, as a person's key always could.
   */
  share(lock: Pick<PaneLockFiles, "take" | "release">): void {
    this.paneLock = lock;
  }

  /**
   * Run `work` holding the pane's machine-wide lock for at most `spanMs`. While another bridge holds it,
   * wait up to {@link LOCK_WAIT_MS} (tries {@link LOCK_POLL_MS} apart), then answer `busy()` with no write
   * at all. A free pane, or one this bridge already holds, costs no wait. With no shared lock, `work` runs as before.
   */
  async hold<T>(paneId: string, spanMs: number, work: () => Promise<T>, busy: () => T): Promise<T> {
    // The first try is synchronous: a free pane writes in the same turn as before (a person's key still
    // moves the gate's revision at once, so a token minted before it is stale).
    const now = this.takeNow(paneId, spanMs);
    const owner = now === false ? await this.takeWaiting(paneId, spanMs) : now;
    if (owner === false) return busy();
    try {
      return await work();
    } finally {
      if (owner !== null) this.paneLock?.release(paneId, owner);
    }
  }

  /**
   * A person's Stop (M102 spec 16, ADR 0116 addendum): the safety control is never refused for the shared
   * lock. It waits for it as {@link hold} does; when another bridge still holds the pane after the wait, the
   * key goes out anyway and `bypassed` says so, for the route's record. Inside this bridge it is a press, as before.
   */
  async pressAlways(paneId: string, keys: readonly string[]): Promise<{ readonly ack: MuxAck; readonly bypassed: boolean }> {
    const now = this.takeNow(paneId, PRESS_SPAN_MS);
    const owner = now === false ? await this.takeWaiting(paneId, PRESS_SPAN_MS) : now;
    try {
      this.bump(paneId);
      this.sends.person_tap++;
      return { ack: await this.mux.writeKeys(paneId, keys), bypassed: owner === false };
    } finally {
      if (owner !== null && owner !== false) this.paneLock?.release(paneId, owner);
    }
  }

  /** One try, now: the new owner's name, null with no shared lock, false while another bridge holds the pane. */
  private takeNow(paneId: string, spanMs: number): string | null | false {
    const lock = this.paneLock;
    if (lock === null) return null;
    const owner = `gate-${String(this.nextHold++)}`;
    return lock.take(paneId, owner, this.now() + spanMs) ? owner : false;
  }

  /** Further tries {@link LOCK_POLL_MS} apart for {@link LOCK_WAIT_MS}: the owner's name, or false when another bridge kept the pane. */
  private async takeWaiting(paneId: string, spanMs: number): Promise<string | null | false> {
    for (let attempt = 0; attempt < LOCK_WAIT_MS / LOCK_POLL_MS; attempt++) {
      await this.pause(LOCK_POLL_MS);
      const owner = this.takeNow(paneId, spanMs);
      if (owner !== false) return owner;
    }
    return false;
  }

  /** The pane's newest revision as the gate counts it. */
  revision(paneId: string): number {
    return this.revisions.get(paneId) ?? 0;
  }

  private bump(paneId: string): number {
    const next = this.revision(paneId) + 1;
    this.revisions.set(paneId, next);
    return next;
  }

  /** A read was taken: the newest revision moves, so a token minted on an older read is stale. */
  noteRead(paneId: string): number {
    return this.bump(paneId);
  }

  /** Text reached the pane outside the gate (a protocol write): the screen moved. */
  noteWrite(paneId: string): number {
    return this.bump(paneId);
  }

  /**
   * A token: these keys, on this revision, for 150 ms. Throws on an empty key list, and on Escape in
   * a protocol token, because Escape is never cleanup. A person's ask answer may carry it.
   */
  mint(paneId: string, keys: readonly string[], revision: number, origin: TokenOrigin = "protocol"): KeyToken {
    if (keys.length === 0) throw new Error("a key token needs at least one key");
    if (origin === "protocol" && keys.some((key) => ESCAPE.test(key))) throw new Error("a protocol token never carries Escape");
    const token: KeyToken = { id: this.nextId++, paneId, keys: [...keys], revision, origin, expiresAt: this.now() + TOKEN_LIFETIME_MS };
    this.live.set(token.id, token);
    return token;
  }

  /** Send a token's keys. A token is spent by its first `commit`, sent or refused. */
  async commit(token: KeyToken): Promise<GateResult> {
    const known = this.live.get(token.id);
    this.live.delete(token.id);
    if (known === undefined || known !== token) return { ok: false, reason: "stale_token", detail: "the token is spent or was never minted here" };
    if (this.now() > token.expiresAt) return { ok: false, reason: "stale_token", detail: `the token is older than ${String(TOKEN_LIFETIME_MS)} ms` };
    if (this.revision(token.paneId) !== token.revision) {
      return { ok: false, reason: "stale_surface", detail: "the pane moved after the read the token was minted on" };
    }
    const sent = await this.mux.writeKeys(token.paneId, token.keys);
    this.bump(token.paneId);
    this.sends[token.origin]++;
    return sent.ok ? { ok: true } : { ok: false, reason: "mux", refusal: sent };
  }

  /**
   * A person's keys, or the old reply route's submit: sent as asked, with no revision check. The
   * pane's revision moves, so any protocol token minted before it is stale. The adapter's answer is
   * returned as it is, so a route that used to call the adapter answers byte for byte as before.
   */
  async press(paneId: string, keys: readonly string[], origin: Exclude<KeyOrigin, "protocol">): Promise<MuxAck> {
    // Another bridge writing into this pane refuses the press before any key (M102 spec 16): `refused`,
    // with the busy words, so no route counts it as sent.
    return this.hold(
      paneId,
      PRESS_SPAN_MS,
      () => {
        this.bump(paneId);
        this.sends[origin]++;
        return this.mux.writeKeys(paneId, keys);
      },
      () => paneBusy(),
    );
  }

  /** How many key sends each origin made through this gate (for the counters of spec 09). */
  sentBy(): Readonly<KeySendCounts> {
    return { ...this.sends };
  }
}

/** The refusal a write gets while another bridge holds the pane: `refused`, with {@link PANE_BUSY}. */
export function paneBusy(): MuxRefusalOutcome {
  return muxRefused(PANE_BUSY);
}

/** Whether a refusal is {@link paneBusy}: a route names it `pane_busy` (bridge/refusal.ts). */
export function isPaneBusy(ack: MuxAck): boolean {
  return !ack.ok && ack.reason === "refused" && ack.detail === PANE_BUSY;
}

const gates = new WeakMap<KeyWriter, KeyGate>();

/** The one gate for a multiplexer adapter. Every route and the protocol take it from here, so they share the counter. */
export function gateFor(mux: KeyWriter): KeyGate {
  let gate = gates.get(mux);
  if (gate === undefined) {
    gate = new KeyGate(mux);
    gates.set(mux, gate);
  }
  return gate;
}
