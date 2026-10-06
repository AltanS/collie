import { LAST_RESORT_NO_JOURNAL_MS, journalReadingOf, paneBody, type ChatGateInput, type PaneBody } from "./chat-gate";
import { savedChatWindow } from "./chat-window";

// The whole rule, as a table. Each row is one pane a Chat device can meet, and the body it draws.
// Read a row left to right: chat chosen and drawable, session reported, what the log said, how the
// pane began, the events seen since, and whether the read after the turn's end has answered.
// lib/chat-gate.ts holds the rule in words. No row depends on a clock except the last-resort rows.
const base: ChatGateInput = {
  chat: true,
  session: false,
  journal: "unasked",
  history: "fresh",
  activity: "none",
  settled: false,
};
const row = (over: Partial<ChatGateInput>): ChatGateInput => ({ ...base, ...over });

const rows: [string, ChatGateInput, PaneBody][] = [
  // 1. Terminal device, or a harness with no Chat: nothing below matters.
  ["a terminal device keeps the terminal, even over a readable session",
    row({ chat: false, session: true, journal: "readable" }), "terminal"],
  ["a terminal device keeps the terminal on a fresh pane too", row({ chat: false }), "terminal"],
  ["a terminal device keeps the terminal over a blocked pane", row({ chat: false, activity: "blocked" }), "terminal"],

  // 2. A session whose log is not known to be missing: Chat, whatever else this view saw.
  ["a readable session draws Chat", row({ session: true, journal: "readable" }), "chat"],
  ["a session not asked yet draws Chat", row({ session: true, journal: "unasked" }), "chat"],
  ["a readable session draws Chat on a pane first seen busy",
    row({ session: true, journal: "readable", history: "unknown" }), "chat"],
  ["a readable session draws Chat after a question", row({ session: true, journal: "readable", activity: "blocked" }), "chat"],
  ["a readable session draws Chat after the last resort", row({ session: true, journal: "readable", activity: "stalled" }), "chat"],
  ["a readable session draws Chat after the turn ended", row({ session: true, journal: "readable", activity: "ended", settled: true }), "chat"],

  // 2b. The server says it cannot read at all: no event will change that, so the terminal, at once.
  ["a server that cannot read draws the terminal, over a session", row({ session: true, journal: "off" }), "terminal"],
  ["a server that cannot read draws the terminal on a fresh pane too", row({ journal: "off" }), "terminal"],
  ["a server that cannot read draws the terminal while the pane works",
    row({ session: true, journal: "off", activity: "working" }), "terminal"],

  // 3. Nothing to read on a pane this view did not see start: it may have a past Chat cannot show.
  ["a pane first seen busy with no session keeps the terminal", row({ history: "unknown" }), "terminal"],
  ["a pane first seen busy with no log keeps the terminal",
    row({ session: true, journal: "missing", history: "unknown" }), "terminal"],

  // 4. The pane asked for input with nothing to read: the question must be on screen.
  ["a blocked pane with no session falls back at once", row({ activity: "blocked" }), "terminal"],
  ["a blocked pane with no log falls back at once", row({ session: true, journal: "missing", activity: "blocked" }), "terminal"],

  // 5. The last resort: it worked and no event ever came.
  ["the last resort falls back with no session", row({ activity: "stalled" }), "terminal"],
  ["the last resort falls back with no log", row({ session: true, journal: "missing", activity: "stalled" }), "terminal"],

  // 6. The first turn ended.
  ["the turn ended and the snapshot that says so names no session: terminal at once",
    row({ activity: "ended" }), "terminal"],
  ["the turn ended with no session, whether or not a read answered", row({ activity: "ended", settled: true }), "terminal"],
  ["the turn ended with a session and no log, before the read after it answers: still Chat",
    row({ session: true, journal: "missing", activity: "ended", settled: false }), "start"],
  ["the turn ended, and the read after it still found no log: terminal",
    row({ session: true, journal: "missing", activity: "ended", settled: true }), "terminal"],

  // 7. A fresh pane that has not worked, or is working: Chat, waiting to read.
  ["a fresh pane draws Chat with the start line", row({}), "start"],
  ["a fresh Codex pane with no session yet draws Chat", row({ journal: "unasked" }), "start"],
  ["a fresh pi pane whose log is not written yet draws Chat", row({ session: true, journal: "missing" }), "start"],
  ["a working pane with no session yet stays on Chat", row({ activity: "working" }), "start"],
  ["a working pane with no log yet stays on Chat", row({ session: true, journal: "missing", activity: "working" }), "start"],
  ["`settled` means nothing before the turn ends",
    row({ session: true, journal: "missing", activity: "working", settled: true }), "start"],
];

describe("paneBody", () => {
  it.each(rows)("%s", (_name, input, body) => {
    expect(paneBody(input)).toBe(body);
  });

  it("names the last resort a minute, and nothing else in the rule counts time", () => {
    expect(LAST_RESORT_NO_JOURNAL_MS).toBe(60_000);
  });
});

describe("journalReadingOf", () => {
  it("reads each answer of the chat route", () => {
    expect(journalReadingOf({ kind: "empty" })).toBe("unasked");
    expect(journalReadingOf({ kind: "live" })).toBe("readable");
    expect(journalReadingOf({ kind: "unavailable", reason: "no-log" })).toBe("missing");
    expect(journalReadingOf({ kind: "unavailable", reason: "no-session" })).toBe("missing");
  });

  it("reads switched-off reading and a member older than the route as off", () => {
    expect(journalReadingOf({ kind: "unavailable", reason: "disabled" })).toBe("off");
    expect(journalReadingOf({ kind: "stale" })).toBe("off");
  });
});

// M46 spec 09: a saved copy read back with no bridge in reach is a window to draw. It must not read as
// "no log" and push the pane to the terminal, or a phone with no bridge would lose Chat exactly when
// Chat is the only thing it still has.
describe("the gate over a stale saved copy", () => {
  const saved = savedChatWindow(
    [{ uuid: "a", seq: 1, ts: "", role: "assistant", parts: [{ kind: "text", text: "kept" }] }],
    1_000,
  );

  it("reads a stale saved copy as readable, never as missing", () => {
    expect(saved.savedAt).toBe(1_000);
    expect(journalReadingOf(saved.status)).toBe("readable");
  });

  it("draws Chat for a stale saved copy, and does not fall back to the terminal", () => {
    const input = row({ session: true, journal: journalReadingOf(saved.status), history: "unknown" });
    expect(paneBody(input)).toBe("chat");
  });
});
