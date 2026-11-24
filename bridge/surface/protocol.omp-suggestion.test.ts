// The Send Protocol and Clear on omp's prompt suggestion in any theme (issue 854). After a turn omp fills
// the empty box with its prediction of the next message, drawn in the active theme's `dim` colour: one
// foreground, no attribute, and one of 92 colours across omp's bundled themes. The profile named only the
// default theme's grey, so on most themes the suggestion read as a typed draft and every phone send was
// refused `draft_present` after the probe. Now the profile says the suggestion may wear any style
// (`idle.placeholders.anyStyle`), and the probe proves it by behaviour on every read: the probe character
// makes the whole text go and its Backspace brings the same text back. A typed draft keeps its text.
//
// The fake pane is omp 18.22.0 as its source (v18.22.0 and v19.0.1, packages/tui/src/components/editor.ts)
// and the live captures of 2026-11-24 show it: the screen of a capture, with its `╰─` prompt row drawn
// from the buffer. The suggestion's rest shows after the buffer while the buffer is a strict start of it
// (case-sensitive), so an empty buffer shows all of it and a probe character makes it go; Enter and
// Ctrl+Q submit the buffer alone; Tab accepts the suggestion into the buffer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { ClearService } from "./clear.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const CAPTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
const OMP = loadProfiles().get("omp")!;
const PROBE = OMP.probe.char;
const ESC = String.fromCodePoint(0x1b);
const SGR = new RegExp(`${ESC}\\[[0-9;:]*m`, "gu");
const WIDTH = 120;
const SUGGESTION = "Mountains.";

/** The three themes of the captures: the prompt glyph's colour, the typed text's and the suggestion's (`dim`). */
const THEMES = {
  titanium: { capture: "omp--v18-22-0-suggestion-titanium--w120.txt", accent: "0;180;255", ink: "229;229;231", dim: "107;114;128" },
  dark: { capture: "omp--v18-22-0-suggestion-dark--w120.txt", accent: "178;129;214", ink: "229;229;231", dim: "95;102;115" },
  light: { capture: "omp--v18-22-0-suggestion-light--w120.txt", accent: "135;95;135", ink: "0;0;0", dim: "118;118;118" },
} as const;
type Theme = keyof typeof THEMES;
const THEME_NAMES = ["titanium", "dark", "light"] as const satisfies readonly Theme[];

/** omp 18.22.0's box with its prompt suggestion, drawn over a capture of it. */
class SuggestingOmpPane {
  /** What is in omp's buffer. */
  box = "";
  /** The suggestion omp offers for the conversation as it stands; null with none (a turn started). */
  suggestion: string | null = SUGGESTION;
  /** The buffer is selected: the next typed text replaces it (a selection a person made). */
  selected = false;
  /** The cursor stands at the start of the buffer: typed text goes in front of it. */
  cursorAtStart = false;
  /** The read carries no styling (herdr-core). */
  plain = false;
  submitted: string[] = [];
  keysSeen: string[] = [];
  writes: string[] = [];
  private readonly rows: string[];
  private readonly prompt: number;
  private readonly status: number;
  private revision = 1;

  constructor(private readonly theme: Theme) {
    this.rows = readFileSync(join(CAPTURES, THEMES[theme].capture), "utf8").split("\n");
    this.prompt = this.rows.findLastIndex((row) => row.includes("╰─"));
    this.status = this.prompt - 1;
  }

  /** The rest of the suggestion omp paints after the buffer, or "" (editor.ts `#getShownPrediction`). */
  private tail(): string {
    const s = this.suggestion;
    if (s === null || this.box.includes("\n") || this.cursorAtStart || this.box.length >= s.length || !s.startsWith(this.box)) return "";
    return s.slice(this.box.length);
  }

  private render(): string {
    const { accent, ink, dim } = THEMES[this.theme];
    const tail = this.tail();
    const shown = this.box.length + tail.length;
    const typed = this.box === "" ? "" : `${ESC}[38;2;${ink}m${this.box}${ESC}[0m`;
    const ghost = tail === "" ? "" : `${ESC}[38;2;${dim}m${tail}${ESC}[0m`;
    const rows = [...this.rows];
    rows[this.prompt] = `${ESC}[0m${ESC}[38;2;${accent}m╰─ ${ESC}[0m${typed}${ghost}${" ".repeat(Math.max(0, WIDTH - 3 - shown))}`;
    const text = rows.join("\n");
    return this.plain ? text.replace(SGR, "") : text;
  }

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    return Promise.resolve(muxOk({ paneId, text: this.render(), truncated: false, revision: this.revision }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.writes.push(text);
    if (this.selected) this.box = text;
    else this.box = this.cursorAtStart ? text + this.box : this.box + text;
    this.selected = false;
    this.revision++;
    return Promise.resolve(muxAck());
  };

  pasteText = (paneId: string, text: string): Promise<MuxAck> => this.typeText(paneId, text);

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    for (const key of keys) {
      this.keysSeen.push(key);
      if (key === "Backspace") {
        // With the cursor at the start, typed text went in front of it and the cursor stays after that text.
        this.box = this.selected ? "" : this.cursorAtStart ? [...this.box].slice(1).join("") : [...this.box].slice(0, -1).join("");
        this.selected = false;
      } else if (key === "Tab" && this.tail() !== "") this.box = this.suggestion!;
      else if ((key === "Enter" || key === "ctrl+q") && this.box.trim().length > 0) {
        // The buffer alone is submitted, never the suggestion; the turn that starts retires the suggestion.
        this.submitted.push(this.box);
        const at = this.status;
        this.rows.splice(at, 0, ` > ${this.box}`);
        this.rows.shift();
        this.box = "";
        this.suggestion = null;
      }
      this.revision++;
    }
    return Promise.resolve(muxAck());
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-omp-suggestion-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;

function rig(pane: SuggestingOmpPane) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const proven: { paneId: string; text: string; ink: string }[] = [];
  const profile = (harness: string) => Promise.resolve(profileFor(harness, "18.22.0", { log: () => undefined }));
  const sleep = (ms: number) => {
    clock.now += ms;
    return Promise.resolve();
  };
  const gate = new KeyGate(pane, now);
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText, pasteText: pane.pasteText },
    gate,
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile,
    generation: () => "gen-1",
    suggestion: (paneId, ghost) => void proven.push({ paneId, ...ghost }),
    now,
    sleep,
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: `omp-suggestion-${String(++ids).padStart(6, "0")}`, text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "omp" });
  const clear = new ClearService({ mux: pane, gate, profile, suggestion: (paneId, ghost) => void proven.push({ paneId, ...ghost }), sleep });
  const clearBox = () => clear.handle(`omp-clear-${String(++ids).padStart(6, "0")}`, "%1", "omp");
  return { send, clearBox, proven };
}

describe("omp's prompt suggestion reads as the empty box in every theme (issue 854)", () => {
  test("the omp profile says its suggestion may wear any style", () => {
    expect(OMP.idle.placeholders.anyStyle).toBe(true);
  });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme}: a pure read takes the suggestion for a draft; the probe proves it and the send goes into the empty box`, async () => {
      const pane = new SuggestingOmpPane(theme);
      const { send, proven } = rig(pane);
      const view = await send("", { mode: "prepare" });
      expect(view.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
      const answer = await send("please run the tests");
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(answer.receipt?.keys.slice(0, 2)).toEqual(["probe", "Backspace"]);
      expect(answer.receipt?.keys.at(-1)).toBe("ctrl+q");
      expect(answer.receipt?.gapsMs.proof).toBeGreaterThan(0);
      expect(pane.submitted).toEqual(["please run the tests"]);
      expect(proven).toEqual([{ paneId: "%1", text: SUGGESTION, ink: `rgb(${THEMES[theme].dim.replaceAll(";", ",")})` }]);
    });
  }

  test("titanium: the colour the profile names reads empty with no proof at all", async () => {
    const pane = new SuggestingOmpPane("titanium");
    const { send } = rig(pane);
    const view = await send("", { mode: "prepare" });
    expect(view.surface).toMatchObject({ composer: "empty" });
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.gapsMs.proof).toBeUndefined();
    expect(pane.submitted).toEqual(["please run the tests"]);
  });

  test("a read with no styling (herdr-core) takes the same proof", async () => {
    const pane = new SuggestingOmpPane("dark");
    pane.plain = true;
    const { send, proven } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(answer.receipt?.keys.slice(0, 2)).toEqual(["probe", "Backspace"]);
    expect(pane.submitted).toEqual(["please run the tests"]);
    // No colour to name on a plain read: the bridge's Surface gets no mark.
    expect(proven).toEqual([]);
  });

  for (const theme of THEME_NAMES) {
    test(`${theme}: a text that starts the suggestion goes out alone, though omp keeps the suggestion's rest after it`, async () => {
      const pane = new SuggestingOmpPane(theme);
      const { send } = rig(pane);
      const answer = await send("Moun");
      expect(answer.receipt).toMatchObject({ outcome: "sent" });
      expect(pane.submitted).toEqual(["Moun"]);
    });
  }

  test("a text that is the suggestion's own words goes out as typed", async () => {
    const pane = new SuggestingOmpPane("light");
    const { send } = rig(pane);
    const answer = await send(SUGGESTION);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.submitted).toEqual([SUGGESTION]);
  });

  test("Replace of a typed draft: once the draft is gone the suggestion shows again, a probe proves it, and the text goes", async () => {
    const pane = new SuggestingOmpPane("dark");
    pane.box = "my own words";
    const { send } = rig(pane);
    const answer = await send("please run the tests", { mode: "replace", rowsHash: (await send("", { mode: "prepare" })).rowsHash });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["please run the tests"]);
  });

  test("Replace on a box that holds only the suggestion sends the text", async () => {
    const pane = new SuggestingOmpPane("dark");
    const { send } = rig(pane);
    const answer = await send("please run the tests", { mode: "replace", rowsHash: (await send("", { mode: "prepare" })).rowsHash });
    expect(answer.receipt?.outcome).toBe("sent");
    expect(pane.submitted).toEqual(["please run the tests"]);
  });

  test("a refused draft's receipt names the colour of the box text", async () => {
    const pane = new SuggestingOmpPane("light");
    pane.box = "hey";
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", saw: { composer: "draft", ink: "rgb(0,0,0)" } });
  });
});

describe("a real draft never reads as the empty box (issue 854)", () => {
  for (const theme of THEME_NAMES) {
    test(`${theme}: a typed draft keeps its text when the probe is typed and is refused draft_present`, async () => {
      const pane = new SuggestingOmpPane(theme);
      pane.box = "my own words";
      const { send, proven } = rig(pane);
      const answer = await send("please run the tests");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
      expect(pane.box).toBe("my own words");
      expect(pane.submitted).toEqual([]);
      expect(proven).toEqual([]);
    });

    test(`${theme}: a typed start of the suggestion, its rest drawn after it, is a draft: the probe keeps the typed part`, async () => {
      const pane = new SuggestingOmpPane(theme);
      pane.box = "Moun";
      const { send, proven } = rig(pane);
      const view = await send("", { mode: "prepare" });
      expect(view.surface).toMatchObject({ composer: "draft" });
      const answer = await send("please run the tests");
      expect(answer.receipt?.outcome).toBe("refused");
      expect(pane.box).toBe("Moun");
      expect(pane.submitted).toEqual([]);
      expect(proven).toEqual([]);
    });

    test(`${theme}: the suggestion accepted with Tab is a draft in the typed colour`, async () => {
      const pane = new SuggestingOmpPane(theme);
      await pane.writeKeys("%1", ["Tab"]);
      expect(pane.box).toBe(SUGGESTION);
      const { send } = rig(pane);
      const answer = await send("please run the tests");
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
      expect(pane.box).toBe(SUGGESTION);
      expect(pane.submitted).toEqual([]);
    });
  }

  test("a draft whose cursor stands at its start: the probe before the same text is no suggestion", async () => {
    const pane = new SuggestingOmpPane("dark");
    pane.box = "my own words";
    pane.cursorAtStart = true;
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(pane.box).toBe("my own words");
    expect(pane.submitted).toEqual([]);
  });

  test("a selected draft the probe replaced does not come back on Backspace: no suggestion, nothing typed or sent", async () => {
    const pane = new SuggestingOmpPane("dark");
    pane.box = "my own words";
    pane.selected = true;
    const { send, proven } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.writes).toEqual([PROBE]);
    expect(pane.submitted).toEqual([]);
    expect(proven).toEqual([]);
  });

  test("a probe the suggestion starts with keeps the suggestion's rest: still a draft", async () => {
    const pane = new SuggestingOmpPane("dark");
    pane.suggestion = `${PROBE} odd suggestion`;
    const { send } = rig(pane);
    const answer = await send("please run the tests");
    expect(answer.receipt?.outcome).toBe("refused");
    expect(pane.submitted).toEqual([]);
  });
});

describe("Clear on omp's suggestion (issue 854)", () => {
  test("a box that holds only the suggestion has no draft: refused no_draft, the suggestion untouched", async () => {
    const pane = new SuggestingOmpPane("dark");
    const { clearBox, proven } = rig(pane);
    const answer = await clearBox();
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "refused", reason: "no_draft" } });
    expect(pane.box).toBe("");
    expect(pane.suggestion).toBe(SUGGESTION);
    expect(pane.keysSeen).toEqual(["Backspace"]);
    expect(proven).toEqual([{ paneId: "%1", text: SUGGESTION, ink: "rgb(95,102,115)" }]);
  });

  test("a typed draft is cleared; the suggestion that shows again once it went is proven, and the Clear ends cleared", async () => {
    const pane = new SuggestingOmpPane("light");
    pane.box = "my own words";
    const { clearBox, proven } = rig(pane);
    const answer = await clearBox();
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "cleared", draft: "my own words" } });
    expect(pane.box).toBe("");
    expect(proven).toEqual([{ paneId: "%1", text: SUGGESTION, ink: "rgb(118,118,118)" }]);
  });

  test("a typed draft on a pane with no suggestion is cleared as before, with no probe after the clear keys", async () => {
    const pane = new SuggestingOmpPane("dark");
    pane.suggestion = null;
    pane.box = "my own words";
    const { clearBox, proven } = rig(pane);
    const answer = await clearBox();
    expect(answer).toMatchObject({ kind: "receipt", receipt: { outcome: "cleared", draft: "my own words" } });
    expect(pane.writes).toEqual([PROBE]);
    expect(proven).toEqual([]);
  });
});
