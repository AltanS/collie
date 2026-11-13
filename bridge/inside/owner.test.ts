// The owner rule of M99 spec 04, per dialog (the lead's design after the review): a part owns a
// permission dialog only while its live hold for that pane and that dialog exists; the fallback to the
// screen reader when the part's hold ends or the part goes away.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { shownInputOf, type HoldRequest } from "../../web/src/lib/surface/hold.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { loadProfiles } from "../../web/src/lib/surface/profile.ts";
import { AskBook } from "../surface/ask.ts";
import { HoldBook, takeHold } from "../surface/hold.ts";
import { PartAsks, sameDialog } from "./asks.ts";
import { ownerHold } from "./owner.ts";

const PANE = "%1";
const GEN = "claude:session-1";
const BASH = readFileSync(join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes", "claude--permission-bash.txt"), "utf8");
const HOLD = loadProfiles().get("claude")!.hold!;
const INPUT = { command: "mkfifo fixture-fifo", description: "Make a fifo" };
const SHOWN = shownInputOf(INPUT, HOLD.inputShown, HOLD.inputDetails.Bash).text;

function hookRequest(over: Partial<HoldRequest> = {}): HoldRequest {
  return { v: 1, harness: "claude", pid: 4242, pidStartTime: 1234, markers: [], tool: "Bash", input: SHOWN, agent: null, hold: true, at: 1, ...over };
}

function conn() {
  const c = { released: 0, replies: 0, reply: () => ((c.replies += 1), true), release: () => void (c.released += 1) };
  return c;
}

/** One session: the hold book, the screen asks, the part's asks, and the hook's door under the rule. */
function rig() {
  const timers: (() => void)[] = [];
  const holds = new HoldBook({ now: () => 2_000_000, salt: "hold-salt", log: () => undefined, schedule: (run) => (timers.push(run), () => undefined) });
  const book = new AskBook(() => 2_000_000, "salt");
  book.attachHolds(holds);
  const deps = { book: holds, generation: () => GEN, profile: (harness: string) => loadProfiles().get(harness)?.hold, reread: () => undefined };
  const asks = new PartAsks({
    sessionOf: () => ({
      harnessOf: () => "claude",
      holdProfile: (harness) => loadProfiles().get(harness)?.hold,
      takeHold: (paneId, request, c, onClose) => takeHold(deps, paneId, request, c, onClose),
      settle: (held, outcome) => (outcome === "void" ? holds.end(held, "void") : holds.settle(held, outcome)),
    }),
    enqueue: () => ({ ok: true }),
  });
  const lines: string[] = [];
  const hook = ownerHold(
    (paneId, request) => asks.ownsDialog("main", paneId, request),
    (paneId, request, c, onClose) => {
      takeHold(deps, paneId, request, c, onClose);
    },
    (line) => lines.push(line),
  );
  const part = { partId: "p".repeat(22), address: { session: "main", paneId: PANE }, capabilities: new Set(["send", "wake"] as const), asks: new Set(["permission"] as const), boundAt: 0, pid: 4242, pidStartTime: 7 };
  const poll = () => book.publish(PANE, GEN, liftDialog(readerBlocks(splitLines(parseAnsi(BASH)), "claude")));
  const elapse = (): void => {
    for (const run of timers.splice(0)) run();
  };
  return { holds, asks, hook, part, poll, lines, elapse };
}

describe("sameDialog", () => {
  test("the same pane, tool, input and main agent, on a live hold", () => {
    const held = { paneId: PANE, state: "held" as const, request: hookRequest() };
    expect(sameDialog(held, PANE, hookRequest())).toBe(true);
    expect(sameDialog({ ...held, state: "ended" }, PANE, hookRequest())).toBe(false);
    expect(sameDialog(held, "%2", hookRequest())).toBe(false);
    expect(sameDialog(held, PANE, hookRequest({ tool: "Edit" }))).toBe(false);
    expect(sameDialog(held, PANE, hookRequest({ input: "other" }))).toBe(false);
    expect(sameDialog(held, PANE, hookRequest({ agent: "sub-1" }))).toBe(false);
  });
});

describe("the owner rule", () => {
  test("no part hold: the hook's request is held as today, and its card is the one card", () => {
    const r = rig();
    const c = conn();
    r.hook(PANE, hookRequest(), c, () => undefined);
    expect(c.released).toBe(0);
    expect(r.poll()?.channel).toBe("hook");
  });

  test("a live part hold for the dialog: the hook's request is let go at once with no decision", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    const c = conn();
    r.hook(PANE, hookRequest(), c, () => undefined);
    expect(c).toMatchObject({ released: 1, replies: 0 });
    expect(r.lines).toEqual([`[inside] hook hold let go pane=${PANE} tool=Bash: a part holds this dialog`]);
    expect(r.poll()?.channel).toBe("hook");
  });

  test("a subagent's request on a pane with a part hold is not the part's: the hook keeps it", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    const c = conn();
    r.hook(PANE, hookRequest({ agent: "sub-1" }), c, () => undefined);
    expect(c.released).toBe(0);
  });

  test("the fallback: the part's hold ends, and the hook's next request is held again", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    r.asks.closed(r.part.partId, "perm-1");
    const c = conn();
    r.hook(PANE, hookRequest(), c, () => undefined);
    expect(c.released).toBe(0);
  });

  test("the fallback: the part goes away mid hold, and the open dialog is a keys ask again", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    expect(r.poll()?.channel).toBe("hook");
    r.asks.gone(r.part.partId);
    r.elapse();
    expect(r.poll()?.channel).toBe("keys");
  });
});
