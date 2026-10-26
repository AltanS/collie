// Holds that should not have been holds (omp gang three, tester 2 "02-desync", Herdr 0.9.5, 2026-10-26).
//
// 1. A send right after a client resize: for 50 to 100 ms Herdr shows the old frame re-wrapped to the
//    new width, so S0 read a frame on its way and the send was held `not_free` on an idle, empty pane,
//    then went about 42 s later. S0 now reads once more after SETTLE_MS when the geometry is in flux.
// 2. A stale row painted over the live box row while omp's live editor held `xy` (h 21 and 23 on
//    18.12.6): the probe went in and out cleanly, the box then read `xy`, and the send was held, so it
//    went out later behind the person's Replace. A probe that proves a real draft now ends `draft_present`.
//
// The screens are the tester's captures (`web/src/fixtures/surface/omp--v18-12-6-*`), the folder path
// masked to the same length. The re-wrapped frame is built from the 200-column capture: each row cut
// into pieces of the new width, which is what Herdr shows before omp draws again.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
const fx = (name: string): string => readFileSync(join(SURFACE, name), "utf8").replace(/\r/gu, "").replace(/\n+$/u, "");

const W200 = fx("omp--v18-12-6-idle-w200.txt");
const W60 = fx("omp--v18-12-6-idle-w60.txt");
const STALE_OVER_LIVE = fx("omp--v18-12-6-stale-row-over-live-draft.txt");

/** The old frame re-wrapped to `width` columns, the way Herdr shows it until the program draws again. */
function rewrapped(screen: string, width: number): string {
  return screen
    .split("\n")
    .flatMap((row) => {
      const cells = [...row];
      if (cells.length <= width) return [row];
      const pieces: string[] = [];
      for (let i = 0; i < cells.length; i += width) pieces.push(cells.slice(i, i + width).join(""));
      return pieces;
    })
    .join("\n");
}

/**
 * An omp pane whose box row the fake edits as keys arrive. `screens` are shown one per read, the last
 * one for every read after it (a frame on its way, then the settled one). `stale` is text painted over
 * the box row that the live editor does not hold: it shows until the first key or text reaches the
 * pane, which makes the editor draw its own row again.
 */
class Pane {
  live = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  reads = 0;
  stale: string | null = null;

  constructor(private screens: string[]) {}

  show(...screens: string[]): void {
    this.screens = screens;
  }

  private render(): string {
    const screen = this.screens[Math.min(this.reads - 1, this.screens.length - 1)]!;
    const rows = screen.split("\n");
    const at = rows.findLastIndex((row) => row.startsWith("╰─"));
    const text = this.stale ?? this.live;
    rows[at] = text === "" ? "╰─" : `╰─ ${text}`;
    return rows.join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.reads }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.stale = null;
    this.live += text;
    return Promise.resolve(muxAck());
  };

  pasteText = this.typeText;

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    this.stale = null;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.live = [...this.live].slice(0, -1).join("");
      else if ((key === "Enter" || key === "ctrl+q") && this.live.length > 0) {
        this.submitted.push(this.live);
        this.live = "";
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-transient-holds-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;
const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };
/** The three claims, for a match that ignores the revision. */
const WORDS = { free: { turn: "idle", modal: "none", composer: "empty" }, draft: { turn: "idle", modal: "none", composer: "draft" } } as const;

function rig(pane: Pane) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const holds = new HoldStore(join(dir, "held"), now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "18.12.6", { log: () => undefined })),
    generation: () => "gen-1",
    holds,
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-th-${String(++ids).padStart(7, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "omp" });
  const tick = (surface: Surface): Promise<(SendAnswer | null)[]> => Promise.all(protocol.tickHolds("main", () => surface));
  return { send, tick, holds, clock, protocol };
}

describe("a send right after a resize: the old frame re-wrapped is a frame on its way, not a box that is not free", () => {
  test("the fixtures: the settled frames read free, the re-wrapped one has no frame", async () => {
    for (const screen of [W200, W60]) {
      const view = await rig(new Pane([screen])).send("", { mode: "prepare" });
      expect(view.surface).toMatchObject(WORDS.free);
    }
    const view = await rig(new Pane([rewrapped(W200, 60)])).send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ turn: "unknown", composer: "unknown", reason: "no-match" });
  });

  test("200x50 to 60x30, S0's first read re-wrapped: one more S0 after the settle, then sent, and the gap is `settle`", async () => {
    const pane = new Pane([rewrapped(W200, 60), W60]);
    const r = rig(pane);
    const answer = await r.send("race plain d0");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "ctrl+q"] });
    expect(pane.submitted).toEqual(["race plain d0"]);
    expect(r.holds.list()).toEqual([]);
    const gaps = answer.receipt!.gapsMs;
    expect(gaps.settle).toBeGreaterThanOrEqual(150);
    // S0's own gap is the two reads that were judged, not the read in flux.
    expect(gaps.s0).toBe(120);
  });

  test("60x30 to 200x50 (wider): the old rows keep their width, the grid size differs, the same one more S0", async () => {
    const pane = new Pane([W60, W200]);
    const answer = await rig(pane).send("race plain wide");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.gapsMs.settle).toBeGreaterThanOrEqual(150);
    expect(pane.submitted).toEqual(["race plain wide"]);
  });

  test("a Replace in the resize window empties the draft and sends, instead of being held", async () => {
    const pane = new Pane([rewrapped(W200, 60), W60]);
    pane.live = "a3 draft typed by api";
    const answer = await rig(pane).send("race replace d0", { mode: "replace" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.gapsMs.settle).toBeGreaterThanOrEqual(150);
    expect(pane.submitted).toEqual(["race replace d0"]);
  });

  test("one more S0 only: a screen still in flux after the settle is held as before, nothing typed", async () => {
    // Every read a new grid size: the settle does not loop.
    const pane = new Pane([rewrapped(W200, 60), W60, rewrapped(W200, 80), W200, W60]);
    const r = rig(pane);
    const answer = await r.send("never settles");
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.receipt?.gapsMs.settle).toBeGreaterThanOrEqual(150);
    expect(pane.reads).toBe(4);
    expect(pane.keysSeen).toEqual([]);
    expect(r.holds.list().map((entry) => entry.cause)).toEqual(["not_free"]);
  });

  test("a box whose text moved between the reads, same grid size, gets no settle: held at once as before", async () => {
    const pane = new Pane([W60]);
    let n = 0;
    const read = pane.readGrid;
    pane.readGrid = (paneId, request) => {
      if (++n === 2) pane.live = "someone typed at the desk";
      return read(paneId, request);
    };
    const answer = await rig(pane).send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.receipt?.gapsMs.settle).toBeUndefined();
    expect(pane.reads).toBe(2);
  });

  test("a settled pane pays nothing: no settle gap, two S0 reads", async () => {
    const pane = new Pane([W60]);
    const answer = await rig(pane).send("plain");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.gapsMs.settle).toBeUndefined();
  });
});

describe("a stale row over a live draft (h 21 and 23, omp 18.12.6): the probe proves the draft, the send is refused, never held", () => {
  /** The h-21 screen: `and what about the design` painted over the box row, the live editor holds `xy`. */
  const h21 = (): Pane => {
    const pane = new Pane([STALE_OVER_LIVE]);
    pane.live = "xy";
    pane.stale = "and what about the design";
    return pane;
  };

  test("the fixture: S0 reads the stale text as a draft", async () => {
    const view = await rig(h21()).send("", { mode: "prepare" });
    expect(view.surface).toMatchObject(WORDS.draft);
  });

  test("h 21: a plain send probes, the box reads `xy` after the Backspace: refused draft_present with its offers, nothing held", async () => {
    const pane = h21();
    const r = rig(pane);
    const answer = await r.send("h2 plain send");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(answer.detail).toBe("The box already holds a draft.");
    expect(pane.live).toBe("xy");
    expect(r.holds.list()).toEqual([]);
  });

  test("h 23: the Replace that follows sends only its own text, and no held send goes out after it", async () => {
    const pane = h21();
    const r = rig(pane);
    await r.send("h2 plain send");
    const replace = await r.send("h2 replace", { mode: "replace" });
    expect(replace.receipt).toMatchObject({ outcome: "sent" });
    // Before: the plain send was held, and went out after the Replace (journal `h2 replace`, `h2 plain send`).
    for (let i = 0; i < 6; i++) {
      r.clock.now += 3000;
      expect(await r.tick(FREE)).toEqual([]);
    }
    expect(pane.submitted).toEqual(["h2 replace"]);
  });

  test("an empty box painted over a live draft: the send's own probe proves the draft, refused draft_present", async () => {
    const pane = new Pane([STALE_OVER_LIVE]);
    pane.live = "xy";
    pane.stale = "";
    const r = rig(pane);
    const answer = await r.send("over an empty paint");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(pane.live).toBe("xy");
    expect(pane.submitted).toEqual([]);
    expect(r.holds.list()).toEqual([]);
  });
});
