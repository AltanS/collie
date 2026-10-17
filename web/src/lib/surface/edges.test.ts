import { describe, expect, it } from "vitest";

import { fixtureRows, idleFor } from "../../test/surface-corpus";
import { closingReceipt, edgeKindOf, EDGE_KINDS, invertEdge, LOST_STOP_SPAN_MS, normalizePrompt, RECEIPT_EDGE_SHORT_MS, RECEIPT_EDGE_WINDOW_MS, SETTLE_MS, type EdgeKind } from "./edges";
import { emptyFoldState, foldSurface, readFold, stepFold, type FoldContext, type SurfaceInput } from "./fold";
import { liftAsk, readerBlocks } from "./lift";
import { requireProfile } from "./profile";
import { isFree, modalWord } from "./surface";

// M56 spec 11: hook edges in the fold. An edge may say running or a modal is up, and never makes a
// free. An edge newer than the read makes it stale only once the read is two poll intervals old
// (2026-10-17): a young read keeps its verdict until the fresh read the edge asks for. Only the screen ends a turn; three free reads over ten seconds end a block
// that lost its Stop.

const CONTEXT: FoldContext = { idle: idleFor("claude"), pollMs: 1000 };
const IDLE = "claude--fresh-idle.txt";
const RUNNING = "claude--working-esc-to-interrupt.txt";
const DIALOG = "claude--permission-bash.txt";

let seq = 0;
function read(name: string, at: number): SurfaceInput {
  const rows = fixtureRows(name);
  return { seq: ++seq, source: "screen", at, revision: at + 1, rows, ask: liftAsk(readerBlocks(rows, "claude"), at + 1) };
}
function edge(kind: EdgeKind, at: number): SurfaceInput {
  return { seq: ++seq, source: "edge", at, kind };
}
function tick(at: number): SurfaceInput {
  return { seq: ++seq, source: "tick", at };
}

describe("edge kinds", () => {
  it("maps an event through the profile, Event:detail before Event, else reread", () => {
    const events = requireProfile("claude").edges?.events ?? {};
    expect(edgeKindOf(events, "Stop", null)).toBe("stop");
    expect(edgeKindOf(events, "Notification", "permission_prompt")).toBe("dialog");
    expect(edgeKindOf(events, "Notification", "auth_success")).toBe("reread");
    // PostToolUse is the tool edge of a hook-held permission (M56 spec 12); an event the profile does
    // not map stays a re-read.
    expect(edgeKindOf(events, "PostToolUse", null)).toBe("tool");
    expect(edgeKindOf(events, "PreToolUse", null)).toBe("reread");
  });

  it("inverts every kind, and the inversion is never the kind itself but for reread and tool", () => {
    // A tool edge is a re-read for the fold, so a lying one changes nothing there either.
    for (const kind of EDGE_KINDS) if (kind !== "reread" && kind !== "tool") expect(invertEdge(kind)).not.toBe(kind);
    expect(invertEdge("tool")).toBe("tool");
  });

  it("normalizes a prompt: line breaks and outer white space", () => {
    expect(normalizePrompt("  a\r\nb\rc \n")).toBe("a\nb\nc");
  });
});

describe("the fold with edges", () => {
  it("an edge newer than a young read keeps the read's verdict: no stale flicker on a tool edge a second", () => {
    for (const kind of ["reread", "tool", "stop"] as const) {
      const young = foldSurface([read(IDLE, 0), edge(kind, 100)], CONTEXT).surface;
      expect(young.reason).toBeUndefined();
      expect(isFree(young)).toBe(true);
      // Exactly two poll intervals is not older than two.
      expect(isFree(foldSurface([read(IDLE, 0), edge(kind, 2 * CONTEXT.pollMs)], CONTEXT).surface)).toBe(true);
    }
    // A running read stays running under a young edge: it never turns into a stale `unknown`.
    const running = foldSurface([edge("prompt", 0), read(RUNNING, 700), edge("tool", 900), edge("tool", 1300)], CONTEXT).surface;
    expect(running).toMatchObject({ turn: "running" });
    expect(running.reason).toBeUndefined();
  });

  it("an edge newer than a read older than two poll intervals marks it stale until a newer read", () => {
    const log = [read(IDLE, 0), edge("reread", 2 * CONTEXT.pollMs + 1)];
    const stale = foldSurface(log, CONTEXT).surface;
    expect(stale.reason).toBe("stale");
    expect(isFree(stale)).toBe(false);
    expect(isFree(foldSurface([...log, read(IDLE, 2 * CONTEXT.pollMs + 700)], CONTEXT).surface)).toBe(true);
  });

  it("never free: a Stop edge with the spinner still on screen keeps the turn running", () => {
    const log = [edge("prompt", 0), read(RUNNING, 700), edge("stop", 5000), read(RUNNING, 5020)];
    const surface = foldSurface(log, CONTEXT).surface;
    expect(surface.turn).toBe("running");
    expect(isFree(surface)).toBe(false);
  });

  it("never free: no edge kind, in any order, frees a dialog on screen", () => {
    for (const kind of EDGE_KINDS) {
      for (const before of [true, false]) {
        const log = before ? [edge(kind, 0), read(DIALOG, 700)] : [read(DIALOG, 0), edge(kind, 100), read(DIALOG, 800)];
        expect(isFree(foldSurface(log, CONTEXT).surface)).toBe(false);
      }
    }
  });

  it("never free: a Stop edge alone, with no read after it, leaves a running read running, and an old read stale", () => {
    const running = foldSurface([edge("prompt", 0), read(RUNNING, 700), edge("stop", 900)], CONTEXT).surface;
    expect(running.turn).toBe("running");
    expect(isFree(running)).toBe(false);
    const old = foldSurface([edge("prompt", 0), read(IDLE, 700), edge("stop", 700 + 2 * CONTEXT.pollMs + 1)], CONTEXT).surface;
    expect(old.reason).toBe("stale");
    expect(isFree(old)).toBe(false);
  });

  it("a running edge younger than the settle time and a free screen read as contested", () => {
    const surface = foldSurface([edge("prompt", 0), read(IDLE, 700)], CONTEXT).surface;
    expect(surface.turn).toBe("unknown");
    expect(surface.reason).toBe("contested");
  });

  it("settle time comes from the profile", () => {
    expect(requireProfile("claude").edges?.settleMs).toBe(SETTLE_MS);
    const late = foldSurface([edge("prompt", 0), read(IDLE, 700)], { ...CONTEXT, settleMs: 500 }).surface;
    expect(late.turn).toBe("running");
    expect(late.reason).toBeUndefined();
  });

  it("an older running edge keeps an idle screen running until a closing edge", () => {
    const held = [edge("prompt", 0), read(IDLE, 2000)];
    expect(foldSurface(held, CONTEXT).surface.turn).toBe("running");
    expect(isFree(foldSurface([...held, edge("stop", 2100), read(IDLE, 2800)], CONTEXT).surface)).toBe(true);
  });

  it("a lost Stop: three free reads over ten seconds end the block and count one incident", () => {
    let state = emptyFoldState();
    for (const input of [edge("prompt", 0), read(RUNNING, 700), read(IDLE, 2000), read(IDLE, 6000)]) state = stepFold(state, input, CONTEXT);
    expect(readFold(state, CONTEXT).surface.turn).toBe("running");
    state = stepFold(state, read(IDLE, 2000 + LOST_STOP_SPAN_MS - 1), CONTEXT);
    expect(isFree(readFold(state, CONTEXT).surface)).toBe(false);
    state = stepFold(state, read(IDLE, 2000 + LOST_STOP_SPAN_MS), CONTEXT);
    expect(isFree(readFold(state, CONTEXT).surface)).toBe(true);
    expect(state.lostStops).toBe(1);
  });

  it("a non-free read restarts the lost-Stop count", () => {
    const log = [edge("prompt", 0), read(IDLE, 2000), read(RUNNING, 6000), read(IDLE, 9000), read(IDLE, 12_100)];
    const state = log.reduce((s, input) => stepFold(s, input, CONTEXT), emptyFoldState());
    expect(state.lostStops).toBe(0);
    expect(readFold(state, CONTEXT).surface.turn).toBe("running");
  });

  it("a read taken before the newest one changes nothing: an older idle read never replaces a dialog", () => {
    let state = emptyFoldState();
    for (const input of [edge("stop", 0), read(DIALOG, 700), read(IDLE, 500)]) state = stepFold(state, input, CONTEXT);
    const surface = readFold(state, CONTEXT).surface;
    expect(modalWord(surface.modal)).toBe("ask");
    expect(isFree(surface)).toBe(false);
  });

  it("no clock ends a block: ticks alone never make a free", () => {
    const log = [edge("prompt", 0), read(IDLE, 2000), tick(60_000)];
    expect(isFree(foldSurface(log, CONTEXT).surface)).toBe(false);
  });

  it("a dialog edge reads unreadable over a screen that shows none, until the screen lifts the ask", () => {
    const hidden = foldSurface([edge("dialog", 0), read(IDLE, 700)], CONTEXT).surface;
    expect(modalWord(hidden.modal)).toBe("unreadable");
    const lifted = [edge("dialog", 0), read(DIALOG, 700)];
    expect(modalWord(foldSurface(lifted, CONTEXT).surface.modal)).toBe("ask");
    // The screen took the ask over, so the block is done: the next free screen is free.
    expect(isFree(foldSurface([...lifted, read(IDLE, 1500)], CONTEXT).surface)).toBe(true);
  });

  it("the fold's source list drops the edges, and then the screen alone decides", () => {
    const log = [edge("prompt", 0), read(IDLE, 700)];
    const surface = foldSurface(log, { ...CONTEXT, sources: ["screen", "tick"] }).surface;
    expect(isFree(surface)).toBe(true);
  });
});

describe("receipts", () => {
  const open = [
    { id: "a", paneId: "p", promptHash: "h1", at: 1000 },
    { id: "b", paneId: "p", promptHash: "h1", at: 2000 },
    { id: "c", paneId: "q", promptHash: "h1", at: 3000 },
  ];

  it("a prompt edge closes the newest matching receipt on its pane", () => {
    expect(closingReceipt(open, "p", "h1", 2100)?.id).toBe("b");
  });

  it("closes nothing on another hash, another pane, or past the window", () => {
    expect(closingReceipt(open, "p", "h2", 2100)).toBeNull();
    expect(closingReceipt(open, "r", "h1", 2100)).toBeNull();
    expect(closingReceipt(open, "p", "h1", 2000 + 11 * 60_000)).toBeNull();
  });

  it("a desk-typed prompt with the same text 31 s later closes no free-box receipt", () => {
    expect(closingReceipt(open, "p", "h1", 2000 + RECEIPT_EDGE_SHORT_MS)?.id).toBe("b");
    expect(closingReceipt(open, "p", "h1", 2000 + RECEIPT_EDGE_SHORT_MS + 1_000)).toBeNull();
  });

  it("a queued receipt stays open for ten minutes: the harness takes it when the turn ends", () => {
    const queued = [{ id: "q", paneId: "p", promptHash: "h1", at: 1000, queued: true }];
    expect(closingReceipt(queued, "p", "h1", 1000 + 9 * 60_000)?.id).toBe("q");
    expect(closingReceipt(queued, "p", "h1", 1000 + RECEIPT_EDGE_WINDOW_MS + 1)).toBeNull();
  });

  it("an edge written before the submit key went out closes nothing", () => {
    expect(closingReceipt([{ id: "a", paneId: "p", promptHash: "h1", at: 1000, queued: true }], "p", "h1", 999)).toBeNull();
  });
});
