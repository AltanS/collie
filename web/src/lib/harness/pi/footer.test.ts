import { describe, expect, it } from "vitest";
import { keyHintPairs, parsePiFooter } from "./footer";

describe("parsePiFooter: the footers the corpus prints", () => {
  it.each([
    // [footer, arrowsMove, enter, digitsSelect, spaceToggles, escapeVerb, tabs]
    ["↑↓ navigate • Enter to select • Esc to cancel", true, "select", false, false, "cancel", false],
    ["↑↓ navigate • Enter select • Esc cancel", true, "select", false, false, "cancel", false],
    ["Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel", true, "select", false, false, "cancel", true],
    ["Enter to submit • Esc to go back", false, "submit", false, false, "go back", false],
    ["Enter to submit • Esc to cancel", false, "submit", false, false, "cancel", false],
    [
      "↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel",
      true, "select", false, false, "cancel", false,
    ],
    [
      "↑↓ navigate • Space to tick • Enter to confirm • type numbers (1,3) or an answer • Esc to cancel",
      true, "select", false, true, "cancel", false,
    ],
    ["←→ tabs • ↑↓ navigate • Enter select • type a number or text • Esc cancel", true, "select", false, false, "cancel", true],
    ["←→ tabs • Enter submit • Esc cancel", false, "submit", false, false, "cancel", true],
    ["←→ tabs • Enter goes to the first unanswered • Esc cancel", false, "other", false, false, "cancel", true],
    [
      "↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel",
      true, "other", true, false, "cancel", false,
    ],
    [
      "↑↓ move  1-9 select  space toggle  enter toggle  tab next question  c comment  esc cancel",
      true, "other", true, true, "cancel", false,
    ],
    ["↑↓ choose · Enter confirm · Esc cancel · D details", true, "select", false, false, "cancel", false],
    ["Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel", false, "select", false, false, "cancel", false],
  ] as const)("%s", (text, arrowsMove, enter, digitsSelect, spaceToggles, escapeVerb, tabs) => {
    expect(parsePiFooter(text)).toEqual({ text, arrowsMove, enter, digitsSelect, spaceToggles, escapeVerb, tabs });
  });
});

describe("parsePiFooter: what is not a footer", () => {
  it.each([
    ["one hint alone", "Esc to cancel"],
    ["a status line", "~/projects/pi-demo (main)"],
    ["a countdown", "Ask user · 30m"],
    ["a counter", "Submit (0/1 answered) — Enter advances"],
    ["an unknown key", "↑↓ navigate • F5 to refresh • Esc to cancel"],
    ["a sentence", "Pick a color for the Collie probe?"],
    ["an empty row", ""],
    ["a key torn from its verb", "↑↓ navigate • Enter to select • Esc • to cancel"],
  ])("declines %s", (_name, text) => {
    expect(parsePiFooter(text)).toBeNull();
  });

  it("gives a key no role for a verb it does not know", () => {
    expect(parsePiFooter("↑↓ scroll • Enter to select • Esc to cancel")?.arrowsMove).toBe(false);
    expect(parsePiFooter("↑↓ navigate • 1-9 jump • Esc to cancel")?.digitsSelect).toBe(false);
    expect(parsePiFooter("↑↓ navigate • Space to preview • Esc to cancel")?.spaceToggles).toBe(false);
  });

  it("keeps the stricter reading when Enter is named twice with two roles", () => {
    expect(parsePiFooter("Enter to select • enter next • Esc to cancel")?.enter).toBe("other");
    expect(parsePiFooter("Enter to select • Enter confirm • Esc to cancel")?.enter).toBe("select");
  });

  it("does not take typed digits for a digit plan", () => {
    expect(parsePiFooter("↑↓ navigate • type a number • Esc to cancel")?.digitsSelect).toBe(false);
  });
});

// A picker's key-hint row (.adr/0098, "Pickers"): the rows the lab captures print, 2026-10-12.
describe("keyHintPairs: the pickers' hint rows", () => {
  it.each([
    ["enter select ctrl+s select as default ctrl+f favorite", 3], // OmO /model, single spaces
    ["↑/↓ move · ←/→ page · ctrl+←/→ branch · ctrl+x copy · ctrl+e edit · shift+l label · shift+t label time", 7], // /tree
    ["ctrl+s sort · ctrl+n named · ctrl+d delete · ctrl+p path (off) · ctrl+r rename", 5], // /resume
    ["Enter to select · Ctrl+S to set as default · Escape/Ctrl+C to cancel", 3], // stock /model
    ["↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel", 7], // OmO ask
    ["↑↓ navigate • Enter to select • Esc to cancel", 3], // stock question
    // `to` wording joined by a separator: each segment is `<key> to <action>`, two pairs.
    ["enter to confirm · esc to cancel", 2],
    // Single spaces: a chord always starts a pair, and a named key right after a key is its action.
    ["enter select ctrl+d delete ctrl+r rename", 3],
    ["ctrl+s sort ctrl+n named ctrl+d delete ctrl+p path (off) ctrl+r rename", 5],
    ["↑/↓ move ←/→ page enter select", 3],
    ["alt+x end shift+tab back", 2],
    ["super+x home ctrl+e end", 2],
  ])("%s → %i pairs", (text, pairs) => {
    expect(keyHintPairs(text)).toBe(pairs);
  });

  it.each([
    ["the other /resume row, with a pattern and a phrase", 'tab scope · re:<pattern> regex · "phrase" exact'],
    ["the /tree filter row, action first", "filters ctrl+d/t/u/l/a · cycle ctrl+o/shift+ctrl+o"],
    ["OmO's question banner", "enter or alt+up to answer · /answer · or just type your reply"],
    ["the banner's mouse row", "click an option · shift+drag to select text"],
    ["a status row", "↑4.9k ↓62 $0.005 1.2%/200k (auto)                anthropic/claude-haiku-4.5 • thinking off"],
    ["one pair", "enter select"],
    ["single spaces with no chord or arrow", "enter select tab next"],
    ["prose that names keys", "press enter to select it then ctrl+s to save"],
    ["a key with no action", "enter ctrl+s save"],
    ["a chord with no action before the next chord", "ctrl+d ctrl+r rename"],
    ["a chord at the end with no action", "enter select ctrl+d"],
    // `to` wording with single spaces is two pairs (`enter` [to confirm], `esc` [to cancel]), but
    // with no chord or arrow it is not a hint row: plain words could spell it.
    ["the `to` form with single spaces", "enter to confirm esc to cancel"],
    ["a sentence", "Pick a color for the Collie probe?"],
    ["an empty row", ""],
  ])("declines %s", (_name, text) => {
    expect(keyHintPairs(text)).toBe(0);
  });
});
