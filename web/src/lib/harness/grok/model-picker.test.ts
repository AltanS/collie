import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { grokAdapter } from "../grok";
import { promptsEqual, promptsSameIdentity } from "../prompt-model";

const PANES = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const captured = (name: string) => readFileSync(join(PANES, name), "utf8");

function picker(text: string) {
  const block = grokAdapter.buildBlocks(splitLines(parseAnsi(text)))
    .find((candidate) => candidate.kind === "prompt-select");
  expect(block, "the captured picker must have native options").toBeDefined();
  if (block?.kind !== "prompt-select") throw new Error("no picker");
  return block.prompt;
}

const stages = [
  {
    name: "model",
    current: "grok--model-picker.txt",
    moved: "grok--model-picker-moved.txt",
    pointed: 0,
    next: 1,
    labels: ["Grok 4.7 (current)", "Grok 4.7 Fast", "Grok 4.6", "Grok 4.5"],
  },
  {
    name: "window",
    current: "grok--model-window.txt",
    moved: "grok--model-window-moved.txt",
    pointed: 0,
    next: 1,
    labels: ["256k (active)", "500k"],
  },
  {
    name: "effort",
    current: "grok--model-effort.txt",
    moved: "grok--model-effort-moved.txt",
    pointed: 1,
    next: 2,
    labels: ["Extra High", "High (active)", "Medium", "Low"],
  },
];

describe("Grok's /model picker through its public adapter", () => {
  it.each(stages)("offers the captured $name choices without inventing digits", (stage) => {
    const text = captured(stage.current);
    const model = picker(text);
    expect(model.caption).toBe("/model");
    expect(model.options.slice(0, -1).map((option) => option.label)).toEqual(stage.labels);
    expect(model.options[stage.pointed]!.keys).toEqual(["Enter"]);
    expect(model.options[stage.next]!.keys).toEqual(["Down", "Enter"]);
    expect(model.options.at(-1)).toMatchObject({ label: "Ctrl+C", keys: ["ctrl+c"] });
    expect(grokAdapter.composerReady!(splitLines(parseAnsi(text)))).toBe(false);
  });

  it.each(stages)("keeps $name identity across the real arrow walk, but refuses a stale tap", (stage) => {
    const before = picker(captured(stage.current));
    const moved = picker(captured(stage.moved));
    expect(promptsSameIdentity(before, moved)).toBe(true);
    expect(promptsSameIdentity(moved, before)).toBe(true);
    expect(promptsEqual(before, moved)).toBe(false);
    expect(moved.options[stage.next]!.keys).toEqual(["Enter"]);
  });

  it("keeps changed model text and descriptions in identity", () => {
    const text = captured("grok--model-picker.txt");
    const original = picker(text);
    expect(promptsSameIdentity(original, picker(text.replace("Grok 4.6", "Grok 4.8")))).toBe(false);
    expect(promptsSameIdentity(original, picker(text.replace("2x the price.", "3x the price.")))).toBe(false);
  });

  it.each([
    ["another command", (text: string) => text.replace("/model", "/work")],
    ["a missing pointer", (text: string) => text.replace("❯ Grok", "  Grok")],
    ["a changed Enter hint", (text: string) => text.replace("Enter", "Space")],
    ["later output", (text: string) => `${text}\nA newer turn has begun.`],
  ] as const)("does not lift %s", (_name, change) => {
    const blocks = grokAdapter.buildBlocks(splitLines(parseAnsi(change(captured("grok--model-picker.txt")))));
    expect(blocks.some((block) => block.kind === "prompt-select")).toBe(false);
  });
});
