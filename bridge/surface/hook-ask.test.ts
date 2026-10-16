// A hook-held permission against scripted screens (M56 spec 12). The screens are real captures from
// the fixture corpus; a scripted multiplexer answers every read at revision 0, as Herdr does, and
// records every key. Each race of the hold matrix (experiments/reader-stability/LAB.md, Table 6) has
// a test that records the behaviour: desk first, phone first, both within 50 ms (each winner), the
// hook timeout, the hook connection closing (what the hook sees when the bridge dies is in
// cli/hooks.test.ts), queued requests, a subagent's request, AskUserQuestion and ExitPlanMode, a user
// hook that auto-allows, another Collie first, a hash mismatch. No path sends a key.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import type { Answer, AskReply } from "../../web/src/lib/surface/ask.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { HOLD_WIRE_VERSION, holdHash, type HoldDecision, type HoldRequest } from "../../web/src/lib/surface/hold.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { loadProfiles, profileFor, resetProfileLog } from "../../web/src/lib/surface/profile.ts";
import { isFree, type Ask } from "../../web/src/lib/surface/surface.ts";
import { AskAnswerer, AskBook } from "./ask.ts";
import { HoldBook, HoldServer, SENT_SHIELD_MS, takeHold, type HoldConn, type HoldOutcome, type HoldTarget } from "./hold.ts";
import { KeyGate, type GateResult, type KeyToken } from "./key-gate.ts";
import { RowRing, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

/** Claude's Bash permission dialog: Yes / Yes, and don't ask again / No. */
const BASH = fx("claude--permission-bash.txt");
/** A second, different permission dialog. */
const EDIT = fx("claude--permission-edit.txt");
const IDLE = fx("claude--v2301-idle.txt");
/** A subagent's request on 2.1.301: no dialog on the main screen at all (LAB.md Table 6). */
const SUBAGENT_IDLE = fx("claude--v2301-hold-subagent.txt");
/** The screen after the hook decided: the dialog is gone and the result line names the hook. */
const DECIDED = `⏺ Bash(mkfifo fixture-fifo)\n  ⎿  Allowed by PermissionRequest hook\n${IDLE}`;
/** The screen after the desk answered: the dialog is gone, and no line names the hook. */
const DESK_DONE = `⏺ Bash(mkfifo fixture-fifo)\n  ⎿  Done\n${IDLE}`;

const HARNESS = "claude";
const PANE = "%1";
const GEN = "claude:session-1";
const HOLD = loadProfiles().get(HARNESS)!.hold!;

class ScriptPane {
  screen: string;
  keysSeen: string[] = [];
  reads = 0;
  beforeRead: ((pane: ScriptPane, n: number) => void) | null = null;
  constructor(screen: string) {
    this.screen = screen;
  }
  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    this.beforeRead?.(this, this.reads);
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 0 }));
  };
  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    this.keysSeen.push(...keys);
    return Promise.resolve(muxAck());
  };
}

/** A gate that records every token it was asked to commit. A hook-held ask must never reach it. */
class SpyGate extends KeyGate {
  commits: KeyToken[] = [];
  override commit(token: KeyToken): Promise<GateResult> {
    this.commits.push(token);
    return super.commit(token);
  }
}

/** The hook's end of the socket: what the bridge wrote, and whether it let go. */
class FakeConn implements HoldConn {
  replies: HoldDecision[] = [];
  released = 0;
  gone = false;
  reply(decision: HoldDecision): boolean {
    if (this.gone) return false;
    this.replies.push(decision);
    this.gone = true;
    return true;
  }
  release(): void {
    this.released += 1;
    this.gone = true;
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-hold-"));
  resetProfileLog();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function holdRequest(over: Partial<HoldRequest> = {}): HoldRequest {
  return {
    v: HOLD_WIRE_VERSION,
    harness: HARNESS,
    pid: 4242,
    pidStartTime: 1234,
    markers: [{ namespace: "herdr", scope: "/run/herdr.sock", pane: "w1:p1" }],
    tool: "Bash",
    input: "mkfifo fixture-fifo",
    agent: null,
    hold: true,
    at: 1,
    ...over,
  };
}

interface Rig {
  pane: ScriptPane;
  gate: SpyGate;
  book: AskBook;
  holds: HoldBook;
  answerer: AskAnswerer;
  clock: { now: number };
  timers: { at: number; run: () => void; live: boolean }[];
  counted: HoldOutcome[];
  /** One poll, as the shadow publishes it: the ask the phone would see. */
  poll: () => Ask | null;
  answer: (ask: Ask, optionId: string, over?: Partial<Answer>) => Promise<AskReply>;
  /** Open a hold on the pane, through the session's own hand-off. */
  open: (over?: Partial<HoldRequest>) => { conn: FakeConn; close: (how: "closed" | "elsewhere") => void };
  /** Move the clock and run every timer that came due. */
  advance: (ms: number) => void;
}

function rig(screen: string): Rig {
  const pane = new ScriptPane(screen);
  const clock = { now: 2_000_000 };
  const now = (): number => clock.now;
  const gate = new SpyGate(pane, now);
  const store = new RequestStore(join(dir, "sends"), now);
  const timers: Rig["timers"] = [];
  const counted: HoldOutcome[] = [];
  const holds = new HoldBook({
    now,
    salt: "hold-salt",
    log: () => undefined,
    count: (_held, outcome) => counted.push(outcome),
    schedule: (run, ms) => {
      const timer = { at: clock.now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  const book = new AskBook(now, "test-salt");
  book.attachHolds(holds);
  const answerer = new AskAnswerer({
    mux: pane,
    gate,
    store,
    locks: new SessionLocks(),
    book,
    ring: new RowRing(),
    profile: (harness) => Promise.resolve(profileFor(harness, "2.1.301", { log: () => undefined })),
    generation: () => GEN,
    now,
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const poll = (): Ask | null => book.publish(PANE, GEN, liftDialog(readerBlocks(splitLines(parseAnsi(pane.screen)), HARNESS)));
  const answer = (ask: Ask, optionId: string, over: Partial<Answer> = {}): Promise<AskReply> =>
    answerer.handle({ askId: ask.id, hash: ask.hash, optionId, origin: "person_tap", ...over }, { session: "main", paneId: PANE, harness: HARNESS });
  const open: Rig["open"] = (over = {}) => {
    const conn = new FakeConn();
    let listener: ((how: "closed" | "elsewhere") => void) | null = null;
    takeHold(
      { book: holds, generation: () => GEN, profile: (harness) => loadProfiles().get(harness)?.hold, reread: () => undefined },
      PANE,
      holdRequest(over),
      conn,
      (l) => {
        listener = l;
      },
    );
    return { conn, close: (how) => listener?.(how) };
  };
  const advance = (ms: number): void => {
    clock.now += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= clock.now) {
        timer.live = false;
        timer.run();
      }
    }
  };
  return { pane, gate, book, holds, answerer, clock, timers, counted, poll, answer, open, advance };
}

/** No key left Collie: none reached the gate, and the pane saw none. */
function expectNoKey(r: Rig): void {
  expect(r.gate.commits).toEqual([]);
  expect(r.pane.keysSeen).toEqual([]);
}

describe("a hook-held permission publishes a hook ask", () => {
  test("the screen's dialog gives the labels, the hash binds the tool, the input and the labels", () => {
    const r = rig(BASH);
    r.open();
    const ask = r.poll()!;
    expect(ask.channel).toBe("hook");
    expect(ask.kind).toBe("permission");
    expect(ask.options.map((o) => o.label)).toEqual(["Yes", "Yes, and don’t ask again for: mkfifo fixture-fifo *", "No"]);
    expect(ask.hash).toBe(holdHash("Bash", "mkfifo fixture-fifo", ask.options.map((o) => o.label)));
    expect(ask.hash).not.toBe(holdHash("Bash", "mkfifo other", ask.options.map((o) => o.label)));
    expect(ask.hash).not.toBe(holdHash("Edit", "mkfifo fixture-fifo", ask.options.map((o) => o.label)));
    // The same ask on every read while the hold waits: the id is stable.
    expect(r.poll()!.id).toBe(ask.id);
    expect(r.holds.note(PANE)?.state).toBe("held");
  });

  test("a keys ask minted before the hook connected is voided: its tap sends no key", async () => {
    const r = rig(BASH);
    const keysAsk = r.poll()!;
    expect(keysAsk.channel).toBe("keys");
    r.open();
    const hookAsk = r.poll()!;
    expect(hookAsk.channel).toBe("hook");
    expect(hookAsk.id).not.toBe(keysAsk.id);
    const reply = await r.answer(keysAsk, "1");
    expect(reply.receipt?.outcome).toBe("refused");
    expectNoKey(r);
  });
});

describe("the hold matrix", () => {
  test("phone first: the tap allows through the hook, no key, Sent until the tool edge", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    // The check read still shows the dialog; once the decision is out, the hook's line shows.
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DECIDED;
    };
    const reply = await r.answer(ask, "1");
    expect(reply.receipt?.outcome).toBe("sent");
    expect(reply.receipt?.channel).toBe("hook");
    expect(reply.receipt?.decision).toBe("allow");
    expect(reply.receipt?.keys).toEqual([]);
    expect(conn.replies).toEqual(["allow"]);
    expectNoKey(r);
    expect(r.holds.note(PANE)?.state).toBe("sent");
    expect(r.counted).toEqual(["phone"]);
    // The tool edge ends the Sent card.
    r.holds.edge(PANE, "tool", { tool: "Bash", agent: null });
    expect(r.holds.note(PANE)).toBeNull();
  });

  test("phone first with No: the hook denies, no key", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = `⏺ Bash(mkfifo fixture-fifo)\n  ⎿  Denied by PermissionRequest hook\n${IDLE}`;
    };
    const reply = await r.answer(ask, "3");
    expect(reply.receipt?.outcome).toBe("sent");
    expect(reply.receipt?.decision).toBe("deny");
    expect(conn.replies).toEqual(["deny"]);
    expectNoKey(r);
  });

  test("desk first: the dialog leaves the screen, the hook is released, the card says answered at the desk", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.screen = DESK_DONE;
    // One read can miss a dialog that is still up, so the hook ask stays; two in a row cannot.
    expect(r.poll()?.id).toBe(ask.id);
    expect(conn.released).toBe(0);
    expect(r.poll()).toBeNull();
    expect(conn.released).toBe(1);
    expect(conn.replies).toEqual([]);
    expect(r.holds.note(PANE)?.state).toBe("desk");
    expect(r.counted).toEqual(["desk"]);
    // A late tap on the old card is refused and never becomes keys or a decision.
    const reply = await r.answer(ask, "1");
    expect(reply.receipt?.reason).toBe("ask_desk");
    expect(conn.replies).toEqual([]);
    expectNoKey(r);
  });

  test("desk first, seen by the tool edge before the screen: released, answered at the desk", () => {
    const r = rig(BASH);
    const { conn } = r.open();
    r.poll();
    r.holds.edge(PANE, "tool", { tool: "Bash", agent: null });
    expect(conn.released).toBe(1);
    expect(conn.replies).toEqual([]);
    expect(r.holds.note(PANE)?.state).toBe("desk");
  });

  test("a user hook that auto-allows reads as desk first: the tool ran while ours waited", () => {
    const r = rig(IDLE);
    const { conn } = r.open();
    // The dialog never showed: the other hook allowed at once. The tool edge arrives.
    expect(r.poll()?.channel).toBe("hook");
    r.holds.edge(PANE, "tool", { tool: "Bash", agent: null });
    expect(conn.released).toBe(1);
    expect(conn.replies).toEqual([]);
    expect(r.counted).toEqual(["desk"]);
  });

  test("both within 50 ms, desk first by a hair: the check read shows no dialog, no decision goes out", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      pane.screen = DESK_DONE;
    };
    const reply = await r.answer(ask, "1");
    expect(reply.receipt?.reason).toBe("ask_desk");
    expect(conn.replies).toEqual([]);
    expect(conn.released).toBe(1);
    expectNoKey(r);
  });

  test("both within 50 ms, the desk key lands after the check: the hook's answer is ignored, the phone's answer is voided and the reply says so", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DESK_DONE;
    };
    const reply = await r.answer(ask, "3");
    expect(conn.replies).toEqual(["deny"]);
    expect(reply.receipt?.outcome).toBe("refused");
    expect(reply.receipt?.reason).toBe("ask_desk");
    expect(reply.detail).toBe("The desk answered first. Your answer was not used.");
    expect(r.holds.note(PANE)?.state).toBe("desk");
    expect(r.counted).toEqual(["desk"]);
    expectNoKey(r);
  });

  test("both within 50 ms, the phone first while the harness still holds: the hook's answer wins", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DECIDED;
    };
    const reply = await r.answer(ask, "1");
    expect(reply.receipt?.outcome).toBe("sent");
    expect(r.counted).toEqual(["phone"]);
  });

  test("hook timeout: the card is voided, the dialog is re-lifted as a new ask with a new id, the old tap never becomes keys", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const hookAsk = r.poll()!;
    r.advance(HOLD.limitMs);
    expect(conn.released).toBe(1);
    expect(conn.replies).toEqual([]);
    expect(r.holds.note(PANE)?.state).toBe("timeout");
    expect(r.counted).toEqual(["timeout"]);
    const keysAsk = r.poll()!;
    expect(keysAsk.channel).toBe("keys");
    expect(keysAsk.id).not.toBe(hookAsk.id);
    const reply = await r.answer(hookAsk, "1");
    expect(reply.receipt?.outcome).toBe("refused");
    expect(reply.receipt?.reason).toBe("ask_gone");
    expect(reply.ask?.id).toBe(keysAsk.id);
    expectNoKey(r);
  });

  test("the hook stops mid-hold (killed, or its connection drops): voided, the dialog stays and is re-lifted", async () => {
    const r = rig(BASH);
    const { conn, close } = r.open();
    const hookAsk = r.poll()!;
    close("closed");
    expect(r.holds.note(PANE)?.state).toBe("void");
    expect(r.counted).toEqual(["void"]);
    expect(conn.replies).toEqual([]);
    const keysAsk = r.poll()!;
    expect(keysAsk.channel).toBe("keys");
    const reply = await r.answer(hookAsk, "1");
    expect(reply.receipt?.reason).toBe("ask_gone");
    expectNoKey(r);
  });

  test("a close at the limit is the hook's own timer: timeout", () => {
    const r = rig(BASH);
    const { close } = r.open();
    r.poll();
    r.clock.now += HOLD.limitMs - 1000;
    close("closed");
    expect(r.counted).toEqual(["timeout"]);
  });

  test("another Collie answered first: the hook says so, the card says answered elsewhere", async () => {
    const r = rig(BASH);
    const { conn, close } = r.open();
    const ask = r.poll()!;
    close("elsewhere");
    expect(r.holds.note(PANE)?.state).toBe("elsewhere");
    expect(r.counted).toEqual(["elsewhere"]);
    const reply = await r.answer(ask, "1");
    expect(reply.receipt?.reason).toBe("ask_desk");
    expect(reply.detail).toBe("Answered on another Collie. Your tap was not used.");
    expect(conn.replies).toEqual([]);
    expectNoKey(r);
  });

  test("two queued requests: the second hold ends the first as desk first, one ask at a time", () => {
    const r = rig(BASH);
    const first = r.open();
    const a1 = r.poll()!;
    r.pane.screen = EDIT;
    const second = r.open({ tool: "Edit", input: "/tmp/x" });
    const a2 = r.poll()!;
    expect(first.conn.released).toBe(1);
    expect(a2.id).not.toBe(a1.id);
    expect(a2.channel).toBe("hook");
    expect(second.conn.released).toBe(0);
  });

  test("a subagent's request: no dialog on the screen, the hook ask makes the modal present, the tool edge ends Sent", async () => {
    const r = rig(SUBAGENT_IDLE);
    const { conn } = r.open({ agent: "agent-7" });
    const ask = r.poll()!;
    expect(ask.channel).toBe("hook");
    expect(ask.options.map((o) => o.label)).toEqual(HOLD.options.map((o) => o.label));
    // The screen alone reads a free composer; with the hook ask the Surface is not free.
    const rows = splitLines(parseAnsi(SUBAGENT_IDLE));
    const idle = loadProfiles().get(HARNESS)!.idle;
    expect(isFree(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 0, rows, ask: null }, idle).surface)).toBe(true);
    expect(isFree(surfaceOfScreen({ seq: 1, source: "screen", at: 0, revision: 0, rows, ask }, idle).surface)).toBe(false);
    // A turn edge of the main session does not end a subagent's hold; a main tool edge neither.
    r.holds.edge(PANE, "prompt", { tool: null, agent: null });
    r.holds.edge(PANE, "tool", { tool: "Bash", agent: null });
    expect(conn.released).toBe(0);
    const reply = await r.answer(ask, "1");
    expect(reply.receipt?.outcome).toBe("sent");
    expect(conn.replies).toEqual(["allow"]);
    expect(r.holds.note(PANE)?.state).toBe("sent");
    r.holds.edge(PANE, "tool", { tool: "Bash", agent: "agent-7" });
    expect(r.holds.note(PANE)).toBeNull();
    expectNoKey(r);
  });

  test("AskUserQuestion and ExitPlanMode are screen-only: no hold opens, the hook is released at once, the dialog stays a keys ask", () => {
    for (const tool of HOLD.screenOnly) {
      const r = rig(BASH);
      const conn = new FakeConn();
      let reread = 0;
      const held = takeHold(
        { book: r.holds, generation: () => GEN, profile: (h) => loadProfiles().get(h)?.hold, reread: () => reread++ },
        PANE,
        holdRequest({ tool, hold: false }),
        conn,
        () => undefined,
      );
      expect(held).toBeNull();
      expect(conn.released).toBe(1);
      expect(conn.replies).toEqual([]);
      expect(reread).toBe(1);
      expect(r.poll()?.channel).toBe("keys");
    }
  });

  test("a relabel: the labels came from the screen a moment later, the replaced id answers ask_changed and the hold stays", async () => {
    const r = rig(IDLE);
    const { conn } = r.open();
    const early = r.poll()!;
    expect(early.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    r.pane.screen = BASH;
    const late = r.poll()!;
    expect(late.id).not.toBe(early.id);
    expect(late.options).toHaveLength(3);
    const reply = await r.answer(early, "1");
    expect(reply.receipt?.reason).toBe("ask_changed");
    expect(reply.ask?.id).toBe(late.id);
    expect(conn.released).toBe(0);
    expectNoKey(r);
  });

  test("an option the hook cannot state (don't ask again) is refused no_plan; the hold stays", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    const reply = await r.answer(ask, "2");
    expect(reply.receipt?.reason).toBe("no_plan");
    expect(conn.replies).toEqual([]);
    expect(conn.released).toBe(0);
    expectNoKey(r);
  });

  test("the same tap twice replays its receipt; another option on a spent id is refused", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DECIDED;
    };
    const first = await r.answer(ask, "1");
    const again = await r.answer(ask, "1");
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt!);
    const other = await r.answer(ask, "3");
    expect(other.receipt?.reason).toBe("ask_answered");
    expect(conn.replies).toEqual(["allow"]);
  });

  test("the pane keeps the hook ask a moment after Sent, so the closing dialog never gets a keys id", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DECIDED;
    };
    await r.answer(ask, "1");
    r.pane.screen = BASH;
    r.pane.beforeRead = null;
    expect(r.poll()?.id).toBe(ask.id);
    r.clock.now += SENT_SHIELD_MS + 1;
    expect(r.poll()?.channel).toBe("keys");
  });
});

describe("mismatch", () => {
  test("a hash mismatch releases the hook with no decision and re-lifts the dialog as a keys ask", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    const reply = await r.answer(ask, "1", { hash: "deadbeef000000" });
    expect(reply.receipt?.outcome).toBe("refused");
    expect(reply.receipt?.reason).toBe("ask_changed");
    expect(conn.replies).toEqual([]);
    expect(conn.released).toBe(1);
    expect(r.counted).toEqual(["mismatch"]);
    expect(reply.ask?.channel).toBe("keys");
    expect(reply.ask?.id).not.toBe(ask.id);
    expect(r.holds.note(PANE)?.state).toBe("mismatch");
    expectNoKey(r);
  });
});

describe("no key", () => {
  test("no key is ever sent for a hook-held ask, on any path", async () => {
    const paths: ((r: Rig, ask: Ask, conn: FakeConn) => Promise<AskReply>)[] = [
      (r, ask, conn) => {
        r.pane.beforeRead = (pane) => {
          if (conn.replies.length > 0) pane.screen = DECIDED;
        };
        return r.answer(ask, "1");
      },
      (r, ask) => r.answer(ask, "2"),
      (r, ask) => r.answer(ask, "3", { hash: "0000000000000f" }),
      (r, ask) => {
        r.pane.beforeRead = (pane) => {
          pane.screen = DESK_DONE;
        };
        return r.answer(ask, "1");
      },
      (r, ask) => {
        r.advance(HOLD.limitMs);
        return r.answer(ask, "1");
      },
      (r, ask) => r.answer(ask, "9"),
    ];
    for (const path of paths) {
      const r = rig(BASH);
      const { conn } = r.open();
      const ask = r.poll()!;
      await path(r, ask, conn);
      expectNoKey(r);
    }
  });
});

describe("the hold socket", () => {
  test("owner-only: the folder is 0700, the socket 0600; a second bridge on the same path does not take it", async () => {
    const path = join(dir, "state", "hold", "sock");
    const logs: string[] = [];
    const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(null) }, targets: () => [], log: (l) => logs.push(l) });
    expect(await server.start()).toBe(true);
    expect(statSync(join(dir, "state", "hold")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(null) }, targets: () => [], log: (l) => logs.push(l) });
    expect(await second.start()).toBe(false);
    expect(logs.some((l) => l.includes("another bridge listens"))).toBe(true);
    server.stop();
  });

  test("a pid the bridge cannot place is dropped with one log line, and the connection closes with no decision", async () => {
    const path = join(dir, "state", "hold", "sock");
    const logs: string[] = [];
    const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(null) }, targets: () => [], log: (l) => logs.push(l) });
    await server.start();
    const got = await roundTrip(path, `${JSON.stringify(holdRequest())}\n`);
    expect(got).toBe("");
    expect(logs.filter((l) => l.includes("surface.hold.dropped reason=no-pane pid=4242"))).toHaveLength(1);
    server.stop();
  });

  test("a placed request reaches the session; the decision travels back as one line", async () => {
    const path = join(dir, "state", "hold", "sock");
    const target: HoldTarget = {
      session: "main",
      matcher: { namespace: "herdr", notesWithoutHooks: { agentDetection: "", agentSessionRef: "" }, scope: () => Promise.resolve("/run/herdr.sock"), matches: (pane, marker) => marker.pane === "w1:p1" && pane.paneId === PANE },
      paneIds: () => [PANE],
      deliver: () => undefined,
      hold: (_pane, _request, conn) => {
        conn.reply("allow");
      },
    };
    const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(1234) }, targets: () => [target], log: () => undefined });
    await server.start();
    const got = await roundTrip(path, `${JSON.stringify(holdRequest())}\n`);
    expect(got).toBe(`${JSON.stringify({ decision: "allow" })}\n`);
    server.stop();
  });

  test("an unparsed line is dropped", async () => {
    const path = join(dir, "state", "hold", "sock");
    const logs: string[] = [];
    const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(1234) }, targets: () => [], log: (l) => logs.push(l) });
    await server.start();
    expect(await roundTrip(path, "{not json}\n")).toBe("");
    expect(logs.some((l) => l.includes("reason=unparsed"))).toBe(true);
    server.stop();
  });
});

/** Connect, send one line, collect everything until the bridge closes. */
function roundTrip(path: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const conn = createConnection({ path });
    let out = "";
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write(line));
    conn.on("data", (chunk: string) => {
      out += chunk;
    });
    conn.on("close", () => resolve(out));
    conn.on("error", reject);
    setTimeout(() => {
      conn.destroy();
      resolve(out);
    }, 3000).unref();
  });
}
