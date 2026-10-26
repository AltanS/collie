// A box that is drawn but reads no keys yet, and a send that straddles the moment the multiplexer names
// the agent (omp gang three, tester 3, 2026-10-26, omp 18.6.1 and 18.12.6 on Herdr 0.9.5).
//
// Headline 1: omp 18.12.6 draws its box about twenty seconds before it reads a key. A send in that gap
// typed the probe character, the probe never showed, and nothing took it out; once omp woke it showed
// the buffered `⌁` as a draft, and every later send was refused `draft_present` (two sends left `⌁⌁`).
// Headline 2: a send past its probe met the pane's generation moving from the shell to omp and ended
// `typed_not_submitted(changed)` with the text in the box.
//
// The screens are the gang's own captures (web/src/fixtures/surface/omp--deaf-box-*), and the idle box
// of the omp corpus. The pane is a fake: a deaf pane keeps every text and key in the terminal's buffer
// and applies them in order once it wakes, as the tester's deafrelay.py does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { LaunchWindow, LAUNCH_WINDOW_MS } from "../launch-window.ts";
import { ClearService } from "./clear.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { PROBE_MARKER, probeResidue } from "./probe-marker.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
const fx = (name: string): string => readFileSync(join(SURFACE, name), "utf8");
/** omp 18.12.6 idle, an empty box. */
const OMP_UP = fx("omp--v18-12-6-status-row-idle.txt");
/** Row m2 of the gang: two sends in the deaf window, then the wake-up: `╰─ ⌁⌁`. */
const TWO_PROBES = fx("omp--deaf-box-two-probes--v18.12.6.txt");
/** Row a, the natural first start of 18.12.6: the `⌁` of the send at +1 s, shown at +5 s. */
const ONE_PROBE = fx("omp--deaf-box-one-probe--v18.12.6.txt");

const P = PROBE_MARKER;
const STARTING = "The omp input box does not take keys yet; it may still be starting.";
const OTHER_PROGRAM = "The pane holds another program now.";

/** An omp screen whose box row holds `box`. A deaf pane buffers every text and key until `wake`. */
class OmpPane {
  box: string;
  submitted: string[] = [];
  calls: string[] = [];
  keysSeen: string[] = [];
  /** The box is drawn, and every text and key waits in the terminal until `wake`. */
  deaf = false;
  /** Backspace never takes the box below this (a box that does not take Backspace for what it shows). */
  floor = "";
  /** Called after each text that reaches the pane (not the buffer): the multiplexer may name the agent then. */
  onText: ((text: string) => void) | null = null;
  private buffered: Array<{ readonly text: string } | { readonly key: string }> = [];
  private head: string[] = [];
  private tail: string[] = [];
  /** What the box row shows right of the box (omp's `⇧⇥ to change thinking effort`), and its column. */
  private hint = "";
  private hintAt = 0;

  constructor(capture: string) {
    const rows = capture.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const at = rows.findLastIndex((row) => row.startsWith("╰─"));
    if (at < 0) throw new Error("the capture has no box row");
    this.head = rows.slice(0, at);
    this.tail = rows.slice(at + 1);
    const row = rows[at]!;
    const parts = /^╰─ ?(.*?)( {2,}.*)?$/u.exec(row)!;
    this.box = (parts[1] ?? "").trim();
    this.hint = (parts[2] ?? "").trim();
    this.hintAt = row.length - (parts[2] ?? "").trimStart().length;
  }

  /** The terminal hands omp what it buffered, in order. */
  wake(): void {
    this.deaf = false;
    const queued = this.buffered;
    this.buffered = [];
    for (const item of queued) {
      if ("text" in item) this.box += item.text;
      else this.key(item.key);
    }
  }

  private render(): string {
    const lead = this.box === "" ? "╰─" : `╰─ ${this.box}`;
    const row = this.hint === "" ? lead : `${lead.padEnd(Math.max(this.hintAt, lead.length + 2))}${this.hint}`;
    return [...this.head, row, ...this.tail].join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: 0 }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`type:${text}`);
    if (this.deaf) this.buffered.push({ text });
    else {
      this.box += text;
      this.onText?.(text);
    }
    return Promise.resolve(muxAck());
  };

  pasteText = this.typeText;

  private key(key: string): void {
    if (key === "Backspace") {
      if (this.box.length > this.floor.length) this.box = [...this.box].slice(0, -1).join("");
    } else if ((key === "Enter" || key === "ctrl+q") && this.box.length > 0) {
      this.submitted.push(this.box);
      this.head.splice(this.head.length - 1, 0, ` ${this.box}`);
      this.box = "";
    }
  }

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.deaf) this.buffered.push({ key });
      else this.key(key);
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-deaf-box-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/**
 * A protocol on `pane` for omp 18.12.6 (provisional: every send is probed), with the bridge's wiring of
 * one session's launch window on the same clock. `harness` is what the multiplexer names the pane.
 */
function rig(pane: OmpPane, options: { harness?: string; generation?: { now: string | null }; held?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const window = new LaunchWindow(now);
  const generation = options.generation ?? { now: "omp:-" };
  const store = new RequestStore(join(dir, "sends"), now);
  const holds = options.held === true ? new HoldStore(join(dir, "held"), now) : undefined;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store,
    holds,
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "18.12.6", { log: () => undefined })),
    generation: () => generation.now,
    starting: (paneId, named) => window.starting("main", paneId, named),
    framed: (paneId, harness) => window.framed("main", paneId, harness),
    deaf: (paneId, harness) => window.deaf("main", paneId, harness),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const harness = options.harness ?? "omp";
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-deaf-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness });
  return { send, clock, window, generation, protocol, store, holds: holds! };
}

/** A pane omp was launched in a moment ago (`POST /api/launch`): the multiplexer still names a shell. */
function launched(pane: OmpPane, held = false) {
  const wired = rig(pane, { harness: "shell", generation: { now: "shell:-" }, held });
  wired.window.mark("main", "%1", "omp");
  return wired;
}

describe("the probe marker is Collie's own residue", () => {
  test("a box that is only probe markers counts them; any other text in it counts none", () => {
    expect(probeResidue(`${P}${P}`, P)).toBe(2);
    expect(probeResidue(` ${P} `, P)).toBe(1);
    expect(probeResidue("", P)).toBe(0);
    expect(probeResidue(`hello${P}`, P)).toBe(0);
    expect(probeResidue(`${P} ${P}`, P)).toBe(0);
    expect(probeResidue(`${P}x`, P)).toBe(0);
  });

  test("the gang's captures read as such a box: two markers (row m2) and one (row a)", () => {
    expect(probeResidue(new OmpPane(TWO_PROBES).box, P)).toBe(2);
    expect(probeResidue(new OmpPane(ONE_PROBE).box, P)).toBe(1);
  });

  test("a send at the `⌁⌁` box of row m2 takes out exactly the two markers, then goes in once", async () => {
    const pane = new OmpPane(TWO_PROBES);
    const { send } = rig(pane);
    const answer = await send("m2 after the wake-up");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(pane.submitted).toEqual(["m2 after the wake-up"]);
    expect(pane.box).toBe("");
    // The draft proof (probe, Backspace), one Backspace per marker, then the send's own probe and its text.
    expect(answer.receipt?.keys.slice(0, 4)).toEqual(["probe", "Backspace", "Backspace", "Backspace"]);
    expect(pane.keysSeen.filter((key) => key === "Backspace")).toHaveLength(4);
  });

  test("the `⌁` box of row a (the natural first start) goes the same way: no `draft_present`", async () => {
    const pane = new OmpPane(ONE_PROBE);
    const { send } = rig(pane);
    const answer = await send("a after the wake-up");
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["a after the wake-up"]);
  });

  test("a command and Add to it go on from the emptied box too; nothing of the markers goes out", async () => {
    const pane = new OmpPane(TWO_PROBES);
    const { send } = rig(pane);
    expect((await send("add this", { mode: "append" })).receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["add this"]);
  });

  test("a marker beside a person's text is never removed: the box is their draft, and the send is refused", async () => {
    const pane = new OmpPane(OMP_UP);
    pane.box = `note ${P}`;
    const { send } = rig(pane);
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.box).toBe(`note ${P}`);
    // Only the draft proof's own Backspace for its own probe.
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(pane.submitted).toEqual([]);
  });

  test("markers that Backspace does not take out end a true refusal, and nothing is typed", async () => {
    const pane = new OmpPane(TWO_PROBES);
    pane.floor = `${P}${P}`;
    const { send } = rig(pane);
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(answer.receipt?.detail).toContain("Backspace did not empty it");
    expect(pane.calls).toEqual([`type:${P}`]);
    expect(pane.submitted).toEqual([]);
  });

  test("Discard of a box that holds only the markers takes them out and ends discarded", async () => {
    const pane = new OmpPane(ONE_PROBE);
    const { send } = rig(pane);
    const answer = await send("the text Collie typed", { mode: "discard" });
    expect(answer.receipt?.outcome).toBe("discarded");
    expect(pane.box).toBe("");
    expect(pane.submitted).toEqual([]);
  });

  test("Clear of a box that holds only the markers presses one Backspace each and offers nothing to restore", async () => {
    const pane = new OmpPane(TWO_PROBES);
    const clear = new ClearService({
      mux: pane,
      gate: new KeyGate(pane),
      profile: (harness) => Promise.resolve(profileFor(harness, "18.12.6", { log: () => undefined })),
      sleep: () => Promise.resolve(),
    });
    const answer = await clear.handle("clear-1", "%1", "omp");
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "cleared" } });
    expect(answer.kind === "receipt" && "draft" in answer.receipt).toBe(false);
    expect(pane.box).toBe("");
    // The proof's Backspace, then exactly two: never the clear key's slack.
    expect(pane.keysSeen).toEqual(["Backspace", "Backspace", "Backspace"]);
  });
});

describe("a drawn box that reads no keys yet, while omp is starting (headline 1)", () => {
  test("the probe that never shows: refused with the window's words, no Backspace, the window stays open", async () => {
    const pane = new OmpPane(OMP_UP);
    pane.deaf = true;
    const { send, window } = launched(pane);
    const answer = await send("at plus1s");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"], profileId: "omp" });
    expect(answer.receipt?.detail?.startsWith(STARTING)).toBe(true);
    expect(pane.keysSeen).toEqual([]);
    expect(window.expecting("main", "%1")).toBe("omp");
    expect(window.pending("main", "%1")).toBe(1);
    // The poll's Surface reads the drawn box: it does not end a window whose box went deaf.
    window.drawn("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBe("omp");
  });

  test("once omp wakes and shows the `⌁`, the next send takes it out and goes in once; the window ends", async () => {
    const pane = new OmpPane(OMP_UP);
    pane.deaf = true;
    const { send, window } = launched(pane);
    expect((await send("first")).receipt?.outcome).toBe("refused");
    pane.wake();
    expect(pane.box).toBe(P);
    const answer = await send("second");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(pane.submitted).toEqual(["second"]);
    expect(pane.box).toBe("");
    expect(window.expecting("main", "%1")).toBeNull();
  });

  test("two sends in the deaf window (row m2): two pending, `⌁⌁` after the wake-up, both taken out by the next send", async () => {
    const pane = new OmpPane(OMP_UP);
    pane.deaf = true;
    const { send, window, clock } = launched(pane);
    expect((await send("m2 at3s")).receipt?.detail?.startsWith(STARTING)).toBe(true);
    clock.now += 7_000;
    expect((await send("m2 at10s")).receipt?.detail?.startsWith(STARTING)).toBe(true);
    expect(window.pending("main", "%1")).toBe(2);
    expect(pane.keysSeen).toEqual([]);
    pane.wake();
    expect(pane.box).toBe(`${P}${P}`);
    const answer = await send("m2 at24s");
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["m2 at24s"]);
  });

  test("a window the poll's box read had already ended opens again for the deaf probe, inside its first bound", async () => {
    const pane = new OmpPane(OMP_UP);
    pane.deaf = true;
    const { send, window } = rig(pane, { harness: "omp" });
    window.observe("main", [{ paneId: "%1", agent: null }]);
    window.observe("main", [{ paneId: "%1", agent: "omp" }]);
    window.drawn("main", "%1", "omp");
    expect(window.expecting("main", "%1")).toBeNull();
    const answer = await send("after the poll");
    expect(answer.receipt?.detail?.startsWith(STARTING)).toBe(true);
    expect(window.expecting("main", "%1")).toBe("omp");
    expect(pane.keysSeen).toEqual([]);
  });

  test("past the window's bound a probe that never shows keeps today's answer, and still no blind Backspace", async () => {
    const pane = new OmpPane(OMP_UP);
    pane.deaf = true;
    const { send, window, clock } = rig(pane, { harness: "omp" });
    window.observe("main", [{ paneId: "%1", agent: null }]);
    window.observe("main", [{ paneId: "%1", agent: "omp" }]);
    window.drawn("main", "%1", "omp");
    clock.now += LAUNCH_WINDOW_MS + 1;
    const answer = await send("much later");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(answer.receipt?.detail).toContain("may remain in the box");
    expect(window.expecting("main", "%1")).toBeNull();
    expect(pane.keysSeen).toEqual([]);
  });

  test("a box that reads keys ends the window with the first probe that shows, as before", async () => {
    const pane = new OmpPane(OMP_UP);
    const { send, window } = launched(pane);
    expect((await send("hello")).receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["hello"]);
    expect(window.expecting("main", "%1")).toBeNull();
    expect(window.pending("main", "%1")).toBe(0);
  });
});

describe("a send that straddles the moment the multiplexer names the agent (headline 2)", () => {
  test("shell to omp after the text went in (rows a1, a9, d2 on 18.6.1): the send goes on and Enters once", async () => {
    const pane = new OmpPane(OMP_UP);
    const wired = launched(pane);
    pane.onText = (text) => {
      if (text !== P) wired.generation.now = "omp:-";
    };
    const answer = await wired.send("a1861-at1s zq");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(pane.submitted).toEqual(["a1861-at1s zq"]);
    expect(pane.box).toBe("");
  });

  test("shell to omp before S0: the send is not refused `pane_gone`", async () => {
    const pane = new OmpPane(OMP_UP);
    const wired = launched(pane);
    pane.onText = null;
    wired.generation.now = "shell:-";
    const first = wired.send("before s0");
    wired.generation.now = "omp:-";
    const answer = await first;
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["before s0"]);
  });

  test("omp's session id resolving mid-send is the same program", async () => {
    const pane = new OmpPane(OMP_UP);
    const wired = rig(pane, { generation: { now: "omp:-" } });
    pane.onText = (text) => {
      if (text !== P) wired.generation.now = "omp:019a-session";
    };
    expect((await wired.send("resolves")).receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["resolves"]);
  });

  for (const [what, next] of [
    ["another harness", "claude:-"],
    ["a shell again", "shell:-"],
    ["the pane gone", null],
  ] as const) {
    test(`a real program change still ends \`changed\`: ${what}`, async () => {
      const pane = new OmpPane(OMP_UP);
      const wired = rig(pane, { generation: { now: "omp:-" } });
      pane.onText = (text) => {
        if (text !== P) wired.generation.now = next;
      };
      const answer = await wired.send("must not go");
      expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed", detail: OTHER_PROGRAM });
      expect(pane.submitted).toEqual([]);
    });
  }

  test("a pane with no profile to name keeps the strict check: shell to omp under a blind send is refused", async () => {
    const pane = new OmpPane(OMP_UP);
    const wired = rig(pane, { harness: "shell", generation: { now: "shell:-" } });
    const first = wired.send("ls -la");
    wired.generation.now = "omp:-";
    const answer = await first;
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(pane.calls).toEqual([]);
  });
});

describe("a held send on a starting pane meets the multiplexer naming the agent (the hold's own generation check)", () => {
  const FREE: Surface = { revision: 1, turn: "idle", modal: "none", composer: "empty" };

  /** A send held over a draft on a pane omp was launched in (profile omp, generation `shell:-`). */
  async function heldOnStartingPane(pane: OmpPane) {
    const wired = launched(pane, true);
    pane.box = "a draft";
    const answer = await wired.send("held text", { draftHolds: true });
    expect(answer.receipt).toMatchObject({ outcome: "held", profileId: "omp" });
    const id = answer.receipt!.requestId;
    const tick = (): Promise<(SendAnswer | null)[]> => Promise.all(wired.protocol.tickHolds("main", () => FREE));
    return { ...wired, id, tick };
  }

  test("shell to omp: the hold waits, takes `omp:<id>`, and goes out on a later free read", async () => {
    const pane = new OmpPane(OMP_UP);
    const held = await heldOnStartingPane(pane);
    held.generation.now = "omp:019a-session";
    expect(await held.tick()).toEqual([]);
    expect(held.store.get(held.id)).toMatchObject({ phase: "held", paneGeneration: "omp:019a-session" });
    // The draft leaves; two free reads at least two seconds apart release it.
    pane.box = "";
    expect(await held.tick()).toEqual([]);
    held.clock.now += 3_000;
    const released = await held.tick();
    expect(released).toHaveLength(1);
    expect(released[0]?.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["held text"]);
  });

  test("the entry takes the agent too: a release after the launch window ran out reads omp's profile, not the blind road", async () => {
    const pane = new OmpPane(OMP_UP);
    const held = await heldOnStartingPane(pane);
    expect(held.holds.get(held.id)?.harness).toBe("shell");
    held.generation.now = "omp:019a-session";
    expect(await held.tick()).toEqual([]);
    expect(held.holds.get(held.id)?.harness).toBe("omp");
    held.clock.now += LAUNCH_WINDOW_MS + 1;
    pane.box = "";
    pane.calls.length = 0;
    // The first poll after the move already counted a free read, and the window's expiry is time enough.
    const released = await held.tick();
    expect(released).toHaveLength(1);
    const receipt = released[0]?.receipt;
    expect(receipt).toMatchObject({ outcome: "sent", profileId: "omp", harness: "omp" });
    // The profile's own path: Collie's probe first, then the text and the submit key; never a blind line.
    expect(receipt?.keys).toContain("probe");
    expect(pane.calls[0]).toBe(`type:${P}`);
    expect(pane.submitted).toEqual(["held text"]);
  });

  test("a later move to a shell ends a hold that had taken `omp:<id>`", async () => {
    const pane = new OmpPane(OMP_UP);
    const held = await heldOnStartingPane(pane);
    held.generation.now = "omp:-";
    expect(await held.tick()).toEqual([]);
    expect(held.store.get(held.id)?.paneGeneration).toBe("omp:-");
    held.generation.now = "shell:-";
    await held.tick();
    expect(held.store.get(held.id)?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("still ends `pane_gone`: the pane moves to another harness", async () => {
    const pane = new OmpPane(OMP_UP);
    const held = await heldOnStartingPane(pane);
    held.generation.now = "claude:-";
    await held.tick();
    expect(held.store.get(held.id)?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(pane.submitted).toEqual([]);
  });

  test("still ends `pane_gone`: the pane is missing for three polls", async () => {
    const pane = new OmpPane(OMP_UP);
    const held = await heldOnStartingPane(pane);
    held.generation.now = null;
    await held.tick();
    await held.tick();
    expect(held.store.get(held.id)?.phase).toBe("held");
    await held.tick();
    expect(held.store.get(held.id)?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(pane.submitted).toEqual([]);
  });
});
