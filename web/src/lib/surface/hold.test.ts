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
  shownInput,
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
    const note = { askId: "ask-1", state: "sent", tool: "Bash", input: "ls", agent: false, since: 5 };
    expect(readHoldNote(note)).toEqual(note);
    expect(readHoldNote({ ...note, state: "maybe" })).toBeNull();
    expect(readHoldNote(null)).toBeNull();
  });
});
