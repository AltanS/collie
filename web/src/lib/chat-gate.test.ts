import {
  CHAT_GRACE_MS,
  activityAt,
  paneBody,
  type ChatGateInput,
  type PaneBody,
} from "./chat-gate";

// The whole rule, as a table. Each row is one pane a Chat device can meet, and the body it draws.
// Read a row left to right: chat chosen and drawable, session reported, what the log said, how the
// pane began, whether it has worked. lib/chat-gate.ts holds the rule in words.
const rows: [string, ChatGateInput, PaneBody][] = [
  // 1. Terminal device, or a harness with no Chat: nothing below matters.
  ["a terminal device keeps the terminal, even over a readable session",
    { chat: false, session: true, journal: "readable", history: "fresh", activity: "none" }, "terminal"],
  ["a terminal device keeps the terminal on a new pane",
    { chat: false, session: false, journal: "unasked", history: "fresh", activity: "none" }, "terminal"],
  // 2. A session that reads, or is still being asked.
  ["a session with a readable log draws Chat",
    { chat: true, session: true, journal: "readable", history: "unknown", activity: "long" }, "chat"],
  ["a session not yet asked draws Chat, as it always did",
    { chat: true, session: true, journal: "unasked", history: "unknown", activity: "long" }, "chat"],
  // 3. Nothing to read on a pane this view did not see begin: the terminal at once, as before.
  ["no session, first seen busy: the terminal at once",
    { chat: true, session: false, journal: "unasked", history: "unknown", activity: "none" }, "terminal"],
  ["a session with no log, first seen busy: the terminal at once",
    { chat: true, session: true, journal: "missing", history: "unknown", activity: "none" }, "terminal"],
  // 4 and 5. A new pane: Chat, with the line that says how to begin.
  ["Codex before its first prompt: no session, idle",
    { chat: true, session: false, journal: "unasked", history: "fresh", activity: "none" }, "start"],
  ["Codex just after its first prompt, the session not in yet",
    { chat: true, session: false, journal: "unasked", history: "fresh", activity: "recent" }, "start"],
  ["pi before its first reply: a session, no log file yet",
    { chat: true, session: true, journal: "missing", history: "fresh", activity: "none" }, "start"],
  ["pi working on its first reply, inside the grace",
    { chat: true, session: true, journal: "missing", history: "fresh", activity: "recent" }, "start"],
  // 6. The grace is over and nothing came: the fallback.
  ["a broken hook: working past the grace with no session",
    { chat: true, session: false, journal: "unasked", history: "fresh", activity: "long" }, "terminal"],
  ["a log that never appears: working past the grace with a session",
    { chat: true, session: true, journal: "missing", history: "fresh", activity: "long" }, "terminal"],
  // And back: the session or the log arrives after the fallback.
  ["a session that arrives after the fallback takes the pane back to Chat",
    { chat: true, session: true, journal: "unasked", history: "fresh", activity: "long" }, "chat"],
  ["a log that arrives after the fallback takes the pane back to Chat",
    { chat: true, session: true, journal: "readable", history: "fresh", activity: "long" }, "chat"],
];

describe("paneBody", () => {
  it.each(rows)("%s", (_name, input, body) => {
    expect(paneBody(input)).toBe(body);
  });
});

describe("activityAt", () => {
  it("is none before any work, recent inside the grace and long from its end", () => {
    expect(activityAt(null, 1_000_000)).toBe("none");
    expect(activityAt(1_000_000, 1_000_000)).toBe("recent");
    expect(activityAt(1_000_000, 1_000_000 + CHAT_GRACE_MS - 1)).toBe("recent");
    expect(activityAt(1_000_000, 1_000_000 + CHAT_GRACE_MS)).toBe("long");
  });

  it("names the grace as fifteen seconds", () => {
    expect(CHAT_GRACE_MS).toBe(15_000);
  });
});
