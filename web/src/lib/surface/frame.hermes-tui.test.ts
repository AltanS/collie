import { describe, expect, it } from "vitest";

import { fixtureRows, readScreen, rowsOf } from "../../test/surface-corpus";
import { findInputFrame } from "./frame";
import { requireProfile } from "./profile";
import { isFree } from "./surface";

// Issue 549: Hermes's Ink TUI (`hermes --tui`) draws its composer with no rule rows. Its top edge is the
// status row ` ─ <status> │ … ─ <title or path>`, one column in, and its prompt is ` ❯`, one column in,
// with nothing under it. The captures are NCheuk's plain-text reads (issue 549, 2026-11-03 and
// 2026-11-04) and MigueMercedes's English idle screen (the issue body). Before the fix every one read
// `no-match`, so every send was refused "Collie cannot read this screen".
const IDLE = requireProfile("hermes").idle;
const read = (name: string) => readScreen(fixtureRows(name), "hermes", IDLE);
const readRows = (rows: readonly string[]) => readScreen(rowsOf(rows.join("\n")), "hermes", IDLE);

const STATUS_READY = " ─ 就緒 │ Qwen3.8 27B pi oQ8e mtp xhigh │ 59m 20s │ 語音已關 │ 8 個工作階段    ─ ~/workspace";
const STATUS_BUSY = " ─ ヽ(>∀<☆)☆ deliberating…  · 0s │ Qwen3.8 27B pi oQ8e mtp xhigh │ 1h 6m │ 語音已關 │ 8 個工作階段    ─ ~/workspace";

describe("hermes Ink TUI composer (issue 549)", () => {
  it.each([
    ["hermes--tui-idle-hint.txt", "有什麼想問的？…"],
    ["hermes--tui-idle-en.txt", 'Try "explain this codebase"'],
  ])("%s: the fresh session's hint reads as an empty box, free", (name, hint) => {
    const got = read(name);
    expect(got.frame).toMatchObject({ placeholder: true, interior: { text: hint } });
    expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(got.surface)).toBe(true);
  });

  it("an empty ❯ under a titled status row reads as an empty box, free", () => {
    const got = read("hermes--tui-idle-title.txt");
    expect(got.frame).toMatchObject({ placeholder: false, interior: { text: "" } });
    expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "empty" });
    expect(isFree(got.surface)).toBe(true);
  });

  it.each([
    ["hermes--tui-draft.txt", "testing idle with draft"],
    ["hermes--tui-draft-title.txt", "test idle with draft"],
  ])("%s: a one-line draft reads as a draft, not free", (name, draft) => {
    const got = read(name);
    expect(got.frame?.interior.text).toBe(draft);
    expect(got.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
    expect(isFree(got.surface)).toBe(false);
  });

  // PR 661 read the busy hint as a draft and the turn as idle. The status row's verb with its elapsed
  // time (`deliberating…  · 0s`) is the running sign, and the hint is no draft.
  it.each(["hermes--tui-busy.txt", "hermes--tui-busy-echo.txt", "hermes--tui-busy-fresh.txt", "hermes--tui-busy-title.txt"])(
    "%s: a running turn reads running, the busy hint no draft, never free",
    (name) => {
      const got = read(name);
      expect(got.frame?.top).toBe(38);
      expect(got.surface).toMatchObject({ turn: "running", modal: "none", composer: "empty" });
      expect(isFree(got.surface)).toBe(false);
    },
  );

  it("takes the lowest box when an echoed ❯ row sits in the transcript above", () => {
    expect(read("hermes--tui-busy-echo.txt").frame).toMatchObject({ top: 38, interior: { prompt: 39 } });
  });

  it("reads a draft wrapped onto rows three columns in as one draft", () => {
    const got = readRows(["  reply", STATUS_READY, " ❯ first row of the draft", "   second row of it"]);
    expect(got.frame?.interior.text).toBe("first row of the draft second row of it");
    expect(got.surface.composer).toBe("draft");
  });

  it("refuses a status row with no `│` section, and a ❯ in column 0, as no TUI box", () => {
    expect(findInputFrame(rowsOf(["  reply", " ─ ready", " ❯"].join("\n")), IDLE)).toBeNull();
    expect(findInputFrame(rowsOf(["  reply", STATUS_READY, "❯ hello"].join("\n")), IDLE)).toBeNull();
  });

  it("refuses a box with any other row under the prompt", () => {
    expect(readRows(["  reply", STATUS_READY, " ❯", " Allow once"]).surface).toMatchObject({ composer: "unknown" });
    expect(isFree(readRows(["  reply", STATUS_READY, " ❯", "╰──────╯"]).surface)).toBe(false);
  });
});

// The other half of Altan's review of PR 661: a dialog must never read as a free box. Hermes's own
// approval and clarify dialogs, drawn above or below the TUI's status row, must keep the box unfree.
describe("hermes Ink TUI composer: a dialog near it is never free (issue 549)", () => {
  const APPROVAL = [
    "╭─ 🔐 Dangerous command ───────────────────────────────╮",
    "│ rm -rf build                                         │",
    "│ ❯ 1. Allow once                                      │",
    "│   2. Deny                                            │",
    "╰──────────────────────────────────────────────────────╯",
  ];
  const POINTED = [" ❯ 1. Allow once", "   2. Allow for this session", "   3. Deny"];

  it("an approval box drawn right above the status row", () => {
    expect(isFree(readRows(["  reply", ...APPROVAL, STATUS_READY, " ❯"]).surface)).toBe(false);
  });

  it("a numbered pointed list drawn in the box's place, under the status row", () => {
    const got = readRows(["  reply", STATUS_READY, ...POINTED]);
    expect(isFree(got.surface)).toBe(false);
    expect(got.surface.composer).not.toBe("empty");
  });

  it("a pointed list right above the status row", () => {
    expect(isFree(readRows(["  reply", ...POINTED, STATUS_READY, " ❯"]).surface)).toBe(false);
  });

  it("a numbered pointed list under the status row of a running turn", () => {
    expect(isFree(readRows(["  reply", STATUS_BUSY, ...POINTED]).surface)).toBe(false);
  });

  it("the classic dialog fixtures still read not free", () => {
    for (const name of [
      "hermes--approval.txt",
      "hermes--approval-long.txt",
      "hermes--clarify-choices.txt",
      "hermes--clarify-multi.txt",
      "hermes--model-picker.txt",
      "hermes--palette.txt",
    ]) {
      expect(isFree(read(name).surface), name).toBe(false);
    }
  });
});

// Review of the first cut: the TUI's hints were profile-wide placeholder shapes, so on a plain read a
// classic-CLI draft typed as exactly `Try "…"` read as an empty box. They are the TUI layout's own now
// (`idle.frame.placeholderPatterns`), and the classic box keeps its draft.
describe("the TUI's hints hold for the TUI box alone", () => {
  const plainRowsOf = (name: string): string[] => fixtureRows(name).map((row) => row.segments.map((segment) => segment.text).join(""));

  it("a classic-CLI draft typed as Try \"…\", read plain, stays a draft, not free", () => {
    const rows = plainRowsOf("hermes--draft.txt");
    const at = rows.findIndex((row) => row.startsWith("❯ "));
    expect(at).toBeGreaterThan(0);
    const draft = 'Try "explain this codebase"';
    const got = readRows(rows.map((row, i) => (i === at ? `❯ ${draft}` : row)));
    expect(got.frame).toMatchObject({ placeholder: false, interior: { text: draft } });
    expect(got.surface.composer).toBe("draft");
    expect(isFree(got.surface)).toBe(false);
  });

  it("the profile keeps no TUI hint as a shape for every box; the TUI layout names them", () => {
    expect(IDLE.placeholders.patterns ?? []).not.toContain('^Try "[^"]+"$');
    const tui = (IDLE.frameAlternates ?? []).find((frame) => frame.placeholderPatterns !== undefined);
    expect(tui?.placeholderPatterns).toEqual(["^有什麼想問的？…$", '^Try "[^"]+"$', "^Ctrl\\+C 中斷…$"]);
  });
});
