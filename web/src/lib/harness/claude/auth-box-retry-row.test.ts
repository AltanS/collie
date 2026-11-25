// Issue 862: the Sign-in card over Claude's API retry row, in each form of the row's retry word.
// Claude Code 2.1.318 printed "Retrying in 3s"; from 2.1.330 at the latest it prints "retrying in 3s",
// and "retrying…" once the countdown reaches zero. The screens are written here, in the report's
// shape: the box, two blank rows, the retry row, a blank row, the live input box and its statusline.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { agentOf, idleFor, readScreen, rowsOf } from "../../../test/surface-corpus";
import { lineText, type BoxTextRun, type StyledLine } from "../../blocks";
import { claudeBuildBlocks } from "./index";

const WIDTH = 60;
const LINK = "https://login.example.com/device?code=ABCD-EFGH";
const FILLED_ROWS = ["Open this page to sign in:", LINK, "Then enter the code: ABCD-EFGH"];

const boxOf = (rows: readonly string[]): string[] => [
  `╭${"─".repeat(WIDTH - 2)}╮`,
  ...rows.map((row) => `│ ${row.padEnd(WIDTH - 4)} │`),
  `╰${"─".repeat(WIDTH - 2)}╯`,
];

const INPUT_BOX = ["─".repeat(WIDTH), "❯ ", "─".repeat(WIDTH), "  Context: --% │ 💰 $0.00", "  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle)"];

function screenOf(boxRows: readonly string[], under: readonly string[]): StyledLine[] {
  return rowsOf(["❯ hello", "", "⏺ Hello.", "", ...boxOf(["Sign-in", "", ...boxRows]), "", "", ...under, "", ...INPUT_BOX].join("\n"));
}

const filledWith = (under: readonly string[]) => screenOf(FILLED_ROWS, under);
const waitingWith = (under: readonly string[]) => screenOf([], under);
const kinds = (screen: StyledLine[]): string[] => claudeBuildBlocks(screen).map((block) => block.kind);
const textOf = (runs: readonly BoxTextRun[]): string => runs.map((run) => run.text).join("");

function cardOf(screen: StyledLine[]) {
  const card = claudeBuildBlocks(screen).find((block) => block.kind === "box-text");
  if (card?.kind !== "box-text") throw new Error("the screen lifted no Sign-in card");
  return card.boxText;
}

const RETRY_ROWS = [
  "✻ API error · retrying… · attempt 1/2",
  "✻ API error · retrying in 3s · attempt 1/2",
  "✻ API error · retrying in 1m 5s · attempt 2/10",
  "✻ The request failed on the server side · retrying… · attempt 2/2",
  "✻ Usage limit reached · retrying in 5m (resets 3pm) · attempt 4/10",
  "✻ API error · Retrying in 3s · attempt 1/2",
];

describe("the Sign-in card lifts over Claude's API retry row in each form of its retry word (issue 862)", () => {
  it.each(RETRY_ROWS)("lifts the filled card, with its one link, over %j", (row) => {
    expect(kinds(filledWith([row]))).toEqual(["raw", "box-text"]);
    const card = cardOf(filledWith([row]));
    expect(card).toMatchObject({ title: "Sign-in", phase: "filled" });
    expect(card.text.flatMap((runs) => runs.filter((run) => run.kind === "link").map((run) => run.href))).toEqual([LINK]);
    expect(card.text.map(textOf).join("\n")).not.toMatch(/retrying/i);
  });

  it.each(RETRY_ROWS)("lifts the waiting card from a title-only box over %j", (row) => {
    expect(cardOf(waitingWith([row]))).toEqual({ title: "Sign-in", phase: "waiting", text: [] });
  });

  it("still lifts the card with no row, and with a turn spinner row, under the box", () => {
    expect(cardOf(filledWith([])).phase).toBe("filled");
    expect(cardOf(filledWith(["✻ Incubating… "])).phase).toBe("filled");
  });

  it("still lifts the card on the recorded 2.1.310 screen, with its retry row in the spinner's place", () => {
    const panes = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
    const rows = rowsOf(readFileSync(join(panes, "claude--v2310-auth-refresh-output-spinner--w52.txt"), "utf8")).map(lineText);
    const at = rows.findIndex((row) => row.startsWith("✶ Garnishing"));
    expect(at).toBeGreaterThan(0);
    for (const row of [rows[at]!, "✻ API error · retrying… · attempt 1/2"]) {
      const screen = rowsOf([...rows.slice(0, at), row, ...rows.slice(at + 1)].join("\n"));
      expect(cardOf(screen).phase).toBe("filled");
    }
  });

  it.each([
    ["an ordinary sentence", ["Still waiting for the browser to finish."]],
    ["a glyph row that is neither a spinner nor a retry row", ["✻ API error · attempt 1/2"]],
    ["a retry row drawn with another glyph", ["* API error · retrying… · attempt 1/2"]],
    ["a retry word with neither a countdown nor an ellipsis", ["✻ API error · retrying · attempt 1/2"]],
    ["three dots in place of the ellipsis", ["✻ API error · retrying... · attempt 1/2"]],
    ["a countdown word with no time", ["✻ API error · retrying in · attempt 1/2"]],
    ["text after the attempt count", ["✻ API error · retrying… · attempt 1/2 · giving up"]],
    ["no attempt count", ["✻ API error · retrying…"]],
    ["a retry row beside a spinner row", ["✻ API error · retrying… · attempt 1/2", "✻ Incubating… "]],
    ["two retry rows", ["✻ API error · retrying… · attempt 1/2", "✻ API error · retrying in 1s · attempt 2/2"]],
  ])("lifts no card with %s under the box", (_name, under) => {
    expect(kinds(filledWith(under))).not.toContain("box-text");
  });

  it("reads the same Surface with the card as without it, so the composer and a send stay as they are", () => {
    const read = (screen: StyledLine[]) => readScreen(screen, agentOf("claude"), idleFor("claude")).surface;
    const refused = read(filledWith(["✻ API error · retrying · attempt 1/2"]));
    expect(refused).toMatchObject({ modal: "none", composer: "empty" });
    for (const row of RETRY_ROWS) expect(read(filledWith([row]))).toEqual(refused);
    expect(read(filledWith(["✻ Incubating… "]))).toEqual(refused);
  });
});
