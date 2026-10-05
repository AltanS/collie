// WHICH BODY AN AGENT PANE DRAWS WHEN THE DEVICE CHOSE CHAT (1.17.0, ADR 0082 point 4).
//
// Chat reads the agent's own session log. A new pane often has none to read yet, and that is not a
// fault: Codex reports its session only on the first prompt, and pi writes its log file only after
// its first reply. Drawing the terminal until then put two bodies on a pane that had just started,
// with a swap between them that no cover hid. So a pane that is NEW draws Chat at once, with one
// quiet line that says how to begin, and the terminal is the FALLBACK for a pane whose session or
// log should have come and did not.
//
// ── EVENTS DECIDE, NEVER A CLOCK ─────────────────────────────────────────────
// Every fallback below waits for something to HAPPEN on the pane: it asks for input, or its first
// turn ends. The end of a turn is the moment a healthy harness has certainly named its session and
// written its log, so it is the moment a missing one becomes a fault rather than a wait. Nothing
// here counts seconds, except one last resort for a pane that works and never sends another event.
//
// ── THE RULE, IN ORDER ───────────────────────────────────────────────────────
//   1. The device chose the terminal, or this harness cannot draw Chat → terminal.
//   2. The pane has a session and its log is not known to be missing → chat.
//   3. Nothing to read, and this view did not see the pane start fresh → terminal at once.
//   4. Nothing to read, and the pane asked for input (blocked) → terminal at once. A dialog on an
//      empty Chat is a question the operator cannot see.
//   5. Nothing to read, and the last resort fired: the pane worked for
//      {@link LAST_RESORT_NO_JOURNAL_MS} and no event came at all → terminal.
//   6. Nothing to read, and the first turn ended:
//        - the snapshot that reports the end names no session → terminal at once;
//        - the log is still missing in the journal read STARTED AFTER that snapshot → terminal.
//          Until that read answers → start. (`settled`, see hooks/use-pane-start.ts.)
//   7. Otherwise (not worked yet, or working) → start: Chat, "Send a message to start", or the
//      working indicator.
//
// The fallback is not sticky. When the session and the log arrive later, rule 2 takes the body back
// to Chat.
//
// Pure, so the whole decision is one table test (chat-gate.test.ts). The hook that feeds it
// (hooks/use-pane-start.ts) owns the memory of what this view has seen.

/**
 * THE LAST RESORT, and the one duration in this decision. A pane that works with nothing to read and
 * then sends no event at all (no turn end, no question) would otherwise sit on an empty Chat for as
 * long as it works. A healthy Codex or pi pane never reaches it: its session and log arrive within
 * the first turn, and the turn's end is an event. Only a broken hook on a long first turn does.
 */
export const LAST_RESORT_NO_JOURNAL_MS = 60_000;

/**
 * What the chat route last said about the pane's log.
 *
 * `unasked`: no answer yet, or nothing was asked (no session). `readable`: the route answered with
 * a window, or with a reading the stream explains itself (switched off, an older member). `missing`:
 * the route answered `no-log` or `no-session`, so there is nothing to read YET.
 */
export type JournalReading = "unasked" | "readable" | "missing";

/**
 * What this view knows about how the pane began.
 *
 * `fresh`: this view saw the pane turn from a shell into this agent, or first saw it idle with an
 * excuse for having nothing to read yet (Codex before its first prompt, pi before its first reply:
 * lib/journal-agents.ts). `unknown`: anything else, so it may have a long past that Chat cannot read.
 * An idle pane with nothing to read and no such excuse is `unknown`: its hook may be missing, Codex may
 * have declined trust, or the transcript may be gone, and an empty Chat over a live conversation hides
 * the terminal that shows it.
 */
export type PaneHistory = "fresh" | "unknown";

/**
 * The events this view has seen on the agent since it began. Each one past `working` is a latch:
 * once seen, it stands for this agent until the view starts a new record.
 *
 * `none`: nothing yet. `working`: it is working on its first turn. `blocked`: it asked for input.
 * `ended`: its first turn ended (it left working for done or idle, or it read done). `stalled`: the
 * last resort fired ({@link LAST_RESORT_NO_JOURNAL_MS}).
 */
export type PaneActivity = "none" | "working" | "blocked" | "ended" | "stalled";

export interface ChatGateInput {
  /** The device chose Chat, and this pane's harness can draw it (a session log on this multiplexer). */
  chat: boolean;
  /** The pane reported an agent session. */
  session: boolean;
  journal: JournalReading;
  history: PaneHistory;
  activity: PaneActivity;
  /** A journal read started after the turn-end snapshot has answered. Read only at `ended`. */
  settled: boolean;
}

/**
 * The body to draw. `chat` reads the session; `start` is the Chat body with nothing to read yet and
 * one line that says how to begin; `terminal` is the mirror.
 */
export type PaneBody = "chat" | "start" | "terminal";

export function paneBody(input: ChatGateInput): PaneBody {
  if (!input.chat) return "terminal";
  if (input.session && input.journal !== "missing") return "chat";
  if (input.history === "unknown") return "terminal";
  if (input.activity === "blocked" || input.activity === "stalled") return "terminal";
  if (input.activity === "ended") {
    if (!input.session) return "terminal";
    return input.settled ? "terminal" : "start";
  }
  return "start";
}
