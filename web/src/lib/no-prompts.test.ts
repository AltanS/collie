import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetNoPromptsConfirms,
  MAX_NO_PROMPTS_CONFIRMS,
  NO_PROMPTS_KEY,
  needsNoPromptsConfirm,
  noPromptsConfirmed,
  rememberNoPromptsConfirm,
  visibleLine,
} from "./no-prompts";

// The per-device half of the No prompts guards (ADR 0094): one confirm per device, per machine, per
// exact line, and the line shown with every character that hides itself written as its code.

beforeEach(() => localStorage.clear());

describe("one confirm per device", () => {
  const danger = { noPrompts: true, command: "claude --dangerously-skip-permissions" };

  it("asks for a no-prompts line until this device confirmed it on that machine", () => {
    expect(needsNoPromptsConfirm(danger, "")).toBe(true);
    rememberNoPromptsConfirm("", danger.command, 1);
    expect(needsNoPromptsConfirm(danger, "")).toBe(false);
    // Another machine, or another line, asks again.
    expect(needsNoPromptsConfirm(danger, "minibuch")).toBe(true);
    expect(needsNoPromptsConfirm({ noPrompts: true, command: "codex --yolo" }, "")).toBe(true);
  });

  it("never asks for a line that prompts; always asks for one it cannot key", () => {
    expect(needsNoPromptsConfirm({ noPrompts: false, command: "htop" }, "")).toBe(false);
    expect(needsNoPromptsConfirm({ command: "htop" }, "")).toBe(false);
    expect(needsNoPromptsConfirm({ noPrompts: true }, "")).toBe(true);
  });

  it("a garbled store reads as nothing confirmed, and the store is capped oldest first", () => {
    localStorage.setItem(NO_PROMPTS_KEY, "{not json");
    expect(noPromptsConfirmed("", danger.command)).toBe(false);
    for (let i = 0; i < MAX_NO_PROMPTS_CONFIRMS + 5; i++) rememberNoPromptsConfirm("", `line ${i}`, i);
    expect(Object.keys(JSON.parse(localStorage.getItem(NO_PROMPTS_KEY) ?? "{}"))).toHaveLength(MAX_NO_PROMPTS_CONFIRMS);
    expect(noPromptsConfirmed("", "line 0")).toBe(false);
    expect(noPromptsConfirmed("", `line ${MAX_NO_PROMPTS_CONFIRMS + 4}`)).toBe(true);
  });

  it("is forgotten with the pairing", () => {
    rememberNoPromptsConfirm("", danger.command, 1);
    forgetNoPromptsConfirms();
    expect(needsNoPromptsConfirm(danger, "")).toBe(true);
  });

  it("a storage that refuses keeps nothing, so the next start asks again", () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    rememberNoPromptsConfirm("", danger.command, 1, refusing);
    expect(needsNoPromptsConfirm(danger, "", refusing)).toBe(true);
  });
});

describe("visibleLine", () => {
  it("leaves a plain line alone", () => {
    expect(visibleLine("claude --model opus")).toEqual({ text: "claude --model opus", hidden: 0, nonAscii: false });
  });

  it("writes characters that hide themselves as their code", () => {
    expect(visibleLine(`rm${String.fromCodePoint(0x200b)} -rf`)).toEqual({ text: "rm⟨U+200B⟩ -rf", hidden: 1, nonAscii: true });
    expect(visibleLine(`a${String.fromCodePoint(0xa0)}b`).text).toBe("a⟨U+00A0⟩b");
    expect(visibleLine(`x${String.fromCodePoint(0xfeff)}`).hidden).toBe(1);
  });

  it("marks a look-alike letter as outside ASCII without hiding it", () => {
    expect(visibleLine(`cl${String.fromCodePoint(0x0430)}ude`)).toEqual({ text: `cl${String.fromCodePoint(0x0430)}ude`, hidden: 0, nonAscii: true });
  });
});
