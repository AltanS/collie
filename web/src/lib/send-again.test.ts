import {
  asksSendAgain,
  forgetAllUnknownSends,
  forgetUnknownSend,
  rememberUnknownSend,
  SEND_AGAIN_WINDOW_MS,
  __forgetSendAgainMemory,
} from "./send-again";

const T0 = 1_000_000;

beforeEach(() => {
  sessionStorage.clear();
  __forgetSendAgainMemory();
});

describe("send it again", () => {
  it("the window is two minutes", () => {
    expect(SEND_AGAIN_WINDOW_MS).toBe(120_000);
  });

  it("asks for the same text on the same pane inside the window, up to its last millisecond", () => {
    rememberUnknownSend(undefined, "w1:p1", "run the tests", T0);
    expect(asksSendAgain(undefined, "w1:p1", "run the tests", T0 + 1)).toBe(true);
    expect(asksSendAgain(undefined, "w1:p1", "run the tests", T0 + SEND_AGAIN_WINDOW_MS)).toBe(true);
  });

  it("sends at once after the window", () => {
    rememberUnknownSend(undefined, "w1:p1", "run the tests", T0);
    expect(asksSendAgain(undefined, "w1:p1", "run the tests", T0 + SEND_AGAIN_WINDOW_MS + 1)).toBe(false);
  });

  it("sends at once for another text, and for a text that differs by one character", () => {
    rememberUnknownSend(undefined, "w1:p1", "run the tests", T0);
    expect(asksSendAgain(undefined, "w1:p1", "run the test", T0 + 10)).toBe(false);
    expect(asksSendAgain(undefined, "w1:p1", "run  the tests", T0 + 10)).toBe(false);
    expect(asksSendAgain(undefined, "w1:p1", "", T0 + 10)).toBe(false);
  });

  it("reads the text the same way at both ends: trailing whitespace never disarms the question", () => {
    rememberUnknownSend(undefined, "w1:p1", "run the tests", T0);
    expect(asksSendAgain(undefined, "w1:p1", "  run the tests \n", T0 + 10)).toBe(true);
    rememberUnknownSend(undefined, "w1:p2", "  run the tests \n", T0);
    expect(asksSendAgain(undefined, "w1:p2", "run the tests", T0 + 10)).toBe(true);
  });

  it("on a shell pane only the end is trimmed: a leading space is a different line", () => {
    rememberUnknownSend(undefined, "w1:p1", " ls -la  ", T0, { isShell: true });
    expect(asksSendAgain(undefined, "w1:p1", " ls -la", T0 + 10, true)).toBe(true);
    expect(asksSendAgain(undefined, "w1:p1", "ls -la", T0 + 10, true)).toBe(false);
  });

  it("memoryOnly keeps the entry out of sessionStorage, asks while the page lives, and clears an older stored entry", () => {
    rememberUnknownSend(undefined, "w1:p1", "old words", T0);
    expect(sessionStorage.length).toBe(1);
    rememberUnknownSend(undefined, "w1:p1", "hunter2", T0 + 5, { memoryOnly: true });
    expect(sessionStorage.length).toBe(0);
    expect(asksSendAgain(undefined, "w1:p1", "hunter2", T0 + 10)).toBe(true);
    // A reload drops the memory copy, and with nothing in storage the question is simply not asked.
    __forgetSendAgainMemory();
    expect(asksSendAgain(undefined, "w1:p1", "hunter2", T0 + 10)).toBe(false);
  });

  it("is per pane, per session and per host", () => {
    rememberUnknownSend(undefined, "w1:p1", "go", T0);
    expect(asksSendAgain(undefined, "w1:p2", "go", T0 + 10)).toBe(false);
    expect(asksSendAgain({ session: "demo" }, "w1:p1", "go", T0 + 10)).toBe(false);
    expect(asksSendAgain({ host: "minibuch" }, "w1:p1", "go", T0 + 10)).toBe(false);
  });

  it("a clock that moved back does not ask", () => {
    rememberUnknownSend(undefined, "w1:p1", "go", T0);
    expect(asksSendAgain(undefined, "w1:p1", "go", T0 - 1)).toBe(false);
  });

  it("forgetting ends the question, in both tiers", () => {
    rememberUnknownSend(undefined, "w1:p1", "go", T0);
    forgetUnknownSend(undefined, "w1:p1");
    __forgetSendAgainMemory();
    expect(asksSendAgain(undefined, "w1:p1", "go", T0 + 10)).toBe(false);
  });

  it("forgetting one text leaves an entry for other words, and takes its own", () => {
    rememberUnknownSend(undefined, "w1:p1", "go", T0);
    forgetUnknownSend(undefined, "w1:p1", "stop");
    expect(asksSendAgain(undefined, "w1:p1", "go", T0 + 10)).toBe(true);
    forgetUnknownSend(undefined, "w1:p1", "go");
    expect(asksSendAgain(undefined, "w1:p1", "go", T0 + 10)).toBe(false);
  });

  it("survives a reload that drops the memory copy", () => {
    rememberUnknownSend(undefined, "w1:p1", "go", T0);
    __forgetSendAgainMemory();
    expect(asksSendAgain(undefined, "w1:p1", "go", T0 + 10)).toBe(true);
  });

  it("never stores the text itself", () => {
    rememberUnknownSend(undefined, "w1:p1", "hunter2-correct-horse", T0);
    const stored = Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.getItem(sessionStorage.key(i) ?? "") ?? "");
    expect(stored.join("")).not.toContain("hunter2");
  });

  it("a stored value that is not ours reads as nothing", () => {
    sessionStorage.setItem("collie:send-again:default:w1:p1", "{not json");
    expect(asksSendAgain(undefined, "w1:p1", "go", T0)).toBe(false);
  });

  it("the wipe drops every pane", () => {
    rememberUnknownSend(undefined, "w1:p1", "go", T0);
    rememberUnknownSend({ host: "minibuch" }, "w2:p1", "go", T0);
    forgetAllUnknownSends();
    expect(asksSendAgain(undefined, "w1:p1", "go", T0 + 10)).toBe(false);
    expect(asksSendAgain({ host: "minibuch" }, "w2:p1", "go", T0 + 10)).toBe(false);
    expect(sessionStorage.length).toBe(0);
  });
});
