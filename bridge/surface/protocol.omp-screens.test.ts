// The Send Protocol on real omp 18.6.1 and 18.12.6 screens (omp gang, tester 5, 2026-10-25): an
// extension's widget under the box, an extension's status row under a slash palette, and a pane that
// is still a shell while the agent starts. The fake pane draws a capture and edits its box row as keys
// and text arrive; everything else on the screen is the capture's own.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures");
/** The omp captures of the gang live in `surface/`, outside the phone's omp adapter corpus; the shell one is a pane fixture. */
const fx = (name: string): string => readFileSync(join(FIXTURES, name.startsWith("omp--") ? "surface" : "panes", name), "utf8");

/** The capture's own rows: everything above the box row and under the list stays as captured. */
class OmpPane {
  box = "";
  submitted: string[] = [];
  calls: string[] = [];
  keysSeen: string[] = [];
  readsSeen = 0;
  /** The screen shown instead of the capture's own, e.g. a shell before the agent starts. */
  override: string | null = null;
  private head: string[] = [];
  private boxRow = "";
  private tail: string[] = [];

  /** `listRows` show under the box while it holds a text that starts with `/w`, before the tail. */
  constructor(
    capture: string,
    private readonly listRows: readonly string[] = [],
  ) {
    this.load(capture);
  }

  /** Swap the capture: the agent's screen appears. */
  load(capture: string): void {
    this.override = null;
    const rows = capture.replace(/\r/gu, "").split("\n");
    while (rows.length > 0 && rows.at(-1)!.trim() === "") rows.pop();
    const at = rows.findLastIndex((row) => row.startsWith("╰─"));
    if (at < 0) throw new Error("the capture has no box row");
    this.head = rows.slice(0, at);
    this.boxRow = rows[at]!;
    this.tail = rows.slice(at + 1);
    this.box = "";
  }

  private render(): string {
    if (this.override !== null) return this.override;
    const listed = this.box.startsWith("/w") ? this.listRows : [];
    return [...this.head, this.box === "" ? this.boxRow : `╰─ ${this.box}`, ...listed, ...this.tail].join("\n");
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.readsSeen++;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.readsSeen }));
  };

  private take(text: string): void {
    if (this.override !== null) return;
    this.box += text;
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
      if (this.override !== null) continue;
      if (key === "Backspace") this.box = [...this.box].slice(0, -1).join("");
      else if ((key === "Enter" || key === "ctrl+q") && this.box.length > 0) {
        this.submitted.push(this.box);
        // The agent echoes what it took in the transcript, over the bar row.
        this.head.splice(this.head.length - 1, 0, ` ${this.box}`);
        this.box = "";
      }
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-omp-screens-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

/** A protocol on `pane`, for omp 18.12.6 (provisional: every send takes the probed path). */
function rig(pane: OmpPane, extra: { launching?: (paneId: string) => string | null; harness?: string } = {}) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const deps = {
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "18.12.6", { log: () => undefined })),
    generation: () => "gen-1",
    launching: extra.launching,
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  };
  const protocol = new SendProtocol(deps);
  const harness = extra.harness ?? "omp";
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `req-omp-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness });
  return { send, clock };
}

describe("a widget of four rows or more under the box (belowEditor, omp gang 2026-10-25)", () => {
  test.each([
    ["omp--v18-12-6-widget-below-4.txt", 4],
    ["omp--v18-6-1-widget-below-6.txt", 6],
  ])("%s: the pane view reads an empty composer, not torn, and a send lands", async (name) => {
    const pane = new OmpPane(fx(name));
    const { send } = rig(pane);
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(view.surface?.reason).toBeUndefined();
    const answer = await send("hello there");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(pane.submitted).toEqual(["hello there"]);
  });
});

/** The list rows a capture shows under its box row, the status row left out. */
function listRowsOf(name: string): string[] {
  const rows = fx(name).replace(/\r/gu, "").split("\n");
  const at = rows.findLastIndex((row) => row.startsWith("╰─"));
  return rows.slice(at + 1).filter((row) => row.trim() !== "" && !row.startsWith("PLAN"));
}

describe("a slash command with an extension's status row under the list (omp gang 2026-10-25)", () => {
  test.each([
    ["omp--v18-12-6-status-row-palette-4.txt"],
    ["omp--v18-6-1-status-row-palette-4.txt"],
  ])("%s: /wx goes in with the command keys and runs, where the list had four rows and the status row sat under it", async (name) => {
    const pane = new OmpPane(fx("omp--v18-12-6-status-row-idle.txt"), listRowsOf(name));
    const { send } = rig(pane);
    const answer = await send("/wx", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(answer.receipt?.keys.at(-1)).toBe("Enter");
    expect(pane.submitted).toEqual(["/wx"]);
  });

  test("a half-typed command whose ten-row list points at another one is still not entered: the text stays for the person", async () => {
    const pane = new OmpPane(fx("omp--v18-12-6-status-row-idle.txt"), listRowsOf("omp--v18-12-6-status-row-palette-10.txt"));
    const { send } = rig(pane);
    const answer = await send("/w", { mode: "command" });
    expect(answer.receipt?.outcome).not.toBe("sent");
    expect(pane.submitted).toEqual([]);
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe("/w");
  });
});

describe("a send in the launch window: the bridge started omp in this pane and the shell is all there is yet (omp gang 2026-10-25)", () => {
  const SHELL = fx("shell--omp-launch-window.txt");
  const OMP_UP = fx("omp--v18-12-6-status-row-idle.txt");

  /** A pane that shows a shell until `load` brings the agent's screen up. */
  const startingPane = (): OmpPane => {
    const pane = new OmpPane(OMP_UP);
    pane.override = SHELL;
    return pane;
  };

  test("a shell screen is refused before any key: no text, no probe, no Enter", async () => {
    const pane = startingPane();
    const { send } = rig(pane, { launching: () => "omp", harness: "shell" });
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: [], profileId: "omp" });
    expect(answer.receipt?.detail).toBe("The pane shows no omp input box yet; it may still be starting. Nothing was typed.");
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
    expect(answer.offers).not.toContain("commit");
  });

  test("a command is refused the same way", async () => {
    const pane = startingPane();
    const { send } = rig(pane, { launching: () => "omp", harness: "shell" });
    const answer = await send("/wx", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: [] });
    expect(pane.calls).toEqual([]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the same pane once omp's input box is on screen takes the send", async () => {
    const pane = startingPane();
    const { send } = rig(pane, { launching: () => "omp", harness: "shell" });
    expect((await send("hello")).receipt?.outcome).toBe("refused");
    pane.load(OMP_UP);
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent", profileId: "omp" });
    expect(pane.submitted).toEqual(["hello"]);
  });

  test("a pane the bridge did not start anything in is still a shell that takes a blind send", async () => {
    const pane = startingPane();
    const { send } = rig(pane, { harness: "shell" });
    const answer = await send("ls -la");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"], profileId: null });
    expect(pane.calls).toEqual(["type:ls -la"]);
  });

  test("a started harness with no profile of its own leaves the pane a blind shell", async () => {
    const pane = startingPane();
    const { send } = rig(pane, { launching: () => "nothing-known", harness: "shell" });
    expect((await send("ls -la")).receipt).toMatchObject({ outcome: "sent", keys: ["Enter"], profileId: null });
  });
});
