import { describe, expect, test } from "bun:test";

import { parseEdge } from "../bridge/beacon/parse.ts";
import { EDGE_FILE } from "../bridge/beacon/paths.ts";
import { hillSwitchPath } from "../bridge/hill/switch.ts";
import { WALKY_HEADER_PREFIX } from "../bridge/walky/types.ts";
import type { JsonObject } from "../bridge/json.ts";
import { parseJsonObject } from "../web/src/lib/json.ts";
import { ASKS_BRIDGE_MS, ASKS_LIMIT_MS, asksOfPayload, cmdBeaconAsks, fromAnotherAgent, shownQuestion, type BeaconAsksDeps } from "./beacon-asks.ts";
import { cmdBeaconEmit } from "./beacon.ts";
import { capture, context, fakeFiles, STATE } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { COMMANDS, run } from "./program.ts";

// The safety gates of `collie beacon asks` (the review of the Edge build, 2026-11-23): each bridge's own Asks
// switch is read before any socket, one bridge gets at most 300 ms, the payload's `session_id` rides on the
// call, a prompt from another agent asks nothing, no hidden character reaches the text; `beacon emit` names the
// agent session on its edges; and an unknown `beacon` verb is silent with exit 0.

const MARKERS = { TMUX: "/tmp/tmux-1/default,123,0", TMUX_PANE: "%1" };
const PROMPT = { session_id: "0a1b2c3d-1111-2222-3333-444455556666", hook_event_name: "UserPromptSubmit", prompt: "go on", cwd: "/repo" };
const LIST = JSON.stringify({ ok: true, remind: "full", asks: [{ id: "ak_aaaaaaaaaaaa", title: "Ship it?" }] });
const ON = JSON.stringify({ v: 1, on: true, at: "2026-11-23T00:00:00.000Z" });
const OFF = JSON.stringify({ v: 1, on: false, at: "2026-11-23T00:00:00.000Z" });

interface Fake {
  readonly deps: BeaconAsksDeps;
  readonly printed: string[];
  readonly asked: Array<{ socket: string; line: JsonObject; ms: number }>;
}

/**
 * One fake walk. `bridges` maps a socket to its switch file text (null: no file) and its answer ("hang": it
 * answers only when its share of time is over, as the real socket gives up then).
 */
function fake(bridges: Record<string, { switch: string | null; answer: string | null | "hang" }>, payload: JsonObject = PROMPT): Fake {
  const printed: string[] = [];
  const asked: Fake["asked"] = [];
  const seed: Record<string, string> = {};
  for (const [socket, bridge] of Object.entries(bridges)) if (bridge.switch !== null) seed[hillSwitchPath(`/state${socket}`)] = bridge.switch;
  const files = fakeFiles(seed);
  files.entryTypes.set("/", "directory");
  files.entryTypes.set("/s", "directory");
  for (const socket of Object.keys(bridges)) files.entryTypes.set(socket, "other");
  const deps: BeaconAsksDeps = {
    ctx: context(MARKERS),
    files,
    uid: undefined,
    readStdin: async () => JSON.stringify(payload),
    bridges: () => Object.keys(bridges).map((socket) => ({ socket, stateDir: `/state${socket}` })),
    ask: (socket, line, ms) => {
      asked.push({ socket, line: parseJsonObject(line) ?? {}, ms });
      const answer = bridges[socket]?.answer ?? null;
      if (answer !== "hang") return Promise.resolve(answer);
      return new Promise((done) => setTimeout(() => done(null), ms));
    },
    print: async (text) => void printed.push(text),
    binary: () => "collie",
  };
  return { deps, printed, asked };
}

describe("fix 1: each bridge's own Asks switch, before any socket", () => {
  test("off, missing or unreadable: that bridge is skipped with no socket call; with none left, nothing is asked", async () => {
    for (const text of [OFF, null, "not json", JSON.stringify({ v: 2, on: true }), JSON.stringify({ v: 1, on: "yes" })]) {
      const f = fake({ "/s/one": { switch: text, answer: LIST } });
      expect(await cmdBeaconAsks(f.deps)).toBe(EXIT.OK);
      expect(f.asked).toEqual([]);
      expect(f.printed).toEqual([]);
    }
  });

  test("a bridge with Asks off is passed over; the next one with Asks on is asked", async () => {
    const f = fake({ "/s/off": { switch: OFF, answer: LIST }, "/s/on": { switch: ON, answer: LIST } });
    await cmdBeaconAsks(f.deps);
    expect(f.asked.map((call) => call.socket)).toEqual(["/s/on"]);
    expect(f.printed).toHaveLength(1);
  });
});

describe("fix 2: one bridge cannot eat the whole time", () => {
  test("a bridge that never answers, placed first, gets 300 ms; the next one still answers in time", async () => {
    const f = fake({ "/s/hang": { switch: ON, answer: "hang" }, "/s/two": { switch: ON, answer: LIST } });
    const started = Date.now();
    expect(await cmdBeaconAsks(f.deps)).toBe(EXIT.OK);
    expect(Date.now() - started).toBeLessThan(ASKS_LIMIT_MS);
    expect(f.asked.map((call) => [call.socket, call.ms])).toEqual([
      ["/s/hang", ASKS_BRIDGE_MS],
      ["/s/two", ASKS_BRIDGE_MS],
    ]);
    expect(f.printed).toHaveLength(1);
  });

  test("the share is 300 ms of the one deadline of 1 s", () => {
    expect(ASKS_BRIDGE_MS).toBe(300);
    expect(ASKS_BRIDGE_MS).toBeLessThan(ASKS_LIMIT_MS);
  });
});

describe("fix 3: the payload's session_id rides on the call", () => {
  test("sent when it has the shape; a payload with none, or a malformed one, sends none", async () => {
    const f = fake({ "/s/one": { switch: ON, answer: LIST } });
    await cmdBeaconAsks(f.deps);
    expect(f.asked[0]?.line.sessionId).toBe(PROMPT.session_id);
    for (const session_id of [undefined, null, "", "../x", "a b", 5]) {
      const g = fake({ "/s/one": { switch: ON, answer: LIST } }, { ...PROMPT, session_id: session_id ?? null });
      await cmdBeaconAsks(g.deps);
      expect(g.asked[0]?.line).not.toHaveProperty("sessionId");
    }
    const start = fake({ "/s/one": { switch: ON, answer: LIST } }, { session_id: "s2", hook_event_name: "SessionStart", source: "clear" });
    await cmdBeaconAsks(start.deps);
    expect(start.asked[0]?.line).toMatchObject({ op: "ask.remind", event: "start", source: "clear", sessionId: "s2" });
  });

  test("beacon emit names the agent session on the session's own edges", async () => {
    const files = fakeFiles({ "/proc/4242/stat": `4242 (claude) S 4200 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} 987654 0 0` });
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"]) {
      const deps = { ctx: context(MARKERS), files, readStdin: () => Promise.resolve(JSON.stringify({ ...PROMPT, hook_event_name: event, source: "clear" })), agentPid: 4242, now: () => 1_700_000_000_000, uid: 1000, pidProbe: { platform: "linux" as const } };
      expect(await cmdBeaconEmit(deps)).toBe(EXIT.OK);
    }
    const edges = [...files.entries].filter(([path]) => path.startsWith(`${STATE}/edges/`) && EDGE_FILE.test(path.slice(`${STATE}/edges/`.length))).map(([, entry]) => parseEdge(entry.text));
    expect(edges).toHaveLength(4);
    for (const edge of edges) expect(edge?.session).toBe(PROMPT.session_id);
  });
});

describe("fix 4: no reminder on a prompt another agent sent", () => {
  test("a prompt that starts with the WalkyTalky header asks no bridge and prints nothing", async () => {
    for (const prompt of [`${WALKY_HEADER_PREFIX}wt_aaaaaaaaaaaa] from agent x`, `  ${WALKY_HEADER_PREFIX}wt_aaaaaaaaaaaa] from operator "phone"`, `\n\n<pasted_content id="f2">\n${WALKY_HEADER_PREFIX}wt_aaaaaaaaaaaa] from agent x\n</pasted_content id="f2">\n`]) {
      const f = fake({ "/s/one": { switch: ON, answer: LIST } }, { ...PROMPT, prompt });
      expect(await cmdBeaconAsks(f.deps)).toBe(EXIT.OK);
      expect(f.asked).toEqual([]);
      expect(f.printed).toEqual([]);
    }
  });

  test("the prefix is the WalkyTalky code's own; a prompt that only mentions it is asked as any other", () => {
    expect(WALKY_HEADER_PREFIX).toBe("[walky-talky ");
    expect(fromAnotherAgent("please read [walky-talky wt_x] above")).toBe(false);
    expect(fromAnotherAgent(undefined)).toBe(false);
    expect(asksOfPayload({ ...PROMPT, prompt: "please read [walky-talky wt_x]" })).toMatchObject({ event: "UserPromptSubmit" });
  });
});

describe("fix 5: hidden characters in a question", () => {
  test("U+200B, U+2060, U+FEFF and tag characters never reach the text", () => {
    expect(shownQuestion("Ship​ it⁠ now﻿?")).toBe("Ship it now?");
    expect(shownQuestion("Ship it?\u{E0001}\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}\u{E007F}")).toBe("Ship it?");
    expect(shownQuestion("a b c")).toBe("a b c");
  });
});

describe("fix 8: an unknown beacon verb is silent", () => {
  test("`collie beacon <unknown>` prints nothing on stdout and exits 0", async () => {
    const beacon = COMMANDS.filter((command) => command.name === "beacon");
    for (const argv of [["beacon", "bogus"], ["beacon", "check"], ["beacon"], ["beacon", "bogus", "--flag", "x"]]) {
      const io = capture();
      expect(await run(argv, io, beacon)).toBe(EXIT.OK);
      expect(io.stdout).toEqual([]);
      expect(io.stderr).toEqual([]);
    }
  });
});
