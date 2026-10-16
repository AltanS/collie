// Over captures. These two files used to put a screen through the phone's own guarded send, which
// fetched, so they live in the `dom` project (see `vitest.config.ts`). That send is gone since M56
// spec 06 (the bridge runs the Send Protocol), and so are the cases that drove it; what remains reads
// the captures through the omp adapter for display and its paste chunking.
//
// The captures they read are still the omp adapter's own (`src/fixtures/omp-pi-shape/`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { composerPrompt, extractInputDraft, extractStatusLines, hasComposer, stripChrome } from "../harness/omp/index";

const dir = join(import.meta.dirname, "../../fixtures/omp-pi-shape");
const idle = readFileSync(join(dir, "idle.txt"), "utf8");
const parse = (text: string) => splitLines(parseAnsi(text));
const withDraft = (draft: string) => idle.split("\n").map((row, i) => i === 1 ? ` ${draft}` : row).join("\n");

// The pi shape with its slash palette up, from the corpus (omp 18.8.0, 2026-10-07). The palette
// REPLACES the status row on this shape, and the draft lives on the filter row the locator reads as
// the editor's own — which is what lets a `/…` send verify at all.
const corpus = join(import.meta.dirname, "../../fixtures/panes");
const palette = readFileSync(join(corpus, "omp--v18-8-slash-palette.txt"), "utf8");
const paletteW48 = readFileSync(join(corpus, "omp--v18-8-slash-palette-w48.txt"), "utf8");

describe("OMP 18.1.13 pi-shaped editor (live captures, 2026-09-07)", () => {
  it("recognises the idle editor and moves its footer into the status strip", () => {
    expect(hasComposer(parse(idle))).toBe(true);
    expect(extractInputDraft(parse(idle))).toBeNull();
    expect(extractStatusLines(parse(idle))).toHaveLength(2);
    expect(stripChrome(parse(idle))).toEqual([]);
  });
  it("extracts Korean and multiline drafts and binds the draft, not just a rule", () => {
    const draft = "한글 전송 테스트\n second line";
    const screen = parse(withDraft(draft));
    expect(extractInputDraft(screen)).toBe("한글 전송 테스트 second line");
    expect(composerPrompt(screen)).toContain("한글 전송 테스트");
  });
  it("rejects the real model picker and a dialog covering the editor", () => {
    const menu = readFileSync(join(dir, "model-menu.txt"), "utf8");
    expect(hasComposer(parse(menu))).toBe(false);
    expect(hasComposer(parse(`${idle}\n${menu}`))).toBe(false);
    expect(hasComposer(parse(`${idle}\nApprove this action?`))).toBe(false);
  });
  it("excludes an unaccepted Korean inline completion from the live draft", () => {
    const capture = readFileSync(join(dir, "korean-ghost.txt"), "utf8");
    const draft = extractInputDraft(parse(capture));
    expect(draft).toContain("검사 항목 3번째 한글 내용");
    expect(draft).not.toContain("한글 내용을");
    expect(draft?.endsWith("한글 내용")).toBe(true);
  });
  it("rejects unstyled separators and missing or changed borders", () => {
    const plain = parse(idle).map((line) => line.segments.map((s) => s.text).join("")).join("\n");
    expect(hasComposer(parse(plain))).toBe(false);
    expect(hasComposer(parse(idle.split("\n").slice(1).join("\n")))).toBe(false);
    expect(hasComposer(parse(idle.replace("─", "━")))).toBe(false);
  });
});

describe("OMP 18.8 pi-shaped editor with the slash palette up (live captures, 2026-10-07)", () => {
  it.each([
    ["wide", palette],
    ["48 columns", paletteW48],
  ])("%s: reads the typed slash command off the palette's filter row", (_name, capture) => {
    const screen = parse(capture);
    expect(hasComposer(screen)).toBe(true);
    // The command the operator typed — and the reason this shape has to be recognised at all: the
    // reply guard withholds the submit key until it can read the text back off the screen.
    expect(extractInputDraft(screen)).toBe("/resume");
    // The palette stands where the statusline would be: there is none to lift for the status strip.
    expect(extractStatusLines(screen)).toEqual([]);
    // …and the run of palette rows between the composer and the tail is too long for the bridge's
    // 6-row window, so the destructive pre-clear goes out UNBOUND rather than 409ing forever.
    expect(composerPrompt(screen)).toBeNull();
  });

  it("peels the composer AND the palette off the mirror, keeping the transcript above them", () => {
    const flushed = stripChrome(parse(palette)).map((line) => line.segments.map((s) => s.text).join(""));
    expect(flushed.join("\n")).not.toContain("/resume");
    expect(flushed.join("\n")).not.toContain("Resume a different session");
    expect(flushed.join("\n")).toContain("Update Available");
  });

  it("binds the composer's rows again once the palette is short enough for the tail window", () => {
    // One entry instead of eight: the named region ends inside the bridge's window, so the sweep
    // keeps its binding. Built by dropping the other palette rows, the way the draft tests build
    // their screens.
    const rows = palette.split("\n");
    const selection = rows.findIndex((row) => row.includes("❯ 🕘 resume"));
    expect(selection).toBeGreaterThan(0);
    const screen = parse([...rows.slice(0, selection + 1), ""].join("\n"));
    const region = composerPrompt(screen);
    expect(region).toContain("/resume");
    expect(region?.split("\n").length).toBe(3); // top rule, filter row, bottom rule
  });

  it("declines an ordinary output row under the palette", () => {
    expect(hasComposer(parse(`${palette}\nplain transcript line`))).toBe(false);
  });
});
