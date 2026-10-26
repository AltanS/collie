// The Send Protocol on real Claude Code 2.1.310 screens (browser leg case 16, 2026-10-26): a walky
// talky message sent while a turn streams. Claude queues it and draws it over the box in its prompt
// echo's shape: `❯ ` and the header line, the body and the `ctrl+enter to send now` hint indented
// under it, a blank row, then the box with `Press up to edit queued messages`. The framed cue read
// took those three rows for a pointed list, so the Surface claimed a modal at S2 and the send ended
// `unknown(dialog_after_enter)`: the walky receipt said "may have arrived" for a message Claude took.
// The fake pane draws the captured turn with its box built from what Collie typed, and the captured
// queued screen once Enter takes a text.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { formatEnvelope } from "../walky/types.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
const fx = (name: string): string => readFileSync(join(SURFACE, name), "utf8");
/** A turn streaming a numbered list, the box empty, `esc to interrupt` under it. */
const TURN = fx("claude--v2-1-310-walky-turn-empty-box--w120.txt");
/** The same turn after Enter took the walky message: the three-row queued block over the placeholder. */
const QUEUED = fx("claude--v2-1-310-walky-queued-two-rows--w120.txt");
const RULE = "─".repeat(120);

/** The captured turn, its box drawn from what was typed; after Enter on a text, the captured queued screen. */
class ClaudeTurnPane {
  box = "";
  submitted: string[] = [];
  keysSeen: string[] = [];
  private readonly head: string[];
  private readonly footer: string[];
  private queued = false;
  private reads = 0;

  constructor(capture: string, private readonly queuedScreen: string = QUEUED) {
    const rows = capture.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const bottom = rows.findLastIndex((row) => /^─{8,}$/u.test(row));
    const top = rows.slice(0, bottom).findLastIndex((row) => /^─{8,}$/u.test(row));
    if (top < 0 || bottom < 0) throw new Error("the capture has no box");
    this.head = rows.slice(0, top);
    this.footer = rows.slice(bottom + 1);
  }

  private render(): string {
    if (this.queued) return this.queuedScreen;
    const lines = this.box.split("\n");
    const box = lines.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`));
    return [...this.head, RULE, ...box, RULE, ...this.footer].join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.reads }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    if (!this.queued) this.box += text;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.queued) continue;
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "ctrl+j") this.box += "\n";
      else if (key === "Enter" && this.box.length > 0) {
        // Claude Code takes the text into its queue while the turn runs.
        this.submitted.push(this.box);
        this.box = "";
        this.queued = true;
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-claude-queued-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol on `pane`, for Claude Code 2.1.310 (provisional, a version the binary reported: a turn is trusted). */
function rig(pane: ClaudeTurnPane) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.1.310", { log: () => undefined })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `wt_case16${String(++ids).padStart(4, "0")}-72207d22`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "claude" });
  return { send };
}

describe("a walky talky message into a running Claude Code 2.1.310 turn (browser leg case 16, 2026-10-26)", () => {
  test("the captured screens: the turn reads running with an empty box, and the queued block reads as no modal", async () => {
    const { send } = rig(new ClaudeTurnPane(TURN));
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
  });

  test("Claude queues the two-line envelope: the receipt says sent and queued, never unknown(dialog_after_enter)", async () => {
    const pane = new ClaudeTurnPane(TURN);
    const { send } = rig(pane);
    const envelope = formatEnvelope({ id: "wt_93st11a9o2in", kind: "operator", from: { memberId: null, address: null, harness: null, label: "browser-leg" }, replyTo: null, body: "Walky busy check: reply with only the word BUSY-OK, nothing else." });
    expect(envelope.split("\n")).toHaveLength(2);
    const answer = await send(envelope, { draftHolds: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, profileId: "claude" });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(pane.keysSeen.at(-1)).toBe("Enter");
    expect(pane.submitted).toEqual([envelope]);
  });

  // A phone send with a list in it, captured 2026-10-26 on 2.1.310 (fixtures README, "Several queued
  // messages"): the block's later lines are `1. reply D` and `2. reply E`. Only the pointer row decides
  // whether a run over the box is a list, so the block reads as no modal and the receipt says queued.
  test("a queued text with numbered lines under its first line: sent and queued", async () => {
    const pane = new ClaudeTurnPane(TURN, fx("claude--v2-1-310-queued-numbered-body--w119.txt"));
    const { send } = rig(pane);
    const text = "Please do these:\n1. reply D\n2. reply E";
    const answer = await send(text);
    expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, profileId: "claude" });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(pane.submitted).toEqual([text]);
  });

  // The known limit: a text whose first line is a numbered item draws a list's pointer row (`❯ 1. …`),
  // the shape of a real dialog's pointer on its first option. The read stays strong, and the send ends
  // unknown(dialog_after_enter), never sent twice.
  test("a queued text whose first line is numbered still ends unknown(dialog_after_enter)", async () => {
    const pane = new ClaudeTurnPane(TURN, fx("claude--v2-1-310-queued-numbered-first--w119.txt"));
    const { send } = rig(pane);
    const answer = await send("1. reply H first\n2. reply I second");
    expect(answer.receipt).toMatchObject({ outcome: "unknown", reason: "dialog_after_enter" });
    expect(pane.submitted).toHaveLength(1);
  });
});
