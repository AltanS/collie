// A pane the multiplexer names no agent on, while an agent runs in it (#793). Herdr reported a shell for
// a pane where pi ran, and every send there took the blind road, which M100 spec 06 refuses when the
// screen shows an agent's box. The launch window named the program for the first 120 s after it started
// and then let the pane go back to a shell. The send path now names the harness by the program in the
// pane's foreground (bridge/pane-binary.ts `paneHarnessOf`), with a proven pid and one harness only.
//
// The pane is Claude Code 2.1.314's own screen (the late-keys capture): a box that takes the text and an
// Enter that sends it, so a send that gets Claude's profile goes, and one that does not is refused.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForegroundProcess } from "../journal/types.ts";
import { foregroundHarnessOf, LaunchWindow } from "../launch-window.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { createPaneHarness, profileBinaries, type ForegroundOutcome, type ProcessProbe } from "../pane-binary.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const CAPTURE = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface", "claude--v2-1-314-agents-footer-late-probes--w282.txt"), "utf8");
const RULE = /^─{8,}$/u;

/** Claude's screen with a box that holds what was typed; Enter sends the box. */
class ClaudePane {
  box = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  private reads = 0;
  private readonly head: string[];
  private readonly rule: string;
  private readonly tail: string[];

  constructor() {
    const rows = CAPTURE.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const bottom = rows.findLastIndex((row) => RULE.test(row));
    const top = rows.slice(0, bottom).findLastIndex((row) => RULE.test(row));
    this.head = rows.slice(0, top);
    this.rule = rows[top]!;
    this.tail = rows.slice(bottom + 1);
  }

  readGrid = (paneId: string): Promise<MuxOutcome<MuxGrid>> => {
    const text = [...this.head, this.rule, `❯ ${this.box}`, this.rule, ...this.tail].join("\n");
    return Promise.resolve(muxOk({ paneId, text, truncated: false, revision: ++this.reads }));
  };

  typeText = (_paneId: string, text: string): Promise<MuxAck> => {
    this.box += text;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (_paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      if (key === "Enter") {
        if (this.box.length > 0) this.submitted.push(this.box);
        this.box = "";
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-pane-program-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** What the host shows of a pid: the argv each fake process runs, unless a test says otherwise. */
function procOf(running: ReadonlyMap<number, readonly string[]>): ProcessProbe {
  return { cmdlineOf: (pid) => running.get(pid) ?? null, exeOf: () => null, cwdOf: () => null };
}

interface RigOptions {
  /** What the multiplexer names the pane: `""` for a shell. */
  readonly harness?: string;
  /** The pane's foreground, as the multiplexer's read reports it. Absent: no foreground read (tmux, zellij). */
  readonly foreground?: readonly ForegroundProcess[];
  /** `/proc/<pid>/cmdline` per pid. Default: each foreground process runs what was reported. */
  readonly running?: ReadonlyMap<number, readonly string[]>;
  /** The bridge's launch window on the same foreground read, as bridge/index.ts wires it. */
  readonly window?: boolean;
}

/** A protocol on a Claude pane, wired the way bridge/index.ts wires one session. */
function rig(options: RigOptions = {}) {
  const pane = new ClaudePane();
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const running = options.running ?? new Map(options.foreground?.flatMap((p) => (p.pid === undefined ? [] : [[p.pid, p.argv] as const])) ?? []);
  const reads: string[] = [];
  const read =
    options.foreground === undefined
      ? undefined
      : (paneId: string): Promise<ForegroundOutcome> => {
          reads.push(paneId);
          return Promise.resolve({ ok: true, value: options.foreground ?? [] });
        };
  const window = options.window === true ? new LaunchWindow(now) : undefined;
  const foregroundHarness = foregroundHarnessOf(read, profileBinaries);
  const startingCalls: (string | null)[] = [];
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (name: string) => Promise.resolve(profileFor(name, "2.1.314", { log: () => undefined })),
    paneHarness: read === undefined ? undefined : createPaneHarness({ read, binaries: profileBinaries, probe: procOf(running) }),
    starting:
      window === undefined
        ? undefined
        : (paneId, named) => {
            startingCalls.push(named);
            return window.starting("main", paneId, named, foregroundHarness?.(paneId));
          },
    framed: window === undefined ? undefined : (paneId, harness) => window.framed("main", paneId, harness),
    deaf: window === undefined ? undefined : (paneId, harness, typedAt) => window.deaf("main", paneId, harness, typedAt),
    pending: window === undefined ? undefined : (paneId) => window.pending("main", paneId),
    generation: () => "shell:-",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const harness = options.harness ?? "";
  const send = (text: string): Promise<SendAnswer> =>
    protocol.handle({ id: `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`, text, mode: "send" }, { session: "main", paneId: "w2:p1", harness });
  return { pane, send, clock, reads, startingCalls };
}

/** The argv shapes Claude Code's binary takes in a pane, each with its own pid. */
const CLAUDE_LAUNCHES: readonly ForegroundProcess[] = [
  { argv: ["claude"], pid: 101 },
  { argv: ["/home/dev/.local/bin/claude", "--continue"], pid: 102 },
  { argv: ["node", "/home/dev/.npm-global/bin/claude"], pid: 103 },
  { argv: ["bun", "/home/dev/.bun/install/global/node_modules/.bin/claude"], pid: 104 },
  { argv: ["claude"] },
];

/** The blind road's refusal (M100 spec 06): nothing typed, no profile. */
function expectBlindRefusal(answer: SendAnswer, pane: ClaudePane): void {
  expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [], profileId: null });
  expect(pane.box).toBe("");
  expect(pane.submitted).toEqual([]);
}

describe("a shell pane whose foreground program is a known agent takes that agent's profile (#793)", () => {
  for (const process of CLAUDE_LAUNCHES) {
    test(`foreground ${process.argv.join(" ")}${process.pid === undefined ? " (no pid)" : ""}: sent with Claude's profile`, async () => {
      const { pane, send } = rig({ foreground: [process] });
      const answer = await send("hello there");
      expect(answer.receipt).toMatchObject({ outcome: "sent", harness: "claude", profileId: "claude" });
      expect(pane.submitted).toEqual(["hello there"]);
    });
  }

  test("the multiplexer's own word wins: an agent it names is not read again", async () => {
    const { send, reads } = rig({ harness: "claude", foreground: [{ argv: ["pi"], pid: 7 }] });
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "claude" });
    expect(reads).toEqual([]);
  });

  test("after the launch window let the pane go, the second send still has the profile", async () => {
    // Before #793 the window named the program only until its box took a key: the next send went blind,
    // and the blind road refused it, the reporter's three refusals.
    const { pane, send, startingCalls } = rig({ foreground: [{ argv: ["node", "/home/dev/.npm-global/bin/claude"], pid: 9 }], window: true });
    expect((await send("first")).receipt).toMatchObject({ outcome: "sent", profileId: "claude" });
    expect((await send("second")).receipt).toMatchObject({ outcome: "sent", profileId: "claude" });
    expect(pane.submitted).toEqual(["first", "second"]);
    // A name from the program is not the multiplexer's word: the launch window still reads the pane as unnamed.
    expect(startingCalls).toEqual([null, null]);
  });
});

describe("a pane nothing names stays on the blind road, and its refusal still fires", () => {
  test("a pid whose /proc/<pid>/cmdline is another program's", async () => {
    const { pane, send } = rig({ foreground: [{ argv: ["claude"], pid: 11 }], running: new Map([[11, ["bash"]]]) });
    expectBlindRefusal(await send("hello there"), pane);
  });

  test("a pid the host cannot show (no /proc)", async () => {
    const { pane, send } = rig({ foreground: [{ argv: ["claude"], pid: 12 }], running: new Map() });
    expectBlindRefusal(await send("hello there"), pane);
  });

  test("two agents in the foreground", async () => {
    const { pane, send } = rig({ foreground: [{ argv: ["claude"], pid: 13 }, { argv: ["codex"], pid: 14 }] });
    expectBlindRefusal(await send("hello there"), pane);
  });

  test("a program the table does not know (ssh, a container, a wrapper)", async () => {
    for (const argv of [["ssh", "dev@box"], ["docker", "exec", "-it", "box", "claude"], ["/home/dev/bin/run-claude.sh"], ["bash"]]) {
      const { pane, send } = rig({ foreground: [{ argv, pid: 15 }] });
      expectBlindRefusal(await send("hello there"), pane);
    }
  });

  test("no foreground read (tmux, zellij): nothing changes", async () => {
    const { pane, send } = rig();
    expectBlindRefusal(await send("hello there"), pane);
  });
});
