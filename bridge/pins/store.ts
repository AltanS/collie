// The pins of a session (M90). A pin is a COPY of one block of the conversation (the operator's own
// message, an agent reply, a tool card), kept on the machine that owns the pane, keyed on the session
// and not on the pane. It outlives the pane, a bridge restart and the journal's paging, and a reopened
// session shows its pins again.
//
//   <stateDir>/pins/<sessionKey>.json
//   { "v": 1, "pins": [ { "id", "itemId", "kind", "text", "tool"?, "ts"?, "pinnedAt" } ] }
//
// Oldest first on disk; `list` answers newest first. The folder is 0700 and each file 0600, as the
// walky talky's. A file that does not parse, or carries another version, reads as no pins and stays as
// it is until the next write. A write that fails returns a reason and leaves memory as it was, so the
// route can answer 500 instead of telling the phone a pin exists that a restart would lose.
//
// ONE WRITER. The bridge that owns the pane is the only process that writes its pins, and every write
// here is synchronous (`writeFileSync`, `renameSync`) with no await between the read of the session's
// pins and the write of the new list, so two requests never interleave: there is no lost update, and
// no lock to hold. A crew lead never writes a member's file; it forwards the request to the member
// that owns the pane, and that member's store answers.
//
// LIFECYCLE. The file of a session is deleted when its last pin is removed, so an emptied session leaves
// nothing behind. `sweep()` runs once at boot and removes a file nobody wrote for {@link SWEEP_DAYS}
// days, which is how the pins of a session that was never opened again go.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonObject } from "../../web/src/lib/json.ts";

/** Most pins one session keeps. The next one is refused, never a silent drop of the oldest. */
export const MAX_PINS = 100;

/** Longest pinned text, the cap Chat puts on a text part (journal/text.ts `MAX_TEXT_CHARS`). */
export const MAX_PIN_CHARS = 20_000;

/** A pin file nobody wrote for this many days is removed at boot. */
export const SWEEP_DAYS = 180;

/** How much of a pin's text its `anchor` keeps: enough to find the block again when its id changed. */
export const ANCHOR_CHARS = 80;

export type PinKind = "user" | "reply" | "thinking" | "notice" | "tool";

function isKind(value: string | undefined): value is PinKind {
  return value === "user" || value === "reply" || value === "thinking" || value === "notice" || value === "tool";
}

export interface PinTool {
  readonly name: string;
  /** The one-line gist of the call's input, as Chat shows it. */
  readonly input?: string;
}

/** What a caller hands over: everything but what the store mints. */
export interface PinDraft {
  /** The Chat item id (web/src/lib/chat-items.ts), kept so the phone can lead back to the block. */
  readonly itemId: string;
  readonly kind: PinKind;
  readonly text: string;
  readonly tool?: PinTool;
  /** The block's own time in the log, ISO, when the log carried one. */
  readonly ts?: string;
}

export interface Pin extends PinDraft {
  readonly id: string;
  readonly pinnedAt: number;
  /** The first {@link ANCHOR_CHARS} characters of the text, for "Show in Chat" when the block's id changed. */
  readonly anchor: string;
}

export type PinAdd =
  | { readonly ok: true; readonly pin: Pin; readonly created: boolean }
  | { readonly ok: false; readonly reason: "cap" | "write" };

export type PinRemove = { readonly ok: true; readonly removed: boolean } | { readonly ok: false; readonly reason: "write" };

/**
 * A session key the store may turn into a file name: it starts with a letter or digit and holds only
 * letters, digits, `.`, `_` and `-`. `pinSessionKey` (./key.ts) builds such keys; anything else is a
 * programming error, so the store throws rather than guessing a name.
 */
export const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

function pinOf(value: JsonObject | undefined): Pin | undefined {
  const id = asJsonString(value?.id);
  const itemId = asJsonString(value?.itemId);
  const kind = asJsonString(value?.kind);
  const text = asJsonString(value?.text);
  const pinnedAt = asJsonNumber(value?.pinnedAt);
  if (id === undefined || itemId === undefined || text === undefined || pinnedAt === undefined || !isKind(kind)) return undefined;
  const tool = asJsonObject(value?.tool);
  const name = asJsonString(tool?.name);
  const input = asJsonString(tool?.input);
  const ts = asJsonString(value?.ts);
  // A row written before `anchor` existed takes it from its text.
  const anchor = asJsonString(value?.anchor) ?? text.slice(0, ANCHOR_CHARS);
  const base: Pin = { id, itemId, kind, text, pinnedAt, anchor };
  const stamped: Pin = ts === undefined ? base : { ...base, ts };
  if (name === undefined) return stamped;
  return { ...stamped, tool: input === undefined ? { name } : { name, input } };
}

export class PinStore {
  /** Every session read so far, oldest pin first. A session is read from disk once. */
  private readonly sessions = new Map<string, Pin[]>();

  /** `dir` null keeps the pins in memory only (a test). */
  constructor(
    private readonly dir: string | null,
    private readonly now: () => number = Date.now,
    private readonly mint: () => string = () => randomBytes(6).toString("base64url"),
  ) {}

  private pathOf(sessionKey: string): string | null {
    if (!SESSION_KEY.test(sessionKey)) throw new Error(`not a pin session key: ${sessionKey}`);
    return this.dir === null ? null : join(this.dir, `${sessionKey}.json`);
  }

  private held(sessionKey: string): Pin[] {
    const known = this.sessions.get(sessionKey);
    if (known !== undefined) return known;
    const pins = this.read(this.pathOf(sessionKey));
    this.sessions.set(sessionKey, pins);
    return pins;
  }

  private read(path: string | null): Pin[] {
    if (path === null || !existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const file = parseJsonObject(raw);
    if (file?.v !== 1 || !Array.isArray(file.pins)) return [];
    const pins: Pin[] = [];
    for (const value of file.pins) {
      const pin = pinOf(asJsonObject(value));
      if (pin !== undefined) pins.push(pin);
    }
    return pins.slice(-MAX_PINS);
  }

  /** The session's pins, newest first. */
  list(sessionKey: string): Pin[] {
    return this.held(sessionKey).toReversed();
  }

  /** One pin of the session by its id, or undefined. */
  get(sessionKey: string, pinId: string): Pin | undefined {
    return this.held(sessionKey).find((pin) => pin.id === pinId);
  }

  /** How many pins the session holds. From memory once the session was read. */
  count(sessionKey: string): number {
    return this.held(sessionKey).length;
  }

  /**
   * Keep a copy of one block. Pinning the block that is already pinned answers the pin it has (and
   * `created: false`), so a double tap neither doubles the row nor spends the cap. The text is cut at
   * {@link MAX_PIN_CHARS}.
   */
  add(sessionKey: string, draft: PinDraft): PinAdd {
    const pins = this.held(sessionKey);
    const existing = pins.find((pin) => pin.itemId === draft.itemId);
    if (existing !== undefined) return { ok: true, pin: existing, created: false };
    if (pins.length >= MAX_PINS) return { ok: false, reason: "cap" };
    const text = draft.text.slice(0, MAX_PIN_CHARS);
    const pin: Pin = { ...draft, text, id: this.mint(), pinnedAt: this.now(), anchor: text.slice(0, ANCHOR_CHARS) };
    if (!this.write(sessionKey, [...pins, pin])) return { ok: false, reason: "write" };
    this.sessions.set(sessionKey, [...pins, pin]);
    return { ok: true, pin, created: true };
  }

  /** Drop one pin. Idempotent: a pin that is not there answers `removed: false`. */
  remove(sessionKey: string, pinId: string): PinRemove {
    const pins = this.held(sessionKey);
    if (!pins.some((pin) => pin.id === pinId)) return { ok: true, removed: false };
    const rest = pins.filter((pin) => pin.id !== pinId);
    if (!this.write(sessionKey, rest)) return { ok: false, reason: "write" };
    this.sessions.set(sessionKey, rest);
    return { ok: true, removed: true };
  }

  private write(sessionKey: string, pins: readonly Pin[]): boolean {
    const path = this.pathOf(sessionKey);
    if (path === null || this.dir === null) return true;
    try {
      // The last pin gone: the session's file goes with it.
      if (pins.length === 0) {
        rmSync(path, { force: true });
        return true;
      }
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      chmodSync(this.dir, 0o700);
      const temp = `${path}.tmp`;
      writeFileSync(temp, `${JSON.stringify({ v: 1, pins })}\n`, { mode: 0o600 });
      renameSync(temp, path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove the pin files nobody wrote for {@link SWEEP_DAYS} days, and any temp file a crash left. Run
   * once at boot, before a pin is read, so memory holds nothing of what goes. Answers how many went.
   */
  sweep(): number {
    if (this.dir === null || !existsSync(this.dir)) return 0;
    const cutoff = this.now() - SWEEP_DAYS * 86_400_000;
    let removed = 0;
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json") && !name.endsWith(".json.tmp")) continue;
      const path = join(this.dir, name);
      try {
        if (statSync(path).mtimeMs >= cutoff) continue;
        unlinkSync(path);
        removed += 1;
      } catch {
        // A file that vanished or cannot be removed stays for the next boot.
      }
    }
    return removed;
  }
}
