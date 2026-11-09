// The Send Protocol on real opencode 2.2.6 screens (#749, lab 2026-11-09). Two sends ended
// typed_not_submitted there: a slash command, because the command list stands in the box's own edge run
// over its top edge, and a long text, because the box grows past about 13 rows and shows only its tail.
// The fake pane draws a capture and writes its box row as keys and text arrive. A whole-text paste folds
// the way opencode folds it: `[Pasted ~N lines]`, N the lines, over 150 characters or from 3 lines on.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { rowsOf } from "../../web/src/test/surface-corpus.ts";
import { findInputFrame } from "../../web/src/lib/surface/frame.ts";
import { loadProfiles, profileFor, requireProfile, type Profile } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fx = (name: string): string => readFileSync(join(PANES, name), "utf8").replace(/\r/gu, "");
// eslint-disable-next-line no-control-regex -- the colour codes are what a read without colour drops
const SGR = /\u001b\[[0-9;]*m/gu;

/** How opencode folds one paste (paste.ts, lab 1.19.0 and 2.2.6): the lines of the trimmed text. */
function folded(text: string): string {
  const pasted = text.trim();
  const lines = pasted.split("\n").length;
  return pasted.length > 150 || lines >= 3 ? `[Pasted ~${String(lines)} lines]` : pasted;
}

/**
 * A pane that shows `idle` with its prompt row replaced by the box's text, or a whole capture from
 * `screens` while the box holds that capture's text (a command and its list). Enter takes what the
 * box holds; on a screen whose list points at another command, `pointed` names what Enter ran.
 */
class OcPane {
  box = "";
  submitted: string[] = [];
  calls: string[] = [];
  keysSeen: string[] = [];
  private readonly rows: string[];
  private readonly prompt: number;
  private readsSeen = 0;

  constructor(
    idle: string,
    private readonly screens: Readonly<Record<string, { readonly capture: string; readonly pointed: string }>> = {},
    private readonly fold: (text: string) => string = folded,
  ) {
    this.rows = idle.split("\n");
    const frame = findInputFrame(rowsOf(idle), requireProfile("opencode").idle);
    if (frame === null) throw new Error("the idle capture has no box");
    this.prompt = frame.interior.prompt;
  }

  private render(): string {
    const screen = this.screens[this.box];
    if (screen !== undefined) return screen.capture;
    if (this.box === "") return this.rows.join("\n");
    const plain = this.rows[this.prompt]!.replace(SGR, "");
    const bar = plain.indexOf("┃");
    const rows = [...this.rows];
    rows[this.prompt] = `${" ".repeat(bar)}┃  ${this.box}`;
    return rows.join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.readsSeen++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.readsSeen }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`type:${text}`);
    this.box += text;
    return Promise.resolve(muxAck());
  };

  pasteBlock = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`block:${String(text.split("\n").length)} lines`);
    this.box += this.fold(text);
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter" && this.box.length > 0) {
        this.submitted.push(this.screens[this.box]?.pointed ?? this.box);
        this.box = "";
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-oc-screens-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol on `pane` over a multiplexer that frames a whole paste (Herdr), for opencode 2.2.6 (provisional: every send probes). */
function rig(pane: OcPane, edit?: (profile: Profile) => Profile) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const deps = {
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteBlock: pane.pasteBlock },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => {
      const base = loadProfiles().get(harness);
      const profiles = edit === undefined || base === undefined ? undefined : new Map([[harness, edit(base)]]);
      return Promise.resolve(profileFor(harness, "2.2.6", profiles === undefined ? { log: () => undefined } : { log: () => undefined, profiles }));
    },
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const protocol = new SendProtocol(deps);
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-oc-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "w1:p1", harness: "opencode" });
  return { send };
}

describe("a slash command whose list stands in the box's edge run (#749, A)", () => {
  test("/compact with the list's fill on /compact goes in with Enter and runs", async () => {
    const pane = new OcPane(fx("oc--v226-session-idle.txt"), { "/compact": { capture: fx("oc--v226-slash-compact.txt"), pointed: "/compact" } });
    const answer = await rig(pane).send("/compact", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "opencode", profileStatus: "provisional" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.submitted).toEqual(["/compact"]);
  });

  test("/comp, whose list points at /review, is typed and never entered: Enter would run /review", async () => {
    const pane = new OcPane(fx("oc--v226-fresh-idle.txt"), { "/comp": { capture: fx("oc--v226-slash-comp.txt"), pointed: "/review" } });
    const answer = await rig(pane).send("/comp", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.submitted).toEqual([]);
    expect(pane.box).toBe("/comp");
  });

  test("/compact over a list that shows no fill (a read without colour) is not entered either", async () => {
    const plain = fx("oc--v226-slash-compact.txt").replace(SGR, "");
    const pane = new OcPane(fx("oc--v226-session-idle.txt"), { "/compact": { capture: plain, pointed: "/compact" } });
    const answer = await rig(pane).send("/compact", { mode: "command" });
    expect(answer.receipt?.outcome).toBe("typed_not_submitted");
    expect(pane.keysSeen).not.toContain("Enter");
  });
});

describe("a long text goes as one paste and its fold is proven by opencode's own count (#749, B)", () => {
  const four = ["one ".repeat(40).trim(), "two ".repeat(40).trim(), "three ".repeat(30).trim(), "four ".repeat(30).trim()].join("\n");
  const long = "word ".repeat(300).trim();

  test.each([
    ["600 characters over four lines", four, "[Pasted ~4 lines]"],
    ["1,500 characters on one line", long, "[Pasted ~1 lines]"],
  ])("%s: one paste, the fold proves it, and Enter goes", async (_name, text, chip) => {
    const pane = new OcPane(fx("oc--v226-fresh-idle.txt"));
    const answer = await rig(pane).send(text);
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "opencode" });
    expect(pane.calls.at(-1)).toBe(`block:${String(text.split("\n").length)} lines`);
    expect(pane.submitted).toEqual([chip]);
  });

  test("the rule Claude Code counts by (the line breaks) refuses the same fold: that was the field case", async () => {
    const pane = new OcPane(fx("oc--v226-fresh-idle.txt"));
    const breaks = (profile: Profile): Profile => ({ ...profile, paste: { bracketed: true, block: true } });
    const answer = await rig(pane, breaks).send(four);
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "mismatch" });
    expect(pane.keysSeen).not.toContain("Enter");
  });

  test("a fold that names another count, or text beside the fold, is not this send", async () => {
    for (const fold of [(text: string) => folded(text).replace("~4", "~3"), (text: string) => `${folded(text)}x`, (text: string) => `${folded(text)}${folded(text)}`]) {
      const pane = new OcPane(fx("oc--v226-fresh-idle.txt"), {}, fold);
      const answer = await rig(pane).send(four);
      expect(answer.receipt?.outcome).toBe("typed_not_submitted");
      expect(pane.keysSeen).not.toContain("Enter");
    }
  });

  test("two short lines land literally and are compared as typed", async () => {
    const pane = new OcPane(fx("oc--v226-fresh-idle.txt"), {}, (text) => text.replace("\n", " "));
    const answer = await rig(pane).send("first line\nsecond line");
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["first line second line"]);
  });
});
