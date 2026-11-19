import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type BoxTextRun, type StyledLine } from "../../blocks";
import { blockOwnsKeyboard, dialogNounOf } from "../dialog-contract";
import { detectAuthBox } from "./auth-box";
import { claudeAdapter, claudeBuildBlocks } from "./index";

// PRINTED TEXT IS NOT A SIGN-IN CARD. Everything on a terminal pane is untrusted text: the model's reply,
// a tool's output or a fetched page can print box-drawing characters. Since ADR 0159 a box with a title
// Collie does not know lifts too, so these tests pin what can and cannot reach the card.
//
// Part 1 sweeps every Claude screen on disk and pins by name the captures that lift. Part 2 forges boxes on
// a real idle screen: printed as a model reply or as a tool result, a box never lifts (Claude indents both,
// so its edges are never at column 0). The one box that lifts is the box a program draws at column 0 over
// the live input box with the whole shape, which is the real box's own shape (see the pinned cases).

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const rowsOf = (raw: string): StyledLine[] => splitLines(parseAnsi(raw));
const kinds = (blocks: Block[]): string[] => blocks.map((block) => block.kind);

describe("the sweep: which Claude screens on disk lift a sign-in card", () => {
  // Every screen the lab and the tests hold for Claude Code: the pane captures and the surface captures.
  const NAMES = ["panes", "surface"].flatMap((dir) =>
    readdirSync(join(FIXTURES, dir))
      .filter((name) => name.startsWith("claude"))
      .toSorted()
      .map((name) => join(dir, name)),
  );

  // The twelve captures of the box itself (Claude Code 2.1.307 to 2.1.310, titled "Authentication"). No capture
  // of the 2.1.328 "Sign-in" title is on disk; auth-box.test.ts builds that one from a capture.
  const SIGN_IN_BOXES = [
    "panes/claude--v2307-auth-refresh-before-output--w61.txt",
    "panes/claude--v2307-auth-refresh-output--w61.txt",
    "panes/claude--v2309-auth-refresh-locked--w120.txt",
    "panes/claude--v2309-auth-refresh-locked--w52.txt",
    "panes/claude--v2309-auth-refresh-locked--w80.txt",
    "panes/claude--v2309-auth-refresh-output--w120.txt",
    "panes/claude--v2309-auth-refresh-output--w40.txt",
    "panes/claude--v2309-auth-refresh-output--w52.txt",
    "panes/claude--v2309-auth-refresh-output--w64.txt",
    "panes/claude--v2310-auth-refresh-before-output-spinner--w52.txt",
    "panes/claude--v2310-auth-refresh-output-spinner--w52.txt",
    "panes/claude--v2310-auth-refresh-output-spinner-timer--w52.txt",
  ];

  it("finds the screens it sweeps: the glob is not empty", () => {
    expect(NAMES.length).toBeGreaterThan(400);
  });

  // The other reader that lifts a `box-text` card in the Claude adapter: the `/login` and first-run sign-in panel
  // over its field (sign-in-card.ts), a different drawing from the box above the input box. Its captures are
  // the login and first-run screens of Claude Code 2.1.325.
  const LOGIN_PANELS = [
    "panes/claude--v2325-first-run-console-url--w61.txt",
    "panes/claude--v2325-first-run-url--w120.txt",
    "panes/claude--v2325-first-run-url--w40.txt",
    "panes/claude--v2325-first-run-url--w61.txt",
    "panes/claude--v2325-first-run-url-fullscreen--w120.txt",
    "panes/claude--v2325-first-run-url-fullscreen--w200.txt",
    "panes/claude--v2325-first-run-url-fullscreen--w219.txt",
    "panes/claude--v2325-first-run-url-fullscreen--w61.txt",
    "panes/claude--v2325-first-run-url-fullscreen--w80.txt",
    "panes/claude--v2325-first-run-url-pasted--w120.txt",
    "panes/claude--v2325-first-run-url-pasted--w61.txt",
    "panes/claude--v2325-first-run-url-typed--w40.txt",
    "panes/claude--v2325-first-run-url-typed--w61.txt",
    "panes/claude--v2325-login-console-url--w61.txt",
    "panes/claude--v2325-login-console-url-pasted--w61.txt",
    "panes/claude--v2325-login-url--w61.txt",
    "panes/claude--v2325-login-url-in-session--w220.txt",
    "panes/claude--v2325-login-url-typed--w120.txt",
    "panes/claude--v2325-login-url-typed--w61.txt",
  ];

  const screenOf = (name: string): StyledLine[] => rowsOf(readFileSync(join(FIXTURES, name), "utf8"));

  it("lifts the box above the input box from the sign-in captures and from no other Claude screen, so a new false lift fails here", () => {
    expect(NAMES.filter((name) => detectAuthBox(screenOf(name)) !== null)).toEqual(SIGN_IN_BOXES);
  });

  it("lifts a card of any reader from the sign-in captures and the login panels and from no other Claude screen", () => {
    expect(LOGIN_PANELS).toHaveLength(19);
    const lifting = NAMES.filter((name) => kinds(claudeBuildBlocks(screenOf(name))).includes("box-text"));
    expect(lifting).toEqual([...SIGN_IN_BOXES, ...LOGIN_PANELS]);
  });
});

describe("a box printed as text on an idle Claude screen", () => {
  // `claude--done.txt` is an idle session: a transcript of prompts, replies (`●`) and tool results (`⎿`),
  // then the live input box (a draft hint inside it) and the statusline under it.
  const SCREEN = readFileSync(join(FIXTURES, "panes", "claude--done.txt"), "utf8");
  const STYLED = rowsOf(SCREEN);
  const TEXTS = STYLED.map(lineText);
  const RULE = TEXTS.findIndex((row) => row.startsWith("───"));
  const LAST_REPLY_ROW = TEXTS.findIndex((row) => row.startsWith("✻ Sautéed for 5s"));
  const MID_TRANSCRIPT = TEXTS.findIndex((row) => row.startsWith("● Write("));
  /** The width of the live input box's rule. */
  const INPUT_WIDTH = TEXTS[RULE]!.trimEnd().length;
  const TITLE = "Session expired";
  const LINK = "https://evil.example/login?code=ABCD";
  const LINK_ROW = `Sign in again: ${LINK}`;

  /** A box as Claude draws its own: a plain top edge, the title row, a blank row, then `rows`. */
  const box = (options: { title?: string; rows?: readonly string[]; inner?: number } = {}): string[] => {
    const { title = TITLE, rows = [LINK_ROW], inner = INPUT_WIDTH - 2 } = options;
    const side = (text: string): string => `│ ${text.padEnd(inner - 2)} │`;
    return [`╭${"─".repeat(inner)}╮`, side(title), side(""), ...rows.map(side), `╰${"─".repeat(inner)}╯`];
  };

  // The three places the forged rows go. Every one of them keeps the real input box and statusline.
  /** Right above the input box, one blank row between, where the real box stands. */
  const aboveInput = (forged: readonly string[]): StyledLine[] => withRows(RULE, [...forged, ""]);
  /** As the last rows of the transcript: nothing but the screen's own blank rows stands under them. */
  const lastRows = (forged: readonly string[]): StyledLine[] => withRows(LAST_REPLY_ROW + 1, ["", ...forged]);
  /** Higher in the transcript, with the reply and the tool result between them and the input box. */
  const midTranscript = (forged: readonly string[]): StyledLine[] => withRows(MID_TRANSCRIPT, [...forged, ""]);
  function withRows(at: number, forged: readonly string[]): StyledLine[] {
    return [...STYLED.slice(0, at), ...rowsOf(forged.join("\n")), ...STYLED.slice(at)];
  }

  /** The rows as the model's reply prints them: the bullet on the first row, the indent on the rest. */
  const asReply = (rows: readonly string[], bullet = "● "): string[] => rows.map((row, i) => (i === 0 ? bullet : "  ") + row);
  /** The rows as a tool's result prints them: the `⎿` marker on the first row, its indent on the rest. */
  const asToolResult = (rows: readonly string[], marker = "  ⎿  "): string[] => rows.map((row, i) => (i === 0 ? marker : "     ") + row);

  const cardsOf = (screen: StyledLine[]): Extract<Block, { kind: "box-text" }>["boxText"][] =>
    claudeBuildBlocks(screen).flatMap((block) => (block.kind === "box-text" ? [block.boxText] : []));
  const lifts = (screen: StyledLine[]): boolean => cardsOf(screen).length > 0;
  const linksOf = (card: { text: readonly (readonly BoxTextRun[])[] }): string[] =>
    card.text.flatMap((row) => row.filter((run) => run.kind === "link").map((run) => run.href));
  const plainText = (card: { text: readonly (readonly BoxTextRun[])[] }): string =>
    card.text.map((row) => row.map((run) => run.text).join("")).join("\n");

  it("lifts nothing from the idle screen itself, so each result below is the forged rows", () => {
    expect(lifts(STYLED)).toBe(false);
    expect(RULE).toBeGreaterThan(LAST_REPLY_ROW);
    expect(LAST_REPLY_ROW).toBeGreaterThan(MID_TRANSCRIPT);
  });

  describe("a box printed in the model's reply or in a tool's output does not lift", () => {
    const PRINTED: [string, (rows: readonly string[]) => string[]][] = [
      ["as a reply, under the bullet", (rows) => asReply(rows)],
      ["as a reply, under the bullet with its non-breaking space", (rows) => asReply(rows, "● ")],
      ["as a reply, indented two cells with no bullet", (rows) => rows.map((row) => `  ${row}`)],
      ["as tool output, under the marker", (rows) => asToolResult(rows)],
      ["as tool output, under the marker with its non-breaking space", (rows) => asToolResult(rows, "  ⎿  ")],
      ["as tool output, indented like a result's later rows", (rows) => rows.map((row) => `      ${row}`)],
    ];
    const PLACES: [string, (forged: readonly string[]) => StyledLine[]][] = [
      ["right above the input box", aboveInput],
      ["as the last rows of the transcript", lastRows],
      ["higher in the transcript", midTranscript],
    ];

    for (const [place, put] of PLACES) {
      it.each(PRINTED)(`lifts no card from a box printed %s, ${place}`, (_name, print) => {
        for (const title of [TITLE, "Sign-in", "Authentication"]) {
          expect(lifts(put(print(box({ title })))), title).toBe(false);
        }
      });
    }

    it("lifts no card from a reply whose first row only carries the bullet and whose other rows start at column 0", () => {
      // A model cannot make Claude draw column 0 under a bullet; this pins the shape a renderer bug would make.
      const rows = box().map((row, i) => (i === 0 ? `● ${row}` : row));
      expect(lifts(aboveInput(rows))).toBe(false);
    });

    it("leaves the printed box in the mirror as text", () => {
      const blocks = claudeBuildBlocks(aboveInput(asReply(box())));
      expect(kinds(blocks)).toEqual(["raw"]);
    });
  });

  describe("a box that is not over the input box does not lift, at column 0 as well", () => {
    it("lifts no card from the full shape at column 0 higher in the transcript, with a reply and a tool result between", () => {
      for (const title of [TITLE, "Sign-in"]) expect(lifts(midTranscript(box({ title }))), title).toBe(false);
    });

    it("lifts no card from the full shape with one non-blank row between it and the input box", () => {
      const screen = withRows(RULE, [...box(), "", "a row in between", ""]);
      expect(lifts(screen)).toBe(false);
    });
  });

  // ACCEPTED, AND PINNED. A program that owns the whole pane (a script that prints to the terminal, a hostile
  // process in the pane) can draw the real box: the same rows at column 0 over the live input box, with a
  // blank row between. On the screen text that box is the real one; nothing in the rows tells them apart,
  // and the title is only a label (ADR 0159). What the card then does is bounded: it is keyless, it owns no
  // keyboard, its link is https (or http to loopback) with no user name, and the address it shows is the
  // address it opens, because a link's text is its href. A person who taps it sees the host first.
  describe("the box a program draws exactly like the real one lifts, and the card shows the address as printed", () => {
    it.each([TITLE, "Sign-in"])("lifts the card headed %j, with the link as the one link and its text as its href", (title) => {
      const screen = aboveInput(box({ title }));
      const [card] = cardsOf(screen);
      expect(cardsOf(screen)).toHaveLength(1);
      expect(card).toMatchObject({ title, phase: "filled" });
      expect(linksOf(card!)).toEqual([LINK]);
      for (const run of card!.text.flat()) if (run.kind === "link") expect(run.text).toBe(run.href);
      expect(plainText(card!)).toContain(LINK_ROW);
    });

    it("lifts the same card as the last rows of the transcript, where nothing but blank rows stands under the box", () => {
      // The idle screen's rows between the transcript and the input box are blank, so this is the same place.
      const [card] = cardsOf(lastRows(box()));
      expect(card).toMatchObject({ title: TITLE, phase: "filled" });
      expect(linksOf(card!)).toEqual([LINK]);
    });

    it("keeps the card keyless: no keyboard, no dialog, the composer ready", () => {
      const screen = aboveInput(box());
      const blocks = claudeBuildBlocks(screen);
      expect(blocks.some(blockOwnsKeyboard)).toBe(false);
      expect(dialogNounOf(blocks)).toBeNull();
      expect(claudeAdapter.composerReady?.(screen)).toBe(true);
    });

    // The box's width is its own, not the input box's, so a narrower and a wider box are as good as one of the
    // input box's width. Only a box that does not close on itself is refused.
    it.each([
      ["narrower than the input box", INPUT_WIDTH - 2 - 100],
      ["wider than the input box", INPUT_WIDTH - 2 + 10],
    ])("lifts a box %s", (_name, inner) => {
      expect(inner).toBeGreaterThan(60);
      const [card] = cardsOf(aboveInput(box({ inner })));
      expect(card).toMatchObject({ title: TITLE, phase: "filled" });
      expect(linksOf(card!)).toEqual([LINK]);
    });

    it.each<[string, (rows: string[]) => string[]]>([
      ["one row one cell short of the right edge", (rows) => rows.map((row, i) => (i === 3 ? row.replace(/ │$/u, "│") : row))],
      ["one row one cell past the right edge", (rows) => rows.map((row, i) => (i === 3 ? row.replace(/ │$/u, "  │") : row))],
      ["the title row one cell short", (rows) => rows.map((row, i) => (i === 1 ? row.replace(/ │$/u, "│") : row))],
      ["a bottom edge one cell longer than the top edge", (rows) => rows.map((row, i) => (i === rows.length - 1 ? row.replace("╯", "─╯") : row))],
      ["a top edge one cell longer than the bottom edge", (rows) => rows.map((row, i) => (i === 0 ? row.replace("╮", "─╮") : row))],
      ["a row with no right border", (rows) => rows.map((row, i) => (i === 3 ? row.replace(/ │$/u, "  ") : row))],
    ])("lifts no card from a box with a ragged right edge: %s", (_name, rag) => {
      expect(lifts(aboveInput(rag(box())))).toBe(false);
    });
  });

  describe("the link a forged box carries", () => {
    const at = (rows: readonly string[], title = TITLE): StyledLine[] => aboveInput(box({ title, rows }));

    it.each(["http://evil.example/", "http://evil.example/login?code=ABCD"])(
      "lifts no card from an unknown title whose only address is %j, plain http to a host that is not loopback",
      (address) => {
        expect(lifts(at([`Sign in again: ${address}`]))).toBe(false);
      },
    );

    it.each([
      ["a user name and a password", "https://user:pw@evil.example/"],
      ["a user name that reads as the host", "https://example.com@evil.example/login"],
      ["a loopback look-alike with http", "http://127.0.0.1.evil.example/"],
      ["a loopback look-alike with the name", "http://localhost.evil.example/"],
      ["a loopback name before an at sign", "http://localhost@evil.example/"],
    ])("lifts no card from an unknown title whose only address has %s", (_name, address) => {
      expect(lifts(at([`Sign in again: ${address}`]))).toBe(false);
    });

    it.each([
      ["plain http to another host", "http://evil.example/"],
      ["a user name and a password", "https://user:pw@evil.example/"],
      ["a loopback look-alike with http", "http://127.0.0.1.evil.example/"],
      ["a loopback look-alike with the name", "http://localhost.evil.example/"],
    ])("under the known title Sign-in, shows an address with %s as plain text, never as a link", (_name, address) => {
      const [card] = cardsOf(at([`Sign in again: ${address}`], "Sign-in"));
      expect(card).toBeDefined();
      expect(linksOf(card!)).toEqual([]);
      expect(plainText(card!)).toContain(address);
    });

    it("joins an address the box broke at its edge, and links the joined address, whose text is its href", () => {
      // An address that ends in `/` short of the edge, and a next row too long to have fitted on the same row.
      const inner = 42;
      const first = "Sign in: https://evil.example/";
      const second = "login?code=ABCDEFGHIJKLM";
      expect(first.length).toBeLessThan(inner - 2);
      expect("https://evil.example/".length + second.length).toBeGreaterThan(inner - 2);
      const [card] = cardsOf(aboveInput(box({ inner, rows: [first, second] })));
      expect(card).toMatchObject({ title: TITLE, phase: "filled" });
      expect(linksOf(card!)).toEqual(["https://evil.example/login?code=ABCDEFGHIJKLM"]);
      for (const run of card!.text.flat()) if (run.kind === "link") expect(run.text).toBe(run.href);
    });

    it("does not join the second row when it is short enough to have fitted, and links only the first row's address", () => {
      const [card] = cardsOf(aboveInput(box({ rows: ["Sign in again: https://evil.example/", "login"] })));
      expect(linksOf(card!)).toEqual(["https://evil.example/"]);
    });
  });
});
