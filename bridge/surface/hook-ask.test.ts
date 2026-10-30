// A hook-held permission against scripted screens (M56 spec 12). The screens are real captures from
// the fixture corpus; a scripted multiplexer answers every read at revision 0, as Herdr does, and
// records every key. Each race of the hold matrix (experiments/reader-stability/LAB.md, Table 6) has
// a test that records the behaviour: desk first, phone first, both within 50 ms (each winner), the
// hook timeout, the hook connection closing (what the hook sees when the bridge dies is in
// cli/hooks.test.ts), queued requests, a subagent's request, AskUserQuestion and ExitPlanMode, a user
// hook that auto-allows, another Collie first, a hash mismatch. No path sends a key.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST, hostFor } from "../host.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import type { Answer, AskReply } from "../../web/src/lib/surface/ask.ts";
import { emptyFoldState, readFold, stepFold, surfaceOfScreen, type FoldContext } from "../../web/src/lib/surface/fold.ts";
import { HOLD_WIRE_VERSION, holdHash, holdInputHash, type HoldDecision, type HoldRequest } from "../../web/src/lib/surface/hold.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { loadProfiles, profileFor, resetProfileLog } from "../../web/src/lib/surface/profile.ts";
import { isFree, type Ask, type Surface } from "../../web/src/lib/surface/surface.ts";
import { AskAnswerer, AskBook } from "./ask.ts";
import { CLOSE_GRACE_MS, CLOSE_SETTLE_MS, counterWordOf, HoldBook, HoldServer, SENT_SHIELD_MS, takeHold, type EdgeInfo, type HoldConn, type HoldOutcome, type HoldTarget } from "./hold.ts";
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
/** An AskUserQuestion dialog on the main screen: Apple / Banana / Orange. */
const QUESTION = fx("claude--v2283-ask-two-line-question.txt");
/** A subagent's Bash permission drawn on the main screen ("· from the general-purpose agent"). */
const SUB_DIALOG = fx("claude--v2291-permission-bash-subagent.txt");
const SUB_COMMAND =
  'set -e; R=/var/home/devel/apps/sample-forge; T=/tmp/forge-home-build; cd $T/web-forge/src/routes/pane && rm -rf ./* && cd $R && for f in $(git ls-tree -r --name-only HEAD web-forge/src/routes/pane); do mkdir -p $T/$(dirname $f); git show HEAD:$f > $T/$f; done; cd $T/web-forge && bunx vite build --outDir /tmp/sample-forge-home --emptyOutDir 2>&1 | grep -E "MISSING|rror|built in" | head -5';
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

/** A tool edge of one call: the agent, the input it ran, the hook's time. */
function toolEdge(agent: string | null, input = "mkfifo fixture-fifo", over: Partial<EdgeInfo> = {}): EdgeInfo {
  return { tool: "Bash", agent, at: 2, inputHash: holdInputHash("Bash", input), ...over };
}
const TURN_EDGE: EdgeInfo = { tool: null, agent: null, at: 2, inputHash: null };

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
    r.holds.edge(PANE, "tool", toolEdge(null));
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
    // A deny runs no tool, so no tool edge comes: the Sent note ends once the hook's line shows.
    expect(r.holds.note(PANE)).toBeNull();
    expect(r.counted).toEqual(["phone"]);
    expectNoKey(r);
  });

  test("a deny that stops the turn prints Interrupted, as Claude Code 2.1.301 does: the deny took effect", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = `⏺ Bash(mkfifo fixture-fifo)\n  ⎿  Interrupted · What should Claude do instead?\n${IDLE}`;
    };
    const reply = await r.answer(ask, "3");
    expect(reply.receipt?.outcome).toBe("sent");
    expect(reply.receipt?.decision).toBe("deny");
    expectNoKey(r);
  });

  // Second live pass (2026-10-23): "No" from the phone in a fresh session under Claude Code's
  // fullscreen TUI. The Stop button left at once, but the turn read running about 19 s (bridge
  // journal: `surface.hold sent decision=deny` at 16:35:57, `surface.lost-stop` at 16:36:16): the
  // Interrupted row stood twenty rows over the box, past blank rows, outside the band the stopped-row
  // rule read. The answer path's own edges and reads, folded as the shadow folds them.
  test("a deny in a fresh fullscreen session: the fold reads the turn idle and free once the dialog edge settles", async () => {
    const DENIED = fx("claude--v2-1-309-permission-denied-fresh-session--w120.txt");
    const r = rig(BASH);
    const context: FoldContext = { idle: loadProfiles().get(HARNESS)!.idle, pollMs: 1500, settleMs: 1500 };
    let fold = emptyFoldState();
    let seq = 0;
    const edge = (kind: "prompt" | "dialog"): void => void (fold = stepFold(fold, { seq: ++seq, source: "edge", at: r.clock.now, kind }, context));
    const read = (): Surface => {
      const rows = splitLines(parseAnsi(r.pane.screen));
      fold = stepFold(fold, { seq: ++seq, source: "screen", at: r.clock.now, revision: seq, rows, ask: null }, context);
      return readFold(fold, context).surface;
    };
    edge("prompt");
    r.clock.now += 3000;
    // The hold's own fresh read on open (takeHold's `reread`) is a dialog edge.
    const { conn, close } = r.open();
    edge("dialog");
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DENIED;
    };
    const reply = await r.answer(ask, "3");
    expect(reply.receipt).toMatchObject({ outcome: "sent", decision: "deny", keys: [] });
    // The hook's connection closes after the decision: its fresh read is one more dialog edge.
    close("closed");
    edge("dialog");
    r.clock.now += 700;
    // The prompt edge's block is old and ends on the stopped row; the young dialog block keeps the modal.
    const early = read();
    expect(early).toMatchObject({ turn: "idle", modal: "unreadable" });
    expect(isFree(early)).toBe(false);
    r.clock.now += 1500;
    expect(read()).toEqual({ revision: seq, turn: "idle", modal: "none", composer: "empty" });
    expect(fold.running).toBeNull();
    expect(fold.dialog).toBeNull();
    expect(fold.lostStops).toBe(0);
    expectNoKey(r);
  });

  test("the tool edge of this call is proof when no new hook line shows (a group of calls draws one line)", async () => {
    const OLD = `⏺ Bash(touch a)\n  ⎿  Allowed by PermissionRequest hook\n`;
    const r = rig(`${OLD}${BASH}`);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0 && pane.screen !== `${OLD}${IDLE}`) {
        pane.screen = `${OLD}${IDLE}`;
        r.holds.edge(PANE, "tool", toolEdge(null));
      }
    };
    const reply = await r.answer(ask, "1");
    expect(reply.receipt).toMatchObject({ outcome: "sent", decision: "allow", keys: [] });
    expect(r.counted).toEqual(["phone"]);
    expectNoKey(r);
  });

  test("a phone deny, then this call's tool edge: the desk's yes landed first, the reply says so", async () => {
    const r = rig(BASH);
    const { conn } = r.open();
    const ask = r.poll()!;
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0 && pane.screen !== DESK_DONE) {
        pane.screen = DESK_DONE;
        r.holds.edge(PANE, "tool", toolEdge(null));
      }
    };
    const reply = await r.answer(ask, "3");
    expect(conn.replies).toEqual(["deny"]);
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_desk", decision: "deny", keys: [] });
    expect(r.counted).toEqual(["desk"]);
    expect(r.holds.note(PANE)?.state).toBe("desk");
    expectNoKey(r);
  });

  test("an older turn's hook line above the dialog is not this answer's evidence", async () => {
    const OLD = `⏺ Bash(touch a)\n  ⎿  Allowed by PermissionRequest hook\n`;
    const r = rig(`${OLD}${BASH}`);
    const { conn } = r.open();
    const ask = r.poll()!;
    // The hook took the decision, but the screen shows only the old line: no proof, not Sent.
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = `${OLD}${BASH}`;
    };
    const reply = await r.answer(ask, "1");
    expect(conn.replies).toEqual(["allow"]);
    expect(reply.receipt?.outcome).toBe("unknown");
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
    r.holds.edge(PANE, "tool", toolEdge(null));
    expect(conn.released).toBe(1);
    expect(conn.replies).toEqual([]);
    expect(r.holds.note(PANE)?.state).toBe("desk");
  });

  test("a user hook that auto-allows reads as desk first: the tool ran while ours waited", () => {
    const r = rig(IDLE);
    const { conn } = r.open();
    // The dialog never showed: the other hook allowed at once. The tool edge arrives.
    expect(r.poll()?.channel).toBe("hook");
    r.holds.edge(PANE, "tool", toolEdge(null));
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
    expect(reply.detail).toBe("The desk answered first. Collie did not use your answer.");
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
    // A read right after the close may be the last frame before the desk's repaint: no verdict yet.
    expect(r.poll()?.id).toBe(hookAsk.id);
    // A later read still shows the dialog: the hook stopped on its own, not the desk.
    r.clock.now += CLOSE_SETTLE_MS;
    const keysAsk = r.poll()!;
    expect(keysAsk.channel).toBe("keys");
    expect(r.holds.note(PANE)?.state).toBe("void");
    expect(r.counted).toEqual(["void"]);
    expect(conn.replies).toEqual([]);
    const reply = await r.answer(hookAsk, "1");
    expect(reply.receipt?.reason).toBe("ask_gone");
    expectNoKey(r);
  });

  test("desk Esc or No: Claude ends the hook and the dialog leaves the screen, so the desk answered", async () => {
    const r = rig(BASH);
    const { conn, close } = r.open();
    const hookAsk = r.poll()!;
    close("closed");
    r.pane.screen = `⏺ Bash(mkfifo fixture-fifo)\n  ⎿  Interrupted · What should Claude do instead?\n${IDLE}`;
    expect(r.poll()?.id).toBe(hookAsk.id);
    expect(r.poll()).toBeNull();
    expect(r.holds.note(PANE)?.state).toBe("desk");
    expect(r.counted).toEqual(["desk"]);
    expect(conn.replies).toEqual([]);
    expect((await r.answer(hookAsk, "1")).receipt?.reason).toBe("ask_desk");
    expectNoKey(r);
  });

  test("an early close with no read in time is void", () => {
    const r = rig(BASH);
    const { close } = r.open();
    r.poll();
    close("closed");
    r.advance(CLOSE_GRACE_MS);
    expect(r.counted).toEqual(["void"]);
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
    expect(reply.detail).toBe("Another Collie answered. Collie did not use your tap.");
    expect(conn.replies).toEqual([]);
    expectNoKey(r);
  });

  test("a second request of the same agent replaces the first: the first ends void, never desk", () => {
    const r = rig(BASH);
    const first = r.open();
    const a1 = r.poll()!;
    r.pane.screen = EDIT;
    const second = r.open({ tool: "Write", input: "/tmp/project/hello.txt", cwd: "/tmp/project" });
    const a2 = r.poll()!;
    expect(first.conn.released).toBe(1);
    expect(first.conn.replies).toEqual([]);
    expect(r.counted).toEqual(["void"]);
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
    r.holds.edge(PANE, "prompt", TURN_EDGE);
    r.holds.edge(PANE, "tool", toolEdge(null));
    expect(conn.released).toBe(0);
    // No dialog to adopt: only the hold card answers it. A tap from a screen card is refused.
    expect(r.holds.note(PANE)?.adopted).toBe(false);
    expect((await r.answer(ask, "1")).receipt?.reason).toBe("ask_changed");
    expect(conn.replies).toEqual([]);
    const reply = await r.answer(ask, "1", { via: "hold-card" });
    expect(reply.receipt?.outcome).toBe("sent");
    expect(conn.replies).toEqual(["allow"]);
    expect(r.holds.note(PANE)?.state).toBe("sent");
    r.holds.edge(PANE, "tool", toolEdge("agent-7"));
    expect(r.holds.note(PANE)).toBeNull();
    expectNoKey(r);
  });

  test("AskUserQuestion and ExitPlanMode are screen-only: no hold opens, the hook is released at once, the dialog stays a keys ask", () => {
    for (const tool of HOLD.screenOnly) {
      const r = rig(BASH);
      const conn = new FakeConn();
      let reread = 0;
      const lines: string[] = [];
      const held = takeHold(
        { book: r.holds, generation: () => GEN, profile: (h) => loadProfiles().get(h)?.hold, reread: () => reread++, log: (l) => lines.push(l) },
        PANE,
        holdRequest({ tool, hold: false }),
        conn,
        () => undefined,
      );
      expect(held).toBeNull();
      expect(conn.released).toBe(1);
      expect(conn.replies).toEqual([]);
      expect(reread).toBe(1);
      expect(lines).toEqual([`[surface] surface.hold edge-only pane=${PANE} tool=${tool} reason=screen-only`]);
      expect(r.poll()?.channel).toBe("keys");
    }
  });

  test("a cut request is an edge only, even if its hook asked to hold: the person judges on the screen", () => {
    const r = rig(BASH);
    const conn = new FakeConn();
    const lines: string[] = [];
    const held = takeHold(
      { book: r.holds, generation: () => GEN, profile: (h) => loadProfiles().get(h)?.hold, reread: () => undefined, log: (l) => lines.push(l) },
      PANE,
      holdRequest({ cut: true, hold: true }),
      conn,
      () => undefined,
    );
    expect(held).toBeNull();
    expect(conn.released).toBe(1);
    expect(lines).toEqual([`[surface] surface.hold edge-only pane=${PANE} tool=Bash reason=cut`]);
    expect(r.poll()?.channel).toBe("keys");
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
    // The id is not spent: Yes on the same card still reaches the hook.
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = DECIDED;
    };
    expect((await r.answer(ask, "1")).receipt?.outcome).toBe("sent");
    expect(conn.replies).toEqual(["allow"]);
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

describe("a hold owns only the dialog it adopted", () => {
  test("a background subagent's rm while AskUserQuestion shows: the question is a keys ask, a screen tap never reaches the hook", async () => {
    const r = rig(QUESTION);
    const { conn } = r.open({ agent: "agent-9", input: "rm -rf build" });
    // The question is the screen's own dialog: it keeps a keys ask, with its own labels.
    const ask = r.poll()!;
    expect(ask.channel).toBe("keys");
    expect(ask.options.map((o) => o.label)).toContain("Apple");
    // The hold's ask lives in the note only, for the hold card.
    const note = r.holds.note(PANE)!;
    expect(note).toMatchObject({ state: "held", adopted: false, agent: true, options: ["Yes", "No"], input: "rm -rf build" });
    // A "Yes" tapped on a screen card, sent to the hook ask's id, is refused: no decision, no key.
    const hookAsk = { id: note.askId, kind: "permission" as const, options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }], channel: "hook" as const, hash: note.hash };
    const reply = await r.answer(hookAsk, "1");
    expect(reply.receipt).toMatchObject({ outcome: "refused", reason: "ask_changed", keys: [] });
    expect(conn.replies).toEqual([]);
    expect(conn.released).toBe(0);
    expectNoKey(r);
    // The hold card's tap, marked as such, is the decision.
    const fromCard = await r.answer(hookAsk, "2", { via: "hold-card" });
    expect(fromCard.receipt).toMatchObject({ outcome: "sent", decision: "deny", keys: [] });
    expect(conn.replies).toEqual(["deny"]);
    expectNoKey(r);
  });

  test("a main hold whose dialog does not show its input stays unadopted: the dialog is a keys ask", () => {
    const r = rig(BASH);
    r.open({ tool: "Bash", input: "npm run build" });
    const ask = r.poll()!;
    expect(ask.channel).toBe("keys");
    expect(r.holds.note(PANE)?.adopted).toBe(false);
  });

  test("a dialog painted late still adopts when it shows the request, and the profile id answers ask_changed", async () => {
    const r = rig(IDLE);
    const { conn } = r.open();
    const early = r.poll()!;
    r.clock.now += 5000;
    r.pane.screen = BASH;
    const late = r.poll()!;
    expect(late.channel).toBe("hook");
    expect(late.id).not.toBe(early.id);
    expect(r.holds.note(PANE)?.adopted).toBe(true);
    expect((await r.answer(early, "1", { via: "hold-card" })).receipt?.reason).toBe("ask_changed");
    expect(conn.replies).toEqual([]);
  });

  test("a foreground subagent's dialog is adopted: a No on the screen card denies through the hook", async () => {
    const r = rig(SUB_DIALOG);
    const { conn } = r.open({ agent: "agent-3", agentType: "general-purpose", input: SUB_COMMAND });
    const ask = r.poll()!;
    expect(ask.channel).toBe("hook");
    expect(ask.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    expect(r.holds.note(PANE)?.adopted).toBe(true);
    r.pane.beforeRead = (pane) => {
      if (conn.replies.length > 0) pane.screen = `⏺ Bash(set -e)\n  ⎿  Interrupted · What should Claude do instead?\n${IDLE}`;
    };
    const reply = await r.answer(ask, "2");
    expect(reply.receipt).toMatchObject({ outcome: "sent", decision: "deny", keys: [] });
    expectNoKey(r);
  });

  test("a foreground subagent's dialog answered at the desk reads as desk", () => {
    const r = rig(SUB_DIALOG);
    const { conn } = r.open({ agent: "agent-3", agentType: "general-purpose", input: SUB_COMMAND });
    r.poll();
    r.pane.screen = DESK_DONE;
    r.poll();
    expect(r.poll()).toBeNull();
    expect(conn.released).toBe(1);
    expect(r.counted).toEqual(["desk"]);
  });
});

describe("adoption needs the tool, the agent mark and the whole input line", () => {
  test("the review's case: an older background Write of a file with the same name never takes the main Bash dialog", async () => {
    const r = rig(BASH);
    // The background subagent's Write opens first, so it would have had the first chance.
    const write = r.open({ agent: "agent-9", tool: "Write", input: "/tmp/project/fixture-fifo", cwd: "/tmp/project", at: 1 });
    const bash = r.open({ at: 2 });
    const ask = r.poll()!;
    const notes = r.holds.holdsOn(PANE).map((held) => [held.request.tool, held.dialog !== null]);
    expect(notes).toEqual([
      ["Write", false],
      ["Bash", true],
    ]);
    r.pane.beforeRead = (pane) => {
      if (bash.conn.replies.length > 0) pane.screen = DECIDED;
    };
    const reply = await r.answer(ask, "1");
    expect(reply.receipt).toMatchObject({ outcome: "sent", decision: "allow" });
    expect(bash.conn.replies).toEqual(["allow"]);
    // A Yes on the Bash card never allowed the subagent's Write.
    expect(write.conn.replies).toEqual([]);
    expectNoKey(r);
  });

  test("two subagents with the same command but another type: only the type the mark names adopts", () => {
    const r = rig(SUB_DIALOG);
    r.open({ agent: "agent-3", agentType: "Explore", input: SUB_COMMAND, at: 1 });
    r.open({ agent: "agent-4", agentType: "general-purpose", input: SUB_COMMAND, at: 2 });
    r.poll();
    expect(r.holds.holdsOn(PANE).map((held) => [held.request.agentType, held.dialog !== null])).toEqual([
      ["Explore", false],
      ["general-purpose", true],
    ]);
  });

  test("a two-line command whose dialog shows only the first line is not adopted", () => {
    const r = rig(BASH);
    r.open({ input: "mkfifo fixture-fifo\nrm -rf ~" });
    r.poll();
    expect(r.holds.holdsOn(PANE)[0]?.dialog).toBeNull();
  });

  test("a keys answer that ends the hook of a hold that did not adopt the dialog: the note says the keys answered", async () => {
    const r = rig(BASH);
    // Another request's hold, from a subagent: the main dialog stays a keys ask.
    const { close } = r.open({ agent: "agent-9", agentType: "general-purpose", tool: "Write", input: "/tmp/project/other.txt", cwd: "/tmp/project" });
    const keys = r.poll()!;
    expect(keys.channel).toBe("keys");
    r.pane.beforeRead = (pane) => {
      if (r.gate.commits.length > 0 && pane.screen !== IDLE) {
        pane.screen = IDLE;
        close("closed");
      }
    };
    expect((await r.answer(keys, "1")).receipt?.outcome).toBe("sent");
    expect(r.holds.note(PANE)?.state).toBe("keys");
    expect(r.counted).toEqual(["keys"]);
    // The counters file has no word of its own for it: the screen answered.
    expect(counterWordOf("keys")).toBe("desk");
  });

  test("a keys answer, then the request's own tool edge before the hook ends: the note says the keys answered", async () => {
    const r = rig(BASH);
    r.open({ tool: "WebFetch", input: "https://example.com/" });
    const keys = r.poll()!;
    expect(keys.channel).toBe("keys");
    r.pane.beforeRead = (pane) => {
      if (r.gate.commits.length > 0 && pane.screen !== IDLE) {
        pane.screen = IDLE;
        r.holds.edge(PANE, "tool", { tool: "WebFetch", agent: null, at: 2, inputHash: holdInputHash("WebFetch", "https://example.com/") });
      }
    };
    expect((await r.answer(keys, "1")).receipt?.outcome).toBe("sent");
    expect(r.holds.note(PANE)?.state).toBe("keys");
  });

  test("a hook that ends with no keys answer: the note says the hook stopped", () => {
    const r = rig(BASH);
    const { close } = r.open({ agent: "agent-9", agentType: "general-purpose", tool: "Write", input: "/tmp/project/other.txt", cwd: "/tmp/project" });
    r.poll();
    close("closed");
    expect(r.holds.note(PANE)?.state).toBe("void");
  });

  test("two holds that both fit the dialog: none adopts it, the dialog stays a keys ask", () => {
    const r = rig(SUB_DIALOG);
    // Two subagents ask for the same command: no hold can tell which request the dialog shows.
    r.open({ agent: "agent-3", agentType: "general-purpose", input: SUB_COMMAND, at: 1 });
    r.open({ agent: "agent-4", agentType: "general-purpose", input: SUB_COMMAND, at: 2 });
    const ask = r.poll()!;
    expect(r.holds.holdsOn(PANE).map((held) => held.dialog)).toEqual([null, null]);
    // The screen's own dialog keeps its keys ask; each hold waits on its hold card.
    expect(ask.channel).toBe("keys");
  });
});

describe("a tool edge ends only its own call", () => {
  test("an older edge, another input, or an edge with no input hash ends nothing; this call's edge ends it", () => {
    const r = rig(BASH);
    const { conn } = r.open({ at: 100 });
    r.poll();
    r.holds.edge(PANE, "tool", toolEdge(null, "mkfifo fixture-fifo", { at: 99 }));
    r.holds.edge(PANE, "tool", toolEdge(null, "mkfifo other"));
    r.holds.edge(PANE, "tool", toolEdge(null, "mkfifo fixture-fifo", { at: 100, inputHash: null }));
    r.holds.edge(PANE, "tool", toolEdge(null, "mkfifo fixture-fifo", { at: 100, tool: "Write" }));
    expect(conn.released).toBe(0);
    r.holds.edge(PANE, "tool", toolEdge(null, "mkfifo fixture-fifo", { at: 100 }));
    expect(conn.released).toBe(1);
    expect(r.counted).toEqual(["desk"]);
  });
});

describe("holds by pane and agent", () => {
  test("two subagents hold on one pane at once: each keeps its own hold, edges end each by its agent", async () => {
    const r = rig(SUBAGENT_IDLE);
    const a = r.open({ agent: "agent-1", input: "touch a.txt" });
    const b = r.open({ agent: "agent-2", input: "touch b.txt" });
    expect(a.conn.released).toBe(0);
    expect(b.conn.released).toBe(0);
    // The oldest waiting hold carries the Surface's ask and the note.
    const first = r.poll()!;
    expect(r.holds.note(PANE)?.input).toBe("touch a.txt");
    const reply = await r.answer(first, "1", { via: "hold-card" });
    expect(reply.receipt?.outcome).toBe("sent");
    expect(a.conn.replies).toEqual(["allow"]);
    expect(b.conn.replies).toEqual([]);
    // The second shows next. A tool edge of agent-1 does not end agent-2's hold.
    r.holds.edge(PANE, "tool", toolEdge("agent-1", "touch a.txt"));
    expect(r.holds.note(PANE)?.input).toBe("touch b.txt");
    expect(b.conn.released).toBe(0);
    r.holds.edge(PANE, "tool", toolEdge("agent-2", "touch b.txt"));
    expect(b.conn.released).toBe(1);
    expect(r.counted).toEqual(["phone", "desk"]);
  });

  test("a main hold and a subagent hold side by side: the main one adopts the dialog, the subagent one waits on its card", () => {
    const r = rig(BASH);
    r.open({ agent: "agent-1", input: "touch a.txt" });
    r.open();
    const ask = r.poll()!;
    expect(ask.channel).toBe("hook");
    expect(r.holds.note(PANE)).toMatchObject({ adopted: true, input: "mkfifo fixture-fifo" });
    expect(r.holds.holdsOn(PANE)).toHaveLength(2);
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

// The socket is a POSIX file with an owner-only mode. Windows builds no hold yet (see the test below).
const POSIX_ONLY = HOST.platform === "win32";

describe("the hold socket", () => {
  test.skipIf(POSIX_ONLY)("owner-only: the folder is 0700, the socket 0600; a second bridge on the same path does not take it", async () => {
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

  test("no hold socket on Windows yet: start answers false and makes nothing", async () => {
    const path = join(dir, "win", "hold", "sock");
    const logs: string[] = [];
    const server = new HoldServer({ socketPath: path, host: hostFor("win32"), liveness: { startTimeOf: () => Promise.resolve(null) }, targets: () => [], log: (l) => logs.push(l) });
    expect(await server.start()).toBe(false);
    expect(existsSync(join(dir, "win"))).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test.skipIf(POSIX_ONLY)("a pid the bridge cannot place is dropped with one log line, and the connection closes with no decision", async () => {
    const path = join(dir, "state", "hold", "sock");
    const logs: string[] = [];
    const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(null) }, targets: () => [], log: (l) => logs.push(l) });
    await server.start();
    const got = await roundTrip(path, `${JSON.stringify(holdRequest())}\n`);
    expect(got).toBe("");
    expect(logs.filter((l) => l.includes("surface.hold.dropped reason=no-pane pid=4242"))).toHaveLength(1);
    server.stop();
  });

  test.skipIf(POSIX_ONLY)("a placed request reaches the session; the decision travels back as one line", async () => {
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

  test.skipIf(POSIX_ONLY)("a request from another multiplexer's pane is dropped without a log line, a same-namespace miss is logged", async () => {
    const path = join(dir, "state", "hold", "sock");
    const logs: string[] = [];
    const target: HoldTarget = {
      session: "main",
      matcher: { namespace: "herdr-core", notesWithoutHooks: { agentDetection: "", agentSessionRef: "" }, scope: () => Promise.resolve("/run/core.sock"), matches: () => false },
      paneIds: () => [PANE],
      deliver: () => undefined,
    };
    const server = new HoldServer({ socketPath: path, liveness: { startTimeOf: () => Promise.resolve(1234) }, targets: () => [target], log: (l) => logs.push(l) });
    await server.start();
    expect(await roundTrip(path, `${JSON.stringify(holdRequest())}\n`)).toBe("");
    expect(logs).toEqual([]);
    const own = holdRequest({ markers: [{ namespace: "herdr-core", scope: "/run/core.sock", pane: "w9:p9" }] });
    expect(await roundTrip(path, `${JSON.stringify(own)}\n`)).toBe("");
    expect(logs).toEqual([`[surface] surface.hold.dropped reason=no-pane pid=4242`]);
    server.stop();
  });

  test.skipIf(POSIX_ONLY)("an unparsed line is dropped", async () => {
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
