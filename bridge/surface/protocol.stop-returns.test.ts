// A Stop early in a turn gives the prompt back (the owner's lead pane, 2026-11-07, Claude Code 2.1.319): a
// message sent from the phone started a turn, the owner tapped Stop seven seconds later, and Claude Code
// took the prompt out of the transcript and put it back in the input box. The box then held 298
// characters nobody had typed at the desk, the next four sends were refused `draft_present`, and the
// phone could not say whose text it was or offer to send it. A queued send that comes back has a card for
// that (ADR 0122); a send that started its turn had none, because nothing kept its text.
//
// The three captures are one lab run (Herdr 0.9.5, 174 columns, 50 rows, `--source visible --format
// ansi`, CRLF as the bridge reads them): the idle box, the turn six seconds in with the prompt in the
// transcript, and the screen 0.4 s after Escape with the prompt back in the box. The fake pane builds the
// box row from what Collie typed while idle; every other row is the capture's.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { StopService } from "./stop.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const capture = (state: "idle" | "running" | "after"): string => readFileSync(join(FIXTURES, `claude--v2319-stop-returns-${state}--w174.txt`), "utf8");
const CLAUDE = loadProfiles().get("claude")!;
const ESC = String.fromCodePoint(0x1b);
const plain = (screen: string): string[] => screen.replace(new RegExp(`${ESC}\\[[0-9;:]*m`, "gu"), "").split(/\r?\n/u);

/** The lab's message, one line. */
const MESSAGE = "Without using any tools, write a 1500 word story about a lighthouse keeper who collects lost letters.";

/** Idle, the box row drawn from what was typed; after Enter the captured turn; after Escape the captured give-back. */
class LabPane {
  box = "";
  keysSeen: string[] = [];
  /** What the Escape gives back: the lab's capture, or a screen of the test's own. */
  after = capture("after");
  private entered = false;
  private stopped = false;
  private revision = 1;
  private readonly idleRows = capture("idle").split("\r\n");
  private readonly boxRow = plain(capture("idle")).findIndex((row) => row.startsWith("❯"));

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    let text: string;
    if (this.stopped) text = this.after;
    else if (this.entered) text = capture("running");
    else text = this.idleRows.map((row, i) => (i === this.boxRow ? `❯ ${this.box}` : row)).join("\r\n");
    return Promise.resolve(muxOk({ paneId, text, truncated: false, revision: this.revision }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.box += text;
    this.revision++;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      if (key === "Enter") this.entered = true;
      if (key === "Escape" && this.entered) this.stopped = true;
    }
    this.revision++;
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-stop-returns-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The Send Protocol and a Stop on one pane and one clock, the Stop's read-backs told to the protocol as the bridge wires them. */
function rig(pane: LabPane) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const sleep = (ms: number): Promise<void> => {
    clock.now += ms;
    return Promise.resolve();
  };
  const profile = (harness: string) => Promise.resolve(profileFor(harness, "2.1.319", { log: () => undefined, profiles: new Map([["claude", CLAUDE]]) }));
  const gate = new KeyGate(pane, now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate,
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile,
    generation: () => "claude:lab-session",
    now,
    sleep,
  });
  const stop = new StopService({
    mux: pane,
    gate,
    profile,
    sleep,
    now,
    returned: (paneId, read) => protocol.boxRead("main", paneId, { ...read, poll: false }),
  });
  const target = { session: "main", paneId: "%1", harness: "claude" };
  return { clock, protocol, stop, target };
}

describe("a Stop early in a turn on Claude Code 2.1.319 gives the prompt back to the box (lab, 2026-11-07)", () => {
  test("the captures: the prompt sits in the transcript while the turn runs, and in the box after Escape", () => {
    const running = plain(capture("running"));
    const after = plain(capture("after"));
    expect(running.some((row) => row.startsWith(`❯ ${MESSAGE}`))).toBe(true);
    expect(running.some((row) => /^❯\s$/u.test(row))).toBe(true);
    expect(after.filter((row) => row.includes(MESSAGE))).toEqual([`❯ ${MESSAGE}`]);
  });

  test("the send's text comes back as a card with Send and Discard, and the Stop's receipt says so", async () => {
    const pane = new LabPane();
    const r = rig(pane);
    const sent = await r.protocol.handle({ id: "stop-ret-000001", text: MESSAGE, mode: "send" }, r.target);
    expect(sent.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(sent.receipt?.queued).toBeUndefined();
    // A send that started a turn is no card while it runs.
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
    r.clock.now += 7000;
    const stopped = await r.stop.handle("stop-req-000001", "%1", "claude");
    expect(stopped.kind === "receipt" && stopped.receipt).toMatchObject({ outcome: "stopped", returned: ["stop-ret-000001"] });
    expect(pane.keysSeen).toEqual(["Backspace", "Enter", "Escape"]);
    expect(r.protocol.queuedOf("main", "%1")).toEqual([{ requestId: "stop-ret-000001", text: MESSAGE, at: expect.any(Number), state: "returned" }]);
    // The card's Send and Discard read the text from here (POST /api/send with resendOf).
    expect(r.protocol.returnedSource("main", "%1", "stop-ret-000001")).toBe(MESSAGE);
  });

  test("a turn that ends with no Stop leaves no card: two idle polls over an empty box let the send go", async () => {
    const pane = new LabPane();
    const r = rig(pane);
    await r.protocol.handle({ id: "stop-ret-000002", text: MESSAGE, mode: "send" }, r.target);
    for (let i = 0; i < 2; i++) {
      r.clock.now += 1000;
      r.protocol.tickQueued("main", () => ({ box: "", at: r.clock.now, turn: "idle" }));
    }
    // A later read of the same text in the box is a draft typed at the desk, not a give-back.
    r.clock.now += 1000;
    expect(r.protocol.boxRead("main", "%1", { box: MESSAGE, at: r.clock.now, turn: "idle", poll: true })).toEqual([]);
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });

  test("a box that gives back other text is no card: only the send's own text is", async () => {
    const pane = new LabPane();
    pane.after = capture("after").replace(MESSAGE, "a different line someone typed at the desk, not the message from the phone");
    const r = rig(pane);
    await r.protocol.handle({ id: "stop-ret-000003", text: MESSAGE, mode: "send" }, r.target);
    r.clock.now += 7000;
    const stopped = await r.stop.handle("stop-req-000003", "%1", "claude");
    expect(stopped.kind === "receipt" && stopped.receipt.returned).toBeUndefined();
    expect(r.protocol.queuedOf("main", "%1")).toEqual([]);
  });
});
