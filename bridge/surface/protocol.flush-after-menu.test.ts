// A command sent right after a menu answer, while the agent catches up (lane 8788, 2026-11-15, Claude
// Code 2.1.325). The session had hit its usage limit with messages waiting in its queue. The person
// answered the limit menu with option 1, and Claude released the queued messages one after another:
// for some seconds the rows above the box scrolled and grew while no spinner showed, so the turn read
// idle. A `/login` sent then was refused `probe_failed` ("The probe character changed more than the
// box"): a command was held to the full screen compare, and the turn-aware compare, which a message
// already takes on that screen (aboveMovedInTurn), was not open to a command. Any command sent in
// those seconds was refused, `/login` was only the one in the record.
//
// The fake pane draws a fixed-height screen: the menu over the box until its answer, then the box
// with a transcript that gains rows on every read for a few seconds of the fake clock.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor, type Profile, type ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const RULE = "─".repeat(100);
/** Rows the screen shows above the box: the pane's height less the box and its footer. */
const ABOVE = 18;
/** How long the agent keeps printing the released messages after the menu answer. */
const FLUSH_MS = 6_000;

/** A Claude-shaped pane: a numbered menu until a digit and Enter answer it, then a flushing transcript. */
class FlushPane {
  box = "";
  keysSeen: string[] = [];
  submitted: string[] = [];
  menu = true;
  private flushUntil = 0;
  private released = 0;
  private readonly transcript: string[] = Array.from({ length: 12 }, (_, i) => `⏺ earlier answer row ${String(i)}`);

  constructor(private readonly clock: { now: number }) {}

  private render(): string {
    if (this.menu) {
      const menu = ["", "  You've hit your limit · resets 10am", "", "  What do you want to do?", "", "  ❯ 1. Stop and wait for limit to reset", "    2. Upgrade your plan", "", "  Enter to confirm · Esc to cancel"];
      return [...this.transcript.slice(-(ABOVE + 4 - menu.length)), ...menu].join("\n");
    }
    const lines = this.box.split("\n");
    const box = lines.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`));
    const above = this.transcript.slice(-ABOVE);
    while (above.length < ABOVE) above.unshift("");
    return [...above, RULE, ...box, RULE, "  ? for shortcuts"].join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    // The released queue prints above the box: each read finds the next message and its answer.
    if (!this.menu && this.clock.now < this.flushUntil) {
      this.released++;
      this.transcript.push("", `❯ queued message ${String(this.released)}`, `⏺ answer to queued message ${String(this.released)}`);
    }
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.released }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    if (!this.menu) this.box += text;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.menu) {
        // The menu's answer: the menu closes and the queue starts to flush.
        if (key === "Enter") {
          this.menu = false;
          this.flushUntil = this.clock.now + FLUSH_MS;
        }
        continue;
      }
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter" && this.box.length > 0) {
        this.submitted.push(this.box);
        this.transcript.push(`❯ ${this.box}`);
        this.box = "";
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-flush-after-menu-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol on a Claude Code pane whose version the binary reported (a turn is trusted). */
function rig(withProfile: (profile: Profile) => Profile = (profile) => profile) {
  const clock = { now: 1_000_000 };
  const pane = new FlushPane(clock);
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (name: string): Promise<ProfileMatch | null> => {
      const match = profileFor(name, "2.1.325", { log: () => undefined });
      return Promise.resolve(match === null ? null : { ...match, profile: withProfile(match.profile) });
    },
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `flush-${String(++ids).padStart(4, "0")}-5f0c2a91`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "claude" });
  /** The menu card's answer: option 1, then Enter, as the ask path presses them. */
  const answerMenu = async (): Promise<void> => {
    await pane.writeKeys("%1", ["1", "Enter"]);
  };
  return { pane, clock, send, answerMenu };
}

describe("a command right after a menu answer, while the released queue still prints (2026-11-15)", () => {
  test("the screen reads idle with an empty box and no modal while the rows above move", async () => {
    const { send, answerMenu } = rig();
    await answerMenu();
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
  });

  test("/login goes in on the turn-aware compare: sent, never refused probe_failed", async () => {
    const { pane, send, answerMenu } = rig();
    await answerMenu();
    const answer = await send("/login", { mode: "command" });
    expect(answer.receipt?.reason).not.toBe("probe_failed");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["/login"]);
  });

  test("any command, not only /login: /compact goes in the same way", async () => {
    const { pane, send, answerMenu } = rig();
    await answerMenu();
    const answer = await send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["/compact"]);
  });

  test("a message on the same screen keeps its path: sent", async () => {
    const { pane, send, answerMenu } = rig();
    await answerMenu();
    const answer = await send("carry on once the queue is done");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual(["carry on once the queue is done"]);
  });

  test("a command the profile never lets wait still never goes into the moving screen", async () => {
    const { pane, send, answerMenu } = rig();
    await answerMenu();
    const answer = await send("/clear", { mode: "command" });
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.submitted).toEqual([]);
  });

  test("a harness that queues messages but not commands: the command is still refused, nothing typed past the probe", async () => {
    const { pane, send, answerMenu } = rig((profile) => {
      const { commandWhileRunning, ...keys } = profile.keys;
      void commandWhileRunning;
      return { ...profile, keys };
    });
    await answerMenu();
    const answer = await send("/login", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.submitted).toEqual([]);
  });

  test("control: once the screen settled, the command goes as on any idle box", async () => {
    const { pane, clock, send, answerMenu } = rig();
    await answerMenu();
    clock.now += 10_000;
    const answer = await send("/login", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    expect(pane.submitted).toEqual(["/login"]);
  });
});
