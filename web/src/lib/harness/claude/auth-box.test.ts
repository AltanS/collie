import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type Block, type BoxTextRun, type StyledLine } from "../../blocks";
import { requireProfile } from "../../surface/profile";
import { blockOwnsKeyboard, dialogNounOf } from "../dialog-contract";
import { buildBlocks } from "../index";
import { claudeAdapter, claudeBuildBlocks } from "./index";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const FILLED_W61 = "claude--v2307-auth-refresh-output--w61.txt";
const FILLED_W120 = "claude--v2309-auth-refresh-output--w120.txt";
const FILLED_W64 = "claude--v2309-auth-refresh-output--w64.txt";
const FILLED_W40 = "claude--v2309-auth-refresh-output--w40.txt";
const FILLED_W52 = "claude--v2309-auth-refresh-output--w52.txt";
const SPINNER_WAITING = "claude--v2310-auth-refresh-before-output-spinner--w52.txt";
const SPINNER_FILLED = "claude--v2310-auth-refresh-output-spinner--w52.txt";
const SPINNER_TIMER = "claude--v2310-auth-refresh-output-spinner-timer--w52.txt";
const LOCKED = [
  "claude--v2309-auth-refresh-locked--w52.txt",
  "claude--v2309-auth-refresh-locked--w80.txt",
  "claude--v2309-auth-refresh-locked--w120.txt",
];
const LOCK_SENTENCE =
  "Another Claude Code process is running your awsAuthRefresh command. Finish signing in where that session started it, " +
  "or stop this request and send it again to sign in here instead.";

const rowsOf = (raw: string): StyledLine[] => splitLines(parseAnsi(raw));
const lines = (name: string): StyledLine[] => rowsOf(readFileSync(join(PANES, name), "utf8"));
const kinds = (blocks: Block[]): string[] => blocks.map((block) => block.kind);
const textOf = (runs: readonly BoxTextRun[]): string => runs.map((run) => run.text).join("");

function cardOf(screen: StyledLine[]) {
  const card = claudeBuildBlocks(screen).find((block) => block.kind === "box-text");
  if (card?.kind !== "box-text") throw new Error("the screen lifted no Authentication card");
  return card.boxText;
}

function drawnBox(name: string): string[] {
  const rows = lines(name).map((line) => lineText(line).trimEnd());
  const top = rows.findIndex((row) => row.startsWith("╭"));
  const bottom = rows.findIndex((row, i) => i > top && row.startsWith("╰"));
  return rows.slice(top, bottom + 1);
}

const W61_CONTENT_WIDTH = 57;
const W61_ROWS = [
  "",
  "Browser will not be automatically opened. Please visit",
  "the following URL:",
  "https://example.awsapps.com/start/#/device Then enter the",
  "code: ABCD-EFGH Alternatively, you may visit the",
  "following URL which will autofill the code upon loading:",
  "https://example.awsapps.com/start/#/device?user_code=ABCD",
  "-EFGH >>> One-tap login URL (code pre-filled): https://ex",
  "ample.awsapps.com/start/#/device?user_code=ABCD-EFGH",
].map((row) => row.padEnd(W61_CONTENT_WIDTH));
const W61_TEXT = [...W61_ROWS.slice(0, 6), W61_ROWS.slice(6).join("")];

describe("the Authentication box over the live input box", () => {
  it("lifts a filled box as one card headed by the box's own title, after the transcript above it", () => {
    const blocks = claudeBuildBlocks(lines(FILLED_W61));
    expect(kinds(blocks)).toEqual(["raw", "box-text"]);
    const card = cardOf(lines(FILLED_W61));
    expect(card.title).toBe("Authentication");
    expect(card.phase).toBe("filled");
  });

  it("shows the box's rows under the title in the box's order, blank rows included, with the border and one padding cell dropped from each side", () => {
    expect(cardOf(lines(FILLED_W61)).text.map(textOf)).toEqual(W61_TEXT);
  });

  it("takes the content width from the box's own edges, not the pane's: 109 cells in a 113-wide box on a 120-column pane", () => {
    const drawn = drawnBox(FILLED_W120);
    expect(drawn[0]).toHaveLength(113);
    const text = cardOf(lines(FILLED_W120)).text.map(textOf);
    expect(text).toEqual(drawn.slice(2, -1).map((row) => row.slice(2, -2)));
    expect(text.every((row) => row.length === 109)).toBe(true);
  });

  it("leaves the transcript above the box in the mirror and the box, the input box and the status rows out of it", () => {
    const raw = claudeBuildBlocks(lines(FILLED_W61))[0]!;
    if (raw.kind !== "raw") throw new Error("no raw block");
    const mirrored = raw.lines.map(lineText).join("\n");
    expect(mirrored).toContain("Claude Code");
    expect(mirrored).toContain("~/work");
    expect(mirrored).not.toContain("Authentication");
    expect(mirrored).not.toContain("╭");
    expect(mirrored).not.toContain("❯");
    expect(mirrored).not.toContain("Context:");
  });

  it("links an address on a row and keeps every other character plain", () => {
    const row = cardOf(lines(FILLED_W61)).text[3]!;
    expect(row.filter((run) => run.kind === "link")).toEqual([
      { kind: "link", text: "https://example.awsapps.com/start/#/device", href: "https://example.awsapps.com/start/#/device" },
    ]);
    expect(textOf(row)).toBe(W61_TEXT[3]);
    expect(textOf(row.filter((run) => run.kind === "plain"))).toBe(" Then enter the");
  });

  it("finds every address of a box that breaks none, through the tmux capture's OSC 8 hyperlinks, and stops a link at the space after it", () => {
    const links = cardOf(lines(FILLED_W120)).text.flatMap((row) => row.filter((run) => run.kind === "link"));
    expect(links).toEqual(
      [
        "https://example.awsapps.com/start/#/device",
        "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
        "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH",
        "https://docs.example.com/cli/latest/userguide/sso-configure-profile-token.html",
      ].map((address) => ({ kind: "link", text: address, href: address })),
    );
  });

  it("shows the text of a box that holds no address, with no link, at every width the lock message was captured", () => {
    for (const name of LOCKED) {
      const card = cardOf(lines(name));
      expect(card.title, name).toBe("Authentication");
      expect(card.phase, name).toBe("filled");
      const rows = card.text.map(textOf);
      expect(rows[0]!.trim(), name).toBe("");
      expect(
        rows
          .map((row) => row.trim())
          .filter((row) => row !== "")
          .join(" "),
        name,
      ).toBe(LOCK_SENTENCE);
      expect(
        card.text.flat().some((run) => run.kind === "link"),
        name,
      ).toBe(false);
    }
  });

  it("owns no keyboard, names no dialog, and leaves the composer ready", () => {
    const blocks = claudeBuildBlocks(lines(FILLED_W61));
    expect(kinds(blocks)).toContain("box-text");
    expect(blocks.some(blockOwnsKeyboard)).toBe(false);
    expect(dialogNounOf(blocks)).toBeNull();
    expect(claudeAdapter.composerReady?.(lines(FILLED_W61))).toBe(true);
  });
});

describe("the Authentication box lifts only while the rows under the input box read as Claude's statusline", () => {
  const STATUS_ROW_CAP = requireProfile("claude").idle.volatile.below.maxRows;
  const outputRows = (count: number): StyledLine[] =>
    Array.from({ length: count }, (_, i) => rowsOf(`output row ${String(i)}`)[0]!);

  it("lifts the card on the capture itself, and not once ordinary output rows stand under the status rows past the status-row cap", () => {
    expect(cardOf(lines(FILLED_W61)).title).toBe("Authentication");
    const buried = [...lines(FILLED_W61), ...outputRows(STATUS_ROW_CAP + 1)];
    expect(kinds(claudeBuildBlocks(buried))).not.toContain("box-text");
  });

  it("lifts with the status run at the cap and not one row past it", () => {
    const base = lines(FILLED_W61);
    const statusRow = base.at(-1)!;
    const statusRowsOnCapture = 2;
    const withStatusRows = (total: number) => [...base, ...Array.from({ length: total - statusRowsOnCapture }, () => statusRow)];
    expect(kinds(claudeBuildBlocks(withStatusRows(STATUS_ROW_CAP)))).toContain("box-text");
    expect(kinds(claudeBuildBlocks(withStatusRows(STATUS_ROW_CAP + 1)))).not.toContain("box-text");
  });

  it("shows the completion popup's own card, and no Authentication card, when the popup stands under the input box", () => {
    const popup = lines("claude--autocomplete-slash-short.txt");
    const box = lines(FILLED_W61);
    const boxTop = box.findIndex((line) => lineText(line).startsWith("╭"));
    const boxBottom = box.findIndex((line) => lineText(line).startsWith("╰"));
    const rule = popup.findIndex((line) => lineText(line).startsWith("───"));
    const screen = [...popup.slice(0, rule), ...box.slice(boxTop, boxBottom + 1), rowsOf("")[0]!, ...popup.slice(rule)];
    expect(kinds(claudeBuildBlocks(screen))).toEqual(["raw", "autocomplete"]);
  });
});

describe("only the Authentication box over Claude's live input box lifts", () => {
  const plainRows = (name: string): string[] => lines(name).map(lineText);
  const FILLED_ROWS = plainRows(FILLED_W61);
  const TOP = FILLED_ROWS.findIndex((row) => row.startsWith("╭"));
  const BOTTOM = FILLED_ROWS.findIndex((row) => row.startsWith("╰"));
  const TITLE_ROW = TOP + 1;
  const INPUT_RULE = FILLED_ROWS.findIndex((row, i) => i > BOTTOM && row.startsWith("───"));
  const screenOf = (rows: readonly string[]): StyledLine[] => rowsOf(rows.join("\n"));
  const withRow = (index: number, text: string): string[] => FILLED_ROWS.map((row, i) => (i === index ? text : row));
  const retitled = (title: string): string[] =>
    withRow(TITLE_ROW, `│ ${title}`.padEnd(FILLED_ROWS[TOP]!.length - 1) + "│");
  const liftsNoCard = (rows: readonly string[]): boolean => !kinds(claudeBuildBlocks(screenOf(rows))).includes("box-text");

  it("lifts the unmodified capture, so each refusal below is the change it makes", () => {
    expect(kinds(claudeBuildBlocks(screenOf(FILLED_ROWS)))).toEqual(["raw", "box-text"]);
  });

  it("lifts no card from a screen with no box, and shows it as the plain screen", () => {
    const withoutBox = [...FILLED_ROWS.slice(0, TOP), ...FILLED_ROWS.slice(BOTTOM + 1)];
    expect(kinds(claudeBuildBlocks(screenOf(withoutBox)))).toEqual(["raw"]);
  });

  it.each(["Notifications", "authentication", "AUTHENTICATION", "Authentication needed", "Re-Authentication", "Authentication:"])(
    "lifts no card from a box whose title row reads %j",
    (title) => {
      expect(liftsNoCard(retitled(title))).toBe(true);
    },
  );

  it("lifts no card when a non-blank row stands between the box's bottom edge and the input box", () => {
    const rows = [...FILLED_ROWS.slice(0, INPUT_RULE), "a row in between", ...FILLED_ROWS.slice(INPUT_RULE)];
    expect(liftsNoCard(rows)).toBe(true);
  });

  it("lifts no card when Claude's live input box is not under the box", () => {
    expect(liftsNoCard(FILLED_ROWS.slice(0, INPUT_RULE))).toBe(true);
  });

  it.each([
    ["a top edge closed by the wrong corner", TOP, (row: string) => row.replace(/╮$/u, "╯")],
    ["a bottom edge opened by the wrong corner", BOTTOM, (row: string) => row.replace(/^╰/u, "╭")],
    ["a top edge a cell wider than the bottom edge and the side rows", TOP, (row: string) => row.replace(/╮$/u, "─╮")],
    ["a top edge a cell narrower than the bottom edge and the side rows", TOP, (row: string) => row.replace(/─╮$/u, "╮")],
    ["a bottom edge shorter than the top edge", BOTTOM, (row: string) => row.replace("─╯", "╯")],
    ["a side row a cell narrower than the edges", TOP + 3, (row: string) => row.replace(/ │$/u, "│")],
    ["a side row a cell wider than the edges", TOP + 3, (row: string) => `${row} │`],
    ["a side row with a different right border", TOP + 3, (row: string) => row.replace(/│$/u, "┃")],
    ["a side row with a different left border", TOP + 3, (row: string) => row.replace(/^│/u, "┃")],
  ])("lifts no card from a box with %s", (_name, index, mutate) => {
    expect(liftsNoCard(withRow(index, mutate(FILLED_ROWS[index]!)))).toBe(true);
  });

  it("lifts no card when a dialog's numbered choice list is drawn under the input box", () => {
    const rows = [...FILLED_ROWS.slice(0, INPUT_RULE + 3), "  ❯ 1. Yes", "    2. No", "", "  Esc to cancel"];
    expect(liftsNoCard(rows)).toBe(true);
  });

  it("lifts the card from a Claude pane and from no other harness's pane", () => {
    const screen = screenOf(FILLED_ROWS);
    expect(kinds(buildBlocks(screen, { agent: "claude" }))).toEqual(["raw", "box-text"]);
    for (const agent of ["codex", "shell", "pi", undefined]) {
      const blocks = buildBlocks(screen, { agent });
      expect(kinds(blocks), String(agent)).not.toContain("box-text");
      const mirrored = blocks.flatMap((block) => (block.kind === "raw" ? block.lines.map(lineText) : [])).join("\n");
      expect(mirrored, String(agent)).toContain("Authentication");
    }
  });

  it("lifts no card under the Raw terminal preference, and mirrors the box's rows", () => {
    const blocks = buildBlocks(screenOf(FILLED_ROWS), { agent: "claude", grammars: false });
    expect(kinds(blocks)).toEqual(["raw"]);
    const mirrored = blocks.flatMap((block) => (block.kind === "raw" ? block.lines.map(lineText) : [])).join("\n");
    expect(mirrored).toContain("╭");
    expect(mirrored).toContain("Authentication");
  });
});

describe("a URL the box broke at its right edge reads as one link on the card", () => {
  const CODE_URL = "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH";
  const DEVICE_URL = "https://example.awsapps.com/start/#/device";
  const linksOf = (card: { text: readonly (readonly BoxTextRun[])[] }): BoxTextRun[] =>
    card.text.flatMap((row) => row.filter((run) => run.kind === "link"));
  const linkTo = (address: string): BoxTextRun => ({ kind: "link", text: address, href: address });

  const FILLED_ROWS = lines(FILLED_W61).map(lineText);
  const TOP = FILLED_ROWS.findIndex((row) => row.startsWith("╭"));
  const BOTTOM = FILLED_ROWS.findIndex((row) => row.startsWith("╰"));
  function cardOfBox(contentWidth: number, ...contentRows: string[]) {
    const edge = contentWidth + 4;
    const side = (text: string): string => `│ ${text.padEnd(contentWidth)} │`;
    const box = [`╭${"─".repeat(edge - 2)}╮`, side("Authentication"), side(""), ...contentRows.map(side), `╰${"─".repeat(edge - 2)}╯`];
    return cardOf(rowsOf([...FILLED_ROWS.slice(0, TOP), ...box, ...FILLED_ROWS.slice(BOTTOM + 1)].join("\n")));
  }

  it("links the code-prefilled address once where the box broke it after ABCD and again after https://ex, with the text between the two links plain", () => {
    const card = cardOf(lines(FILLED_W61));
    expect(linksOf(card)).toEqual([linkTo(DEVICE_URL), linkTo(CODE_URL), linkTo(CODE_URL)]);
    expect(card.text[6]).toEqual([
      linkTo(CODE_URL),
      { kind: "plain", text: " >>> One-tap login URL (code pre-filled): " },
      linkTo(CODE_URL),
      { kind: "plain", text: "     " },
    ]);
  });

  it("links no fragment of a broken address on its own row", () => {
    const hrefs = linksOf(cardOf(lines(FILLED_W61))).map((run) => run.text);
    expect(hrefs).not.toContain("https://ex");
    expect(hrefs).not.toContain("https://example.awsapps.com/start/#/device?user_code=ABCD");
  });

  it("joins every break of the 60-cell box, one link per address, and keeps the rows the box ended itself", () => {
    const card = cardOf(lines(FILLED_W64));
    expect(linksOf(card)).toEqual([
      linkTo(DEVICE_URL),
      linkTo(CODE_URL),
      linkTo(CODE_URL),
      linkTo("https://docs.example.com/cli/latest/userguide/sso-configure-profile-token.html"),
    ]);
    expect(card.text.map((row) => textOf(row).trimEnd())).toEqual([
      "",
      "Browser will not be automatically opened.",
      "Please visit the following URL:",
      "https://example.awsapps.com/start/#/device Then enter the",
      "code: ABCD-EFGH Alternatively, you may visit the following",
      `URL which will autofill the code upon loading: ${CODE_URL} >>>`,
      `One-tap login URL (code pre-filled): ${CODE_URL} See ~/.aws/config`,
      "--profile e.g. v2.1 docs at https://docs.example.com/cli/latest/userguide/sso-configure-profile-token.html for details.",
    ]);
  });

  it("joins a URL spread over three rows into one link", () => {
    const card = cardOfBox(25, "https://example.awsapps.c", "om/start/#/device?user_co", "de=ABCD-EFGH");
    expect(card.text).toHaveLength(2);
    expect(linksOf(card)).toEqual([linkTo(CODE_URL)]);
  });

  it("joins a URL broken inside the device code, with the word after it plain", () => {
    const card = cardOfBox(55, "https://example.awsapps.com/start/#/device?user_code=AB", "CD-EFGH Alternatively");
    expect(card.text[1]!.map((run) => run.kind)).toEqual(["link", "plain"]);
    expect(linksOf(card)).toEqual([linkTo(CODE_URL)]);
    expect(card.text[1]!.at(-1)!.text.trim()).toBe("Alternatively");
  });

  it("links a URL that ends before the last column up to the space, and joins nothing", () => {
    const card = cardOfBox(57, "https://example.awsapps.com/start/#/device Then enter the", "code: ABCD-EFGH");
    expect(card.text).toHaveLength(3);
    expect(linksOf(card)).toEqual([linkTo(DEVICE_URL)]);
    expect(textOf(card.text[1]!).trimEnd()).toBe("https://example.awsapps.com/start/#/device Then enter the");
    expect(textOf(card.text[2]!).trimEnd()).toBe("code: ABCD-EFGH");
  });

  it("links a short URL that ends on the last column alone, with no word of the next row glued on", () => {
    const card = cardOfBox(57, "Open the page: https://example.awsapps.com/start/#/device", "Then enter the code: ABCD-EFGH");
    expect(card.text).toHaveLength(3);
    expect(linksOf(card)).toEqual([linkTo(DEVICE_URL)]);
    expect(textOf(card.text[1]!)).toBe("Open the page: https://example.awsapps.com/start/#/device");
  });
});

describe("a URL the box broke next to a slash short of its edge reads as one link on the card", () => {
  const DEVICE_URL = "https://example.awsapps.com/start/#/device";
  const CODE_URL = "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH";
  const DOCS_URL = "https://docs.example.com/cli/latest/userguide/sso-configure-profile-token.html";
  const linksOf = (card: { text: readonly (readonly BoxTextRun[])[] }): string[] =>
    card.text.flatMap((row) => row.filter((run) => run.kind === "link").map((run) => run.text));
  const rowTexts = (card: { text: readonly (readonly BoxTextRun[])[] }): string[] =>
    card.text.map((row) => textOf(row).trimEnd());

  it("joins the 36-cell box's break before a slash, with See plain after the link", () => {
    const card = cardOf(lines(FILLED_W40));
    expect(linksOf(card)).toEqual([DEVICE_URL, CODE_URL, CODE_URL, DOCS_URL]);
    const seeRow = card.text.find((row) => textOf(row).includes("See"))!;
    expect(seeRow.map((run) => run.kind)).toEqual(["link", "plain"]);
    expect(seeRow[0]!.text).toBe(CODE_URL);
    expect(seeRow[1]!.text.trim()).toBe("See");
  });

  it("shows the 36-cell box's rows with each broken address on one line and the rows the box ended itself kept", () => {
    expect(rowTexts(cardOf(lines(FILLED_W40)))).toEqual([
      "",
      "Browser will not be automatically",
      "opened.",
      "Please visit the following URL:",
      `${DEVICE_URL} Then enter the code:`,
      "ABCD-EFGH Alternatively, you may",
      "visit the following URL which will",
      "autofill the code upon loading:",
      `${CODE_URL} >>>`,
      "One-tap login URL (code pre-filled):",
      `${CODE_URL} See`,
      "~/.aws/config --profile e.g. v2.1",
      `docs at ${DOCS_URL} for details.`,
    ]);
  });

  it("joins the 48-cell box's break after a slash, with the text before the link plain", () => {
    const card = cardOf(lines(FILLED_W52));
    expect(linksOf(card)).toEqual([DEVICE_URL, CODE_URL, CODE_URL, DOCS_URL]);
    expect(rowTexts(card)).toEqual([
      "",
      "Browser will not be automatically opened.",
      "Please visit the following URL:",
      `${DEVICE_URL} Then`,
      "enter the code: ABCD-EFGH Alternatively, you may",
      "visit the following URL which will autofill the",
      `code upon loading: ${CODE_URL} >>> One-tap`,
      `login URL (code pre-filled): ${CODE_URL} See`,
      "~/.aws/config --profile e.g. v2.1 docs at",
      `${DOCS_URL} for details.`,
    ]);
    expect(card.text[6]!.map((run) => run.kind)).toEqual(["plain", "link", "plain"]);
  });
});

describe("a title-only Authentication box lifts as a waiting card", () => {
  const WAITING_W61 = "claude--v2307-auth-refresh-before-output--w61.txt";
  const rows = lines(WAITING_W61).map(lineText);
  const TOP = rows.findIndex((row) => row.startsWith("╭"));
  const BOTTOM = rows.findIndex((row) => row.startsWith("╰"));
  const INNER = rows[TOP]!.trimEnd().length - 2;
  const boxRow = (text: string): string => `│ ${text}`.padEnd(INNER + 1) + "│";
  const screenOf = (all: readonly string[]): StyledLine[] => rowsOf(all.join("\n"));
  const withBoxRows = (inside: readonly string[]): string[] => [...rows.slice(0, TOP + 1), ...inside, ...rows.slice(BOTTOM)];
  const liftsNoCard = (all: readonly string[]): boolean => !kinds(claudeBuildBlocks(screenOf(all))).includes("box-text");

  it("lifts the capture as one waiting card headed by the box's own title, with no text rows, after the transcript", () => {
    expect(kinds(claudeBuildBlocks(lines(WAITING_W61)))).toEqual(["raw", "box-text"]);
    expect(cardOf(lines(WAITING_W61))).toEqual({ title: "Authentication", phase: "waiting", text: [] });
  });

  it("leaves the transcript above the box in the mirror and the box, the input box and the status rows out of it", () => {
    const raw = claudeBuildBlocks(lines(WAITING_W61))[0]!;
    if (raw.kind !== "raw") throw new Error("no raw block");
    const mirrored = raw.lines.map(lineText).join("\n");
    expect(mirrored).toContain("Claude Code");
    expect(mirrored).not.toContain("Authentication");
    expect(mirrored).not.toContain("╭");
    expect(mirrored).not.toContain("❯");
    expect(mirrored).not.toContain("Context:");
  });

  it.each([1, 2, 3])("lifts a waiting card, not an empty filled one, from a box with %i blank rows under the title", (count) => {
    const card = cardOf(screenOf(withBoxRows([boxRow("Authentication"), ...Array.from({ length: count }, () => boxRow(""))])));
    expect(card).toEqual({ title: "Authentication", phase: "waiting", text: [] });
  });

  it("lifts a filled card once a row under the title holds text", () => {
    const card = cardOf(screenOf(withBoxRows([boxRow("Authentication"), boxRow(""), boxRow("Wait a moment")])));
    expect(card.phase).toBe("filled");
    expect(card.text.map(textOf).map((row) => row.trimEnd())).toEqual(["", "Wait a moment"]);
  });

  it.each(["Settings", "authentication", "AUTHENTICATION", "Authentication needed", "Authentication:"])(
    "lifts no card from a title-only box titled %j",
    (title) => {
      expect(liftsNoCard(withBoxRows([boxRow(title)]))).toBe(true);
    },
  );

  it("lifts no card from a title-only box with an empty row where the title stands", () => {
    expect(liftsNoCard(withBoxRows([boxRow("")]))).toBe(true);
  });

  it("lifts no card when a non-blank row stands between the title-only box and the input box", () => {
    const at = rows.findIndex((row, i) => i > BOTTOM && row.startsWith("───"));
    expect(liftsNoCard([...rows.slice(0, at), "a row in between", ...rows.slice(at)])).toBe(true);
  });

  it("lifts no card when Claude's live input box is not under the title-only box", () => {
    const at = rows.findIndex((row, i) => i > BOTTOM && row.startsWith("───"));
    expect(liftsNoCard(rows.slice(0, at))).toBe(true);
  });

  it("lifts the card from a Claude pane and from no other harness's pane", () => {
    const screen = lines(WAITING_W61);
    expect(kinds(buildBlocks(screen, { agent: "claude" }))).toEqual(["raw", "box-text"]);
    for (const agent of ["codex", "shell", "pi", undefined]) {
      expect(kinds(buildBlocks(screen, { agent })), String(agent)).not.toContain("box-text");
    }
  });
});

describe("a turn spinner row between the box and the input box leaves the card lifted", () => {
  const DEVICE_URL = "https://example.awsapps.com/start/#/device";
  const CODE_URL = "https://example.awsapps.com/start/#/device?user_code=ABCD-EFGH";
  const DOCS_URL = "https://docs.example.com/cli/latest/userguide/sso-configure-profile-token.html";
  const linksOf = (card: { text: readonly (readonly BoxTextRun[])[] }): string[] =>
    card.text.flatMap((row) => row.filter((run) => run.kind === "link").map((run) => run.text));
  const screenOf = (rows: readonly string[]): StyledLine[] => rowsOf(rows.join("\n"));
  const liftsNoCard = (rows: readonly string[]): boolean => !kinds(claudeBuildBlocks(screenOf(rows))).includes("box-text");

  it("lifts the waiting card from a title-only box with the spinner row under it", () => {
    expect(kinds(claudeBuildBlocks(lines(SPINNER_WAITING)))).toEqual(["raw", "box-text"]);
    expect(cardOf(lines(SPINNER_WAITING))).toEqual({ title: "Authentication", phase: "waiting", text: [] });
  });

  it.each([SPINNER_FILLED, SPINNER_TIMER])("lifts the filled card, each address one link, from %s", (name) => {
    const card = cardOf(lines(name));
    expect(card.phase).toBe("filled");
    expect(linksOf(card)).toEqual([DEVICE_URL, CODE_URL, CODE_URL, DOCS_URL]);
  });

  it.each([SPINNER_WAITING, SPINNER_FILLED, SPINNER_TIMER])("leaves the spinner row out of the card in %s", (name) => {
    const card = cardOf(lines(name));
    const cardText = card.text.map(textOf).join("\n");
    expect(cardText).not.toMatch(/Whirlpooling|Garnishing|Moonwalking/u);
  });

  const SPINNER_ROWS = [
    "✢ Whirlpooling… ",
    "✶ Garnishing… ",
    "✻ Moonwalking… (49s)",
    "✶ Hashing… · tool use (4s · thinking with high effort)",
    "✽ Brewing… (1m 27s)",
    "* Cooking… (4s · ↓ 304 tokens)",
  ];
  const baseRows = lines(SPINNER_FILLED).map(lineText);
  const SPINNER_AT = baseRows.findIndex((row) => row.startsWith("✶ Garnishing"));
  const withUnderBox = (under: readonly string[]): string[] => [
    ...baseRows.slice(0, SPINNER_AT - 1),
    ...under,
    ...baseRows.slice(SPINNER_AT + 1),
  ];

  it.each(SPINNER_ROWS)("lifts the card with %j under the box's bottom edge", (row) => {
    expect(liftsNoCard(withUnderBox([row]))).toBe(false);
  });

  it.each([
    ["a plain sentence", ["Still waiting for the browser to finish."]],
    ["a plain sentence beside a spinner row", ["✶ Garnishing… ", "Still waiting for the browser to finish."]],
    ["two spinner rows", ["✢ Whirlpooling… ", "✶ Garnishing… "]],
    ["a glyph and a word with no ellipsis", ["✶ Garnishing"]],
  ])("lifts no card with %s under the box's bottom edge", (_name, under) => {
    expect(liftsNoCard(withUnderBox(under))).toBe(true);
  });
});
