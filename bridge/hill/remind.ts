// The reminder of open asks that rides on the prompt (Asks build 2; .adr/0178). Claude Code's
// `UserPromptSubmit` and `SessionStart` hooks run `collie beacon asks`, which asks this bridge (`ask.remind`
// on the walky socket) for the session's open asks; the hook prints them as context next to the prompt.
// This book holds what that needs and what the Hill's store does not: which asks were handed to which
// turn, the prompts the bridge typed itself, and the ids each session was shown last.
//
// THE TURN. A turn starts with a `prompt` hook edge (`collie beacon emit`, bridge/surface/edges.ts) and ends
// with a `stop` edge. Both hooks of one prompt run in parallel, so the hand-out (`ask.remind`) and the prompt
// edge reach the bridge in either order. They are paired by the prompt's salted hash, which both carry (the
// emitter writes it on the edge, the reminder sends it on the socket; the prompt text never reaches the
// bridge), and by time: the two are at most {@link ASK_REMIND_MATCH_MS} apart. A hand-out or a prompt with no
// hash is never paired: then the turn has no hand-out, and nothing is ever marked `carried` from a guess.
//
// THE MARKS (wire.ts `HillAskMark`). The service applies them; this book only says which turn handed out
// which ids. A stop edge confirms the hand-out of the pane's current turn once. It does not when a hand-out
// newer than that turn waits unpaired: then a prompt came that the bridge did not see, and the turn it
// knows is not the newest.
//
// ITS OWN PROMPTS. When the bridge types an "Answers to your asks" message into a pane, it records the hash
// of the text it typed ({@link AskRemindBook.typedOwn}). A prompt with that hash is the bridge's own message,
// which lists the session's open asks itself, so the reminder stays silent for it.
//
// ONE AGENT SESSION, NOT THE PANE (2026-11-23, the review of the Edge build). A second Claude process in the
// same pane inherits the pane's markers, and one process may move to another conversation (`/resume`, a
// fork, `/clear`). So the bridge lists and closes only for the pane's current agent session, the one its
// hook edges name, and it keys what a session was shown by that session id beside the walky address
// ({@link remindKey}). It also STAMPS each ask with the agent session the pane ran when the ask was posted
// ({@link AskRemindBook.stamp}); an ask stamped by another conversation is never listed to this one. A stamp
// lives in memory: after a restart an ask reads as unstamped, which lists as before the stamps.
//
// In memory: a restart forgets the turns, and the next prompt starts again (a stored mark stays as it was
// until then; a restart never makes a `carried`). Pure: the clock is injected; no file, no socket.

/** At most this many asks are listed in one reminder (the open cap is also 5, `HILL_ASK_OPEN_MAX`). */
export const ASK_REMIND_LISTED_MAX = 5;

/**
 * Whether a reminder whose asks the session was all shown in the full form already takes the short form
 * (the ids only: "Collie: open asks ak_1, ak_2."). A list with one ask the session has not seen gets the
 * full form. One switch, so the measurement with real sessions can turn it off: off, every list is full.
 */
export const ASK_REMIND_SHORT_FORM = true;

/**
 * After this many short forms in a row a session gets the full form again, and the count starts over. The
 * bridge cannot know that a hook's output reached the model (a timeout drops it), so the full form never
 * stays away for good.
 */
export const ASK_REMIND_FULL_EVERY = 20;

/** The most a hand-out and its prompt edge may lie apart, by their own clocks (the same machine's). */
export const ASK_REMIND_MATCH_MS = 10_000;

/** How long the bridge remembers a prompt it typed. A held WalkyTalky message is typed within 60 minutes. */
export const ASK_REMIND_OWN_KEEP_MS = 3 * 60 * 60 * 1000;

/** How many sessions and panes the book keeps before it forgets the oldest; and unpaired items per pane. */
const BOOK_MAX = 500;
/** How many ask stamps the book keeps (the open cap is 5 per session; this is generous). */
const STAMPS_MAX = 2000;
const PANE_LIST_MAX = 8;

/** The most the hook's clock may differ from the bridge's before the bridge uses its own (one machine). */
export const ASK_REMIND_CLOCK_MS = 60_000;

/**
 * How long a `/clear` waits for the pane's hook edges to name the new conversation. The hook that asks and
 * the emitter that writes the start edge run at the same time, so the bridge usually learns the new
 * session id a moment after the clear was asked; the clear applies then, or never.
 */
export const ASK_REMIND_CLEAR_WAIT_MS = 60_000;

/** The `SessionStart` sources that get the full list again: the conversation came back without it. */
export const ASK_REMIND_START_SOURCES: readonly string[] = ["compact", "resume", "fork"];

/** The pane a hook named, by its markers: a terminal session and a pane id of this bridge. */
export interface AskPane {
  readonly session: string;
  readonly paneId: string;
}

/**
 * What the hook says happened: a prompt (its salted hash, or null, and the hook's clock), or a session start.
 * `sessionId` is the agent session the hook's payload named (`session_id`), or null when it named none (an
 * older hook sends none): with none the bridge lists nothing and closes nothing.
 */
export type AskRemindEvent =
  | { readonly kind: "prompt"; readonly hash: string | null; readonly at: number; readonly sessionId?: string | null }
  | { readonly kind: "start"; readonly source: string; readonly sessionId?: string | null };

/** The pane's current agent session as its hook edges name it, and the one its process named just before. */
export interface PaneAgentSession {
  readonly current: string;
  /** The session the same process named before `current`, or null (none known, or another process). */
  readonly previous: string | null;
}

/** The key of one agent session of one walky address: what it was shown and how often the short form ran. */
export function remindKey(address: string, sessionId: string): string {
  return `${address}\u0000${sessionId}`;
}

/**
 * Text an agent wrote, made safe to print into a model's context: every code point of the Unicode classes
 * Cc (controls), Zl and Zp (line and paragraph separators) becomes a space, and every one of Cf (format:
 * zero-width characters, bidi controls, the byte order mark) and of the tag block (U+E0000 to U+E007F) is
 * removed. So nothing invisible rides along with the words. The one function for the hook's reminder and the
 * typed "Answers to your asks" message.
 */
export function withoutHidden(text: string): string {
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").replace(/[\p{Cf}\u{E0000}-\u{E007F}]/gu, "");
}

/** One ask a reminder lists. */
export interface AskRemindItem {
  readonly id: string;
  readonly title: string;
}

/** What the bridge answers `ask.remind` with. */
export type AskRemindAnswer = { readonly kind: "none" } | { readonly kind: "list"; readonly form: "full" | "short"; readonly asks: readonly AskRemindItem[] };

/** An ask as a reminder lists it: its id and question, nothing else (never an answer, a body or a file). */
export function remindItem(decision: { readonly id: string; readonly title: string }): AskRemindItem {
  return { id: decision.id, title: decision.title };
}

/** One hand-out: the asks a reminder listed for one prompt. */
export interface AskHandout {
  /** The sender key (walky address) of the session the asks are of. */
  readonly address: string;
  /** The prompt's salted hash. */
  readonly hash: string;
  /** When the hook ran, by its clock. */
  readonly at: number;
  readonly ids: readonly string[];
}

interface Turn {
  readonly at: number;
  readonly hash: string | null;
  handout: AskHandout | null;
  confirmed: boolean;
}

interface OwnPrompt {
  readonly hash: string;
  /** When the message's text was composed: the asks it lists were open then. */
  readonly composedAt: number;
  readonly typedAt: number;
}

interface PaneBook {
  turn: Turn | null;
  /** Hand-outs whose prompt edge has not come yet, oldest first. */
  pending: AskHandout[];
  own: OwnPrompt[];
  touched: number;
}

function paneKey(session: string, paneId: string): string {
  return `${session}\u0000${paneId}`;
}

export class AskRemindBook {
  private readonly panes = new Map<string, PaneBook>();
  private readonly shownSets = new Map<string, { ids: ReadonlySet<string>; shorts: number; touched: number }>();
  private readonly stamps = new Map<string, string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The bridge typed an "Answers to your asks" message into the pane: `hash` is the hash of the typed text. */
  typedOwn(session: string, paneId: string, hash: string, composedAt: number): void {
    const pane = this.pane(session, paneId);
    const now = this.now();
    pane.own = [...pane.own.filter((own) => now - own.typedAt <= ASK_REMIND_OWN_KEEP_MS), { hash, composedAt, typedAt: now }].slice(-PANE_LIST_MAX);
  }

  /** The bridge's own prompt with this hash in the pane, taken (it answers once), or null when it typed none. */
  takeOwn(session: string, paneId: string, hash: string): { readonly composedAt: number } | null {
    const pane = this.panes.get(paneKey(session, paneId));
    if (pane === undefined) return null;
    const now = this.now();
    const index = pane.own.findIndex((own) => own.hash === hash && now - own.typedAt <= ASK_REMIND_OWN_KEEP_MS);
    if (index < 0) return null;
    const [own] = pane.own.splice(index, 1);
    return own === undefined ? null : { composedAt: own.composedAt };
  }

  /**
   * A reminder handed `ids` to the prompt with `hash` in the pane. With no hash it is not recorded: it could
   * never be paired with its prompt, so its turn reads as one without a hand-out.
   */
  handOut(session: string, paneId: string, handout: Omit<AskHandout, "hash"> & { readonly hash: string | null }): void {
    if (handout.hash === null || handout.ids.length === 0) return;
    const out: AskHandout = { address: handout.address, hash: handout.hash, at: handout.at, ids: [...handout.ids] };
    const pane = this.pane(session, paneId);
    const turn = pane.turn;
    if (turn !== null && turn.handout === null && !turn.confirmed && turn.hash === out.hash && Math.abs(turn.at - out.at) <= ASK_REMIND_MATCH_MS) {
      turn.handout = out;
      return;
    }
    pane.pending = [...pane.pending, out].slice(-PANE_LIST_MAX);
  }

  /** A prompt edge of the pane's own session: a new turn, paired with its hand-out when one waits. */
  prompt(session: string, paneId: string, at: number, hash: string | null): void {
    const pane = this.pane(session, paneId);
    let handout: AskHandout | null = null;
    if (hash !== null) {
      const index = pane.pending.findIndex((item) => item.hash === hash && Math.abs(item.at - at) <= ASK_REMIND_MATCH_MS);
      if (index >= 0) handout = pane.pending.splice(index, 1)[0] ?? null;
    }
    // A hand-out older than this turn will never be paired now.
    pane.pending = pane.pending.filter((item) => item.at > at);
    pane.turn = { at, hash, handout, confirmed: false };
  }

  /**
   * A stop edge of the pane's own session: the hand-out of the current turn, once, when that turn handed one
   * out and is the newest the bridge knows. Null otherwise.
   */
  stop(session: string, paneId: string, at: number): AskHandout | null {
    const pane = this.panes.get(paneKey(session, paneId));
    const turn = pane?.turn ?? null;
    if (pane === undefined || turn === null || turn.confirmed || turn.handout === null || at < turn.at) return null;
    // A hand-out newer than the turn waits unpaired: a prompt came that the bridge did not see.
    if (pane.pending.some((item) => item.at > turn.at)) return null;
    turn.confirmed = true;
    pane.touched = this.now();
    return turn.handout;
  }

  /** A start or an end edge: the pane's turn is over, and so are its unpaired hand-outs. Its own prompts stay. */
  reset(session: string, paneId: string): void {
    const pane = this.panes.get(paneKey(session, paneId));
    if (pane === undefined) return;
    pane.turn = null;
    pane.pending = [];
  }

  /**
   * "short" when the short form is on and every listed id is one the session was shown last time; "full"
   * when at least one is new to it (a list that only lost an ask is short), and after
   * {@link ASK_REMIND_FULL_EVERY} short forms in a row. Afterwards the session's set is exactly `ids`, so an
   * ask that closed leaves it. `key` is {@link remindKey}: one agent session of one address.
   */
  form(key: string, ids: readonly string[], shortForm: boolean = ASK_REMIND_SHORT_FORM): "full" | "short" {
    const last = this.shownSets.get(key);
    const short = shortForm && last !== undefined && last.shorts < ASK_REMIND_FULL_EVERY && ids.every((id) => last.ids.has(id));
    if (!short) {
      this.shown(key, ids);
      return "full";
    }
    this.shownSets.set(key, { ids: new Set(ids), shorts: last.shorts + 1, touched: this.now() });
    return "short";
  }

  /** The session was shown these ids in full (a full list, or the bridge's own message): its set is exactly them, its count starts over. */
  shown(key: string, ids: readonly string[]): void {
    this.shownSets.set(key, { ids: new Set(ids), shorts: 0, touched: this.now() });
    trim(this.shownSets);
  }

  /** The session's conversation was cleared: the next list it gets is the full one. */
  forget(key: string): void {
    this.shownSets.delete(key);
  }

  /** The ask `id` was posted while the pane ran agent session `sessionId`. The first stamp stays. */
  stamp(id: string, sessionId: string): void {
    if (this.stamps.has(id)) return;
    this.stamps.set(id, sessionId);
    if (this.stamps.size > STAMPS_MAX) {
      const oldest = this.stamps.keys().next();
      if (oldest.done !== true) this.stamps.delete(oldest.value);
    }
  }

  /** The agent session that posted ask `id`, or undefined when it carries no stamp (posted before, or unknown). */
  stampOf(id: string): string | undefined {
    return this.stamps.get(id);
  }

  private pane(session: string, paneId: string): PaneBook {
    const key = paneKey(session, paneId);
    let pane = this.panes.get(key);
    if (pane === undefined) {
      pane = { turn: null, pending: [], own: [], touched: this.now() };
      this.panes.set(key, pane);
      trim(this.panes);
    }
    pane.touched = this.now();
    return pane;
  }
}

/** Forget the least recently touched entry once a map grows past {@link BOOK_MAX}. */
function trim(map: Map<string, { touched: number }>): void {
  if (map.size <= BOOK_MAX) return;
  let oldest: string | null = null;
  let at = Number.POSITIVE_INFINITY;
  for (const [key, value] of map) {
    if (value.touched < at) {
      at = value.touched;
      oldest = key;
    }
  }
  if (oldest !== null) map.delete(oldest);
}
