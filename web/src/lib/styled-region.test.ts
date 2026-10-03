import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import {
  canonicalStyledLines,
  decodeStyledRegion,
  encodeStyledRegion,
  STYLED_FORMAT,
  styledRegionLines,
} from "./styled-region";

const ESC = "\u001b";
const US = "\u001f";
/** One canonical run, spelled out. */
const run = (tag: string, text: string) => `${US}${tag}${US}${text}`;
/** One canonical line: its runs, concatenated. */
const joined = (...runs: string[]) => runs.join("");

describe("styledRegionLines: the canonical form depends on the grid, not on the escapes", () => {
  it("one SGR spelled three ways is one line", () => {
    const a = styledRegionLines(`${ESC}[1;31mX${ESC}[0m`);
    const b = styledRegionLines(`${ESC}[31m${ESC}[1mX${ESC}[m`);
    const c = styledRegionLines(`${ESC}[38;5;1m${ESC}[1mX${ESC}[0m`); // indexed colour, the other spelling
    expect(a).toEqual([run("fg=var(--ansi-1),b", "X")]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("splitting or merging adjacent same-style runs gives the same line", () => {
    const merged = styledRegionLines(`${ESC}[32mabcd${ESC}[0m`);
    const split = styledRegionLines(`${ESC}[32mab${ESC}[32mc${ESC}[0m${ESC}[32md${ESC}[0m`);
    const reset = styledRegionLines(`${ESC}[32mab${ESC}[0m${ESC}[32mcd`);
    expect(merged).toEqual([run("fg=var(--ansi-2)", "abcd")]);
    expect(split).toEqual(merged);
    expect(reset).toEqual(merged);
  });

  it("a style change inside a line starts a new run", () => {
    expect(styledRegionLines(`a${ESC}[41mb${ESC}[0mc`)).toEqual([
      joined(run("-", "a"), run("bg=var(--ansi-1)", "b"), run("-", "c")),
    ]);
  });

  it("inverse video is resolved into the colours it shows", () => {
    // Red on green, inverted, is green on red: the same cell however it was encoded.
    expect(styledRegionLines(`${ESC}[7;31;42mX`)).toEqual(styledRegionLines(`${ESC}[32;41mX`));
    expect(styledRegionLines(`${ESC}[31;42m${ESC}[7mX`)).toEqual(styledRegionLines(`${ESC}[32;41mX`));
  });

  it("different styles on the same text are different lines (the whole point)", () => {
    const here = styledRegionLines(`${ESC}[48;2;245;167;66mAllow once${ESC}[0m  Reject`);
    const there = styledRegionLines(`Allow once  ${ESC}[48;2;245;167;66mReject${ESC}[0m`);
    expect(here).not.toEqual(there);
  });

  it("tags the first run of every line, whatever the previous line left behind", () => {
    // The multiplexer may carry the style across a newline or restate it: the visible grid is the same.
    const carried = styledRegionLines(`${ESC}[31mone\ntwo\n`);
    const restated = styledRegionLines(`${ESC}[31mone${ESC}[0m\n${ESC}[31mtwo${ESC}[0m\n`);
    expect(carried).toEqual([run("fg=var(--ansi-1)", "one"), run("fg=var(--ansi-1)", "two")]);
    expect(restated).toEqual(carried);
  });

  it("drops trailing whitespace whatever its style, and lines that are then empty", () => {
    const text = [
      `${ESC}[31mkept${ESC}[0m   `,
      `${ESC}[48;2;1;2;3m      ${ESC}[0m`,
      "",
      `${ESC}[4m   ${ESC}[0m`,
      `last${ESC}[48;2;9;9;9m   ${ESC}[0m   `,
    ].join("\r\n");
    expect(styledRegionLines(text)).toEqual([run("fg=var(--ansi-1)", "kept"), run("-", "last")]);
  });

  it("keeps leading and inner spacing, and a visible background on a blank cell", () => {
    expect(styledRegionLines(`  a${ESC}[41m  ${ESC}[0mb`)).toEqual([
      joined(run("-", "  a"), run("bg=var(--ansi-1)", "  "), run("-", "b")),
    ]);
  });

  it("a blank cell shows no foreground, weight or slant: those do not split or distinguish a run", () => {
    const plain = styledRegionLines(`${ESC}[32mone two${ESC}[0m`);
    const noisy = styledRegionLines(`${ESC}[32mone${ESC}[1;3;35m ${ESC}[32;22;23mtwo${ESC}[0m`);
    expect(plain).toEqual([run("fg=var(--ansi-2)", "one two")]);
    expect(noisy).toEqual(plain);
    // But underline on a blank cell is visible.
    expect(styledRegionLines(`a${ESC}[4m ${ESC}[0mb`)).toEqual([
      joined(run("-", "a"), run("u", " "), run("-", "b")),
    ]);
  });

  it("a text change is a different line", () => {
    expect(styledRegionLines(`${ESC}[31mone`)).not.toEqual(styledRegionLines(`${ESC}[31monf`));
  });

  it("removes the two separator controls from text, so nothing a pane prints can forge a tag", () => {
    const forged = styledRegionLines(`a${US}fg=red${US}b`);
    expect(forged).toEqual([run("-", "afg=redb")]);
    expect(forged[0]!.split(US)).toHaveLength(3);
  });

  it("is deterministic over the same bytes", () => {
    const text = `${ESC}[1mA${ESC}[0m\n${ESC}[3mB`;
    expect(styledRegionLines(text)).toEqual(styledRegionLines(text));
  });
});

describe("canonicalStyledLines: the phone's call over spans equals the bridge's call over text", () => {
  const PANES = join(import.meta.dirname, "..", "fixtures", "panes");

  it("agree on every line of real captures (the same function, two entry points)", () => {
    for (const name of ["oc--permission-bash.txt", "oc--permission-bash--moved.txt", "claude--menu-resume-picker--w120-first.txt"]) {
      const raw = readFileSync(join(PANES, name), "utf8");
      const lines = splitLines(parseAnsi(raw));
      expect(canonicalStyledLines(lines), name).toEqual(styledRegionLines(raw));
    }
  });

  it("a region of the lines is a contiguous run of the whole screen's lines", () => {
    const raw = readFileSync(join(PANES, "oc--permission-bash.txt"), "utf8");
    const lines = splitLines(parseAnsi(raw));
    const whole = canonicalStyledLines(lines).join("\n");
    const region = canonicalStyledLines(lines.slice(-12)).join("\n");
    expect(whole.endsWith(region)).toBe(true);
  });

  it("the style-only pointer is the one thing that differs between two real opencode captures", () => {
    const once = styledRegionLines(readFileSync(join(PANES, "oc--permission-bash.txt"), "utf8"));
    const always = styledRegionLines(readFileSync(join(PANES, "oc--permission-bash--moved.txt"), "utf8"));
    expect(once.length).toBe(always.length);
    const differing = once.flatMap((line, i) => (line === always[i] ? [] : [i]));
    expect(differing).toHaveLength(1);
  });
});

describe("the wire value", () => {
  it("is the format line, then the canonical lines, joined by a newline", () => {
    const lines = styledRegionLines(`${ESC}[31mone${ESC}[0m\ntwo`);
    expect(STYLED_FORMAT).toBe("v1");
    expect(encodeStyledRegion(lines)).toBe(`v1\n${lines.join("\n")}`);
  });

  it("decodes back to its version and lines, without judging the version", () => {
    const lines = styledRegionLines(`${ESC}[31mone${ESC}[0m\ntwo`);
    expect(decodeStyledRegion(encodeStyledRegion(lines))).toEqual({ version: "v1", lines });
    expect(decodeStyledRegion(`v7\nx\ny`)).toEqual({ version: "v7", lines: ["x", "y"] });
    expect(decodeStyledRegion("v1")).toEqual({ version: "v1", lines: [] });
    expect(decodeStyledRegion("")).toBeNull();
  });
});
