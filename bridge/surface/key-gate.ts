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

import type { MuxAck, MuxAdapter, MuxRefusalOutcome } from "../mux/types.ts";

/** How long a protocol token lives, in ms. */
export const TOKEN_LIFETIME_MS = 150;

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

  constructor(
    private readonly mux: KeyWriter,
    private readonly now: () => number = () => Date.now(),
  ) {}

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
    this.bump(paneId);
    this.sends[origin]++;
    return this.mux.writeKeys(paneId, keys);
  }

  /** How many key sends each origin made through this gate (for the counters of spec 09). */
  sentBy(): Readonly<KeySendCounts> {
    return { ...this.sends };
  }
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
