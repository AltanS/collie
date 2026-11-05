// The Send Protocol at a box that answers the agent's question (issue 704): omp 18.16.0's answer
// editor, captured off herdr-core as plain text (`omp--v18-16-0-custom-answer-empty--w200.txt`). The
// omp profile names it as a layout of its own (`answers`, `submit`, `newlineSubmits`, `trailer.hint`).
// A person's send from the phone is probed, typed, checked and submitted with Ctrl+Q; a text of two
// lines, a command, and every send that is not the person's own wait or are refused before any key.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures");
const pane = (name: string): string => readFileSync(join(FIXTURES, "panes", name), "utf8");
const EDITOR = "omp--v18-16-0-custom-answer-empty--w200.txt";
/** The composer omp draws again once the editor took its answer and the turn goes on. */
const COMPOSER = readFileSync(join(FIXTURES, "surface", "omp--v18-12-6-status-row-idle.txt"), "utf8");
/** The Ask dialog a note editor returns to. */
const ASK = pane("omp--v18-10-ask-single.txt");

/** The editor as omp draws it: the capture's rows, the `│ > ` row holding what was typed. Enter, Ctrl+Q and a raw line feed submit. */
class EditorPane {
  box = "";
  submitted: string[] = [];
  calls: string[] = [];
  keysSeen: string[] = [];
  private reads = 0;
  private closed = false;
  private readonly rows: string[];
  private readonly at: number;
  private readonly width: number;

  constructor(private readonly after: string) {
    this.rows = pane(EDITOR).replace(/\r/gu, "").split("\n");
    this.at = this.rows.findIndex((row) => row.startsWith("│ >"));
    this.width = [...this.rows.at(-1)!.trimEnd()].length;
  }

  private render(): string {
    if (this.closed) return this.after;
    const row = `│ > ${this.box}`.padEnd(this.width - 1) + "│";
    return this.rows.map((text, i) => (i === this.at ? row : text)).join("\n");
  }

  private submit(): void {
    this.submitted.push(this.box);
    this.box = "";
    this.closed = true;
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.reads }));
  };

  private take(text: string): void {
    if (this.closed) return;
    // A raw line feed is a plain Enter to the prompt-style editor: it submits the line typed so far.
    const [first = "", ...rest] = text.split("\n");
    this.box += first;
    if (rest.length > 0) this.submit();
  }

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`type:${text}`);
    this.take(text);
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.calls.push(`paste:${text}`);
    this.take(text);
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (this.closed) continue;
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if (key === "Enter" || key === "ctrl+q" || key === "ctrl+j") this.submit();
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-answer-box-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

function rig(editor: EditorPane, holds = false) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const store = holds ? new HoldStore(join(dir, "held"), now) : undefined;
  const protocol = new SendProtocol({
    mux: { readGrid: editor.readGrid, typeText: editor.typeText, pasteText: editor.pasteText },
    gate: new KeyGate(editor, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    holds: store,
    profile: () => Promise.resolve(profileFor("omp", "18.16.0", { log: () => undefined })),
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-answer-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "omp" });
  return { send, holds: store };
}

describe("a person's send from the phone into omp's answer editor (#704)", () => {
  test("the pane view reads a free box, and the answer is typed, checked and submitted with Ctrl+Q", async () => {
    const editor = new EditorPane(COMPOSER);
    const { send } = rig(editor);
    const view = await send("", { mode: "prepare", fromPhone: true });
    expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    const answer = await send("a ripe mango", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(answer.receipt?.keys).toEqual(["probe", "Backspace", "ctrl+q"]);
    expect(editor.submitted).toEqual(["a ripe mango"]);
  });

  test("a note editor that closes back to the Ask dialog settles the receipt too: the box is gone on two reads", async () => {
    const editor = new EditorPane(ASK);
    const { send } = rig(editor);
    const answer = await send("only if it is ripe", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(editor.submitted).toEqual(["only if it is ripe"]);
  });

  test("a text of two lines is refused before any key: a line feed would submit the first line alone", async () => {
    const editor = new EditorPane(COMPOSER);
    const { send } = rig(editor);
    const answer = await send("one line\nand a second", { fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "multiline", keys: [] });
    expect(editor.calls).toEqual([]);
    expect(editor.keysSeen).toEqual([]);
    expect(editor.submitted).toEqual([]);
  });

  test("a command is refused before any key: the box would take it as the answer", async () => {
    const editor = new EditorPane(COMPOSER);
    const { send } = rig(editor, true);
    const answer = await send("/model", { mode: "command", fromPhone: true });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(editor.calls).toEqual([]);
    expect(editor.keysSeen).toEqual([]);
  });
});

describe("a send that is not the person's own waits for the question to close", () => {
  test("a walky talky message or a hook's send is held, and nothing is typed into the answer", async () => {
    const editor = new EditorPane(COMPOSER);
    const { send, holds } = rig(editor, true);
    const answer = await send("a message from another agent", { draftHolds: true });
    expect(answer.receipt?.outcome).toBe("held");
    expect(holds?.waiting("main", "%1").length).toBe(1);
    expect(editor.calls).toEqual([]);
    expect(editor.keysSeen).toEqual([]);
  });

  test("with no hold queue it is refused, saying only the phone answers the question", async () => {
    const editor = new EditorPane(COMPOSER);
    const { send } = rig(editor);
    const answer = await send("a message from another agent");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(answer.receipt?.detail).toContain("Only a send from the phone answers it");
    expect(editor.calls).toEqual([]);
  });
});
