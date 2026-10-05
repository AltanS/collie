// WHICH BODY AN AGENT PANE DRAWS WHEN THE DEVICE CHOSE CHAT (1.17.0, ADR 0082 point 4).
//
// Chat reads the agent's own session log. A new pane often has none to read yet, and that is not a
// fault: Codex reports its session only on the first prompt, and pi writes its log file only after
// its first reply. Drawing the terminal until then put two bodies on a pane that had just started,
// with a swap between them that no cover hid. So a pane that is NEW draws Chat at once, with one
// quiet line that says how to begin, and the terminal is the FALLBACK for a pane whose session or
// log should have come and did not.
//
// ── THE RULE, IN ORDER ───────────────────────────────────────────────────────
//   1. The device chose the terminal, or this harness cannot draw Chat → terminal.
//   2. The pane has a session and its log is not known to be missing → chat.
//   3. Nothing to read, and this view did not see the pane start fresh → terminal at once.
//   4. Nothing to read, and the pane has not worked yet → start (Chat, "Send a message to start").
//   5. Nothing to read, and it started working under {@link CHAT_GRACE_MS} ago → start.
//   6. Nothing to read, and it has worked longer than that → terminal, with the existing hint.
//
// Rule 6 is the guard against a broken hook: an operator must never be left on an empty Chat over a
// pane that is plainly doing something. The fallback is not sticky. When the session or the log
// arrives later, rule 2 takes the body back to Chat.
//
// Pure, so the whole decision is one table test (chat-gate.test.ts). The hook that feeds it
// (hooks/use-pane-start.ts) owns the clock and the memory of what this view has seen.

/** How long a pane may work with nothing to read before Chat gives way to the terminal. */
export const CHAT_GRACE_MS = 15_000;

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
 * `fresh`: this view saw the pane turn from a shell into this agent, or first saw it idle. `unknown`:
 * this view first saw it already working, blocked, done or in an unknown state, so it may have a
 * long past that Chat cannot read.
 */
export type PaneHistory = "fresh" | "unknown";

/**
 * Whether the pane has worked since it began, and for how long.
 *
 * `none`: no status other than idle yet, and no prompt sent from this device. `recent`: work began
 * under {@link CHAT_GRACE_MS} ago. `long`: it began that long ago or more.
 */
export type PaneActivity = "none" | "recent" | "long";

export interface ChatGateInput {
  /** The device chose Chat, and this pane's harness can draw it (a session log on this multiplexer). */
  chat: boolean;
  /** The pane reported an agent session. */
  session: boolean;
  journal: JournalReading;
  history: PaneHistory;
  activity: PaneActivity;
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
  return input.activity === "long" ? "terminal" : "start";
}

/** The activity reading at `now`, for work that began at `since` (or never, when null). */
export function activityAt(since: number | null, now: number): PaneActivity {
  if (since === null) return "none";
  return now - since < CHAT_GRACE_MS ? "recent" : "long";
}
