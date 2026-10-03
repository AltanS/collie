import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { promptsEqual, promptsSameIdentity, sameKeys } from "../prompt-model";
import { ompAdapter, ompBuildBlocks } from "./index";
import { ompModalOnScreen } from "./modal";
import { detectSwitchPicker, detectSwitchPickerRegion } from "./switch";

// omp's compact model picker (`/switch`, Alt+P; .adr/0079). A tap here changes the model the live
// session runs, so these tests pin three things above all: that every option's label is the whole id
// of a row omp printed in full, that every tap is an arrow walk the footer printed and lands on that
// row (counted independently below, from the screen), and that the grammar declines every shape it was
// not built against. All captures are omp 18.4.10, `unicode` preset, `omp--v18-4-switch*.txt`.
//
// The CURRENT model (`●`) is never offered: Enter on it re-applies the model, resets omp's provider
// session and loses the prompt cache. It still counts in every other row's walk, and its id is the
// last line of the card's accessible name (`● current: <id>`). The way out carries the footer's own
// `type to search` as its description. A screen whose only offerable row was the current model
// declines, because the grammar still requires one offered model row (see "fails closed").

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

const load = (name: string): StyledLine[] =>
  splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
const textsOf = (name: string): string[] => load(name).map(lineText);
const fromTexts = (texts: string[]): StyledLine[] => splitLines(parseAnsi(texts.join("\n")));

const FOOTER = "↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close · Alt+P task model";

const LIFTED = [
  "omp--v18-4-switch-moved-up.txt",
  "omp--v18-4-switch-moved.txt",
  "omp--v18-4-switch-narrow-moved.txt",
  "omp--v18-4-switch-narrow.txt",
  "omp--v18-4-switch-overcontext-moved.txt",
  "omp--v18-4-switch-overcontext.txt",
  "omp--v18-4-switch-ptr-fable.txt",
  "omp--v18-4-switch-ptr-haiku.txt",
  "omp--v18-4-switch-ptr-opus-current.txt",
  "omp--v18-4-switch-ptr-sonnet.txt",
  "omp--v18-4-switch-roles-chips.txt",
  "omp--v18-4-switch-search-short-moved.txt",
  "omp--v18-4-switch-search-short.txt",
  "omp--v18-4-switch-search-son.txt",
  "omp--v18-4-switch-search.txt",
  "omp--v18-4-switch-short-pane-scrolled.txt",
  "omp--v18-4-switch-short-pane.txt",
  "omp--v18-4-switch-top-edge.txt",
  "omp--v18-4-switch-top.txt",
  "omp--v18-4-switch-truncated-pointed.txt",
  "omp--v18-4-switch-truncated.txt",
  "omp--v18-4-switch-wrapped.txt",
  "omp--v18-4-switch.txt",
];

// Rows of the 219-column captures (title through bottom border), and of the 30-row short pane.
const TITLE_AT = 38;
const WINDOW_AT = 42;
const FACTS_AT = 59;
const CHIPS_AT = 60;
const FOOTER_AT = 61;
const SHORT_TITLE_AT = 16;

/** The current model's id as the screen prints it (`<id> ●`), or null when no row carries the mark. */
const currentOnScreen = (texts: string[]): string | null =>
  texts.map((t) => /^│ [❯ ] (\S+\/\S+) ●/u.exec(t)?.[1]).find((id) => id !== undefined) ?? null;

const CLOSE = { label: "Close", description: "type to search", keys: ["Escape"], keyLabel: "Esc" };
const CLEAR_SEARCH = { ...CLOSE, label: "Clear search" };

/** The text typed in the search row as the screen prints it (`🔍 > <text>`), empty when none is. */
const searchOnScreen = (texts: string[]): string =>
  texts.map((t) => /^│ {2}🔍 >(?: (.*?))?\s*│$/u.exec(t)).find((m) => m !== null && m !== undefined)?.[1]?.trim() ?? "";

/** The last row each capture should end in: `Clear search` while omp holds a typed search, else `Close`. */
const wayOut = (name: string) => (searchOnScreen(textsOf(name)) === "" ? CLOSE : CLEAR_SEARCH);

const labels = (name: string): string[] => detectSwitchPicker(load(name))!.options.map((o) => o.label);

describe("the session picker lifts as its visible window plus Close", () => {
  it("switch: the pointer on the current model, below the recents and the rule", () => {
    const model = detectSwitchPicker(load("omp--v18-4-switch.txt"))!;
    expect(model.family).toBe("select");
    expect(model.caption).toBe("Switch Model");
    // The current model is named on the card's last line of the accessible name, not offered.
    expect(model.question).toBe(
      "Switch Model\nSession-only switch — role models stay unchanged\n🔍 >\n● current: anthropic/claude-opus-5-5",
    );
    // Sixteen window rows: three recents, the rule, twelve models. The rule is not an option, and
    // neither is the current model, so fourteen models and Close.
    expect(model.options).toHaveLength(15);
    expect(model.options.map((o) => o.label)).not.toContain("anthropic/claude-opus-5-5");
    // The pointer is on the current model, which is not offered, so no option carries the pointer badge.
    expect(model.options.some((o) => o.keyLabel === "❯")).toBe(false);
    expect(model.options.slice(0, 4)).toEqual([
      {
        label: "openrouter/google/gemini-3.8-flash",
        description: "🧠 59 · ~327t/s · 1m ◫ · $0.75/3.75",
        keys: ["Up", "Up", "Up", "Enter"],
        keyLabel: "",
      },
      { label: "openai/gpt-5.6-sol", description: "🧠 47 · ~90t/s · 272k ◫ · $4/20", keys: ["Up", "Up", "Enter"], keyLabel: "" },
      { label: "anthropic/claude-sonnet-5-5", description: "🧠 56 · ~139t/s · 1m ◫ · $2/10", keys: ["Up", "Enter"], keyLabel: "" },
      { label: "anthropic/claude-fable-5-1", description: "🧠 53 · ~68t/s · 1m ◫ · $10/50", keys: ["Down", "Enter"], keyLabel: "" },
    ]);
    // A row with no badge omp could measure keeps the ones it printed.
    expect(model.options[4]).toMatchObject({ label: "anthropic/claude-mythos-5-1", description: "1m ◫ · $10/50" });
    // No description starts with the current mark any more.
    expect(model.options.some((o) => o.description?.startsWith("● current"))).toBe(false);
    expect(model.options.at(-1)).toEqual(CLOSE);
  });

  it("moved: the pointer one row down; the current model is one Up away, named and not offered, and still counted", () => {
    const model = detectSwitchPicker(load("omp--v18-4-switch-moved.txt"))!;
    const options = model.options;
    expect(options.map((o) => o.label)).not.toContain("anthropic/claude-opus-5-5");
    expect(model.question.split("\n").at(-1)).toBe("● current: anthropic/claude-opus-5-5");
    expect(options.find((o) => o.keyLabel === "❯")!.label).toBe("anthropic/claude-fable-5-1");
    // The row above the current model is two Ups from the pointer: the current row is stepped on.
    expect(options.find((o) => o.label === "anthropic/claude-sonnet-5-5")!.keys).toEqual(["Up", "Up", "Enter"]);
  });

  it("moved-up: Up stepped over the rule, so the walk counts models, not screen rows", () => {
    const texts = textsOf("omp--v18-4-switch-moved-up.txt");
    // The rule sits between the pointed sonnet and the current opus on screen...
    expect(texts[WINDOW_AT + 2]).toContain("❯ anthropic/claude-sonnet-5-5");
    expect(texts[WINDOW_AT + 3]).toMatch(/^│ {3}─+/);
    expect(texts[WINDOW_AT + 4]).toContain("anthropic/claude-opus-5-5 ●");
    // ...and one Down reaches opus, because omp's Down skips the disabled rule. Opus is the current
    // model, so it is not offered, but the next row, fable, is two Downs away: the walk counts opus.
    const model = detectSwitchPicker(load("omp--v18-4-switch-moved-up.txt"))!;
    expect(model.options.map((o) => o.label)).not.toContain("anthropic/claude-opus-5-5");
    expect(model.question.split("\n").at(-1)).toBe("● current: anthropic/claude-opus-5-5");
    expect(model.options.find((o) => o.label === "anthropic/claude-fable-5-1")!.keys).toEqual([
      "Down",
      "Down",
      "Enter",
    ]);
  });

  it("wrapped: Up at the top wrapped to the last model; every walk stays inside the window", () => {
    const model = detectSwitchPicker(load("omp--v18-4-switch-wrapped.txt"))!;
    const models = model.options.slice(0, -1);
    expect(models).toHaveLength(16);
    expect(models.at(-1)).toMatchObject({ label: "openrouter/xiaomi/mimo-v2.6-pro-ultraspeed", keyLabel: "❯" });
    // The pointer is at the window's bottom edge, so every walk is Up, at most fifteen of them.
    for (const o of models.slice(0, -1)) expect(new Set(o.keys.slice(0, -1))).toEqual(new Set(["Up"]));
    expect(models[0]!.keys).toHaveLength(16);
  });

  it("top-edge: the pointer at the window's top edge, every walk Down", () => {
    const models = detectSwitchPicker(load("omp--v18-4-switch-top-edge.txt"))!.options.slice(0, -1);
    expect(models[0]).toMatchObject({ label: "openrouter/thinkingmachines/inkling-small:free", keyLabel: "❯" });
    expect(models[0]!.description).toBe("1m ◫ · free");
    for (const o of models.slice(1)) expect(new Set(o.keys.slice(0, -1))).toEqual(new Set(["Down"]));
  });

  it("search-short: a list shorter than the window, padded with blank rows and no scrollbar", () => {
    const model = detectSwitchPicker(load("omp--v18-4-switch-search-short.txt"))!;
    expect(model.question.split("\n")[2]).toBe("🔍 > opus-5");
    expect(model.question.split("\n")[3]).toBe("● current: anthropic/claude-opus-5-5");
    // Thirteen results, the pointed one the current model (not offered), and Close.
    expect(model.options).toHaveLength(13);
    expect(model.options[0]).toMatchObject({ label: "anthropic/claude-opus-5", keyLabel: "", keys: ["Down", "Enter"] });
    // Ids carry dots and colons; the label is the id whole.
    expect(labels("omp--v18-4-switch-search-short.txt")).toContain("openrouter/anthropic/claude-opus-5.5:batch");
  });

  it("short-pane: a window of five, omp's floor, with the rule as its last row", () => {
    const region = detectSwitchPickerRegion(load("omp--v18-4-switch-short-pane.txt"))!;
    expect(region.startLine).toBe(SHORT_TITLE_AT + 4);
    // The pointed row is the current model: counted for every walk, not offered.
    expect(region.model.options.map((o) => o.label)).toEqual([
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-fable-5-1",
      "anthropic/claude-sonnet-5-5",
      "Close",
    ]);
    const scrolled = detectSwitchPicker(load("omp--v18-4-switch-short-pane-scrolled.txt"))!;
    expect(scrolled.options.find((o) => o.keyLabel === "❯")!.label).toBe("anthropic/claude-mythos-5-1");
  });

  it("roles-chips and narrow: the role chips under the facts read, and the current model is named, not offered", () => {
    const chips = detectSwitchPicker(load("omp--v18-4-switch-roles-chips.txt"))!;
    expect(textsOf("omp--v18-4-switch-roles-chips.txt")[CHIPS_AT]).toContain("● slow ◒ · ○ advisor ◒");
    expect(chips.options.find((o) => o.keyLabel === "❯")!.label).toBe("anthropic/claude-fable-5-1");
    expect(chips.options.filter((o) => o.description?.startsWith("●"))).toHaveLength(0);
    expect(chips.question.split("\n").at(-1)).toBe("● current: anthropic/claude-opus-5-5");
    const narrow = detectSwitchPicker(load("omp--v18-4-switch-narrow.txt"))!;
    // The pointer is on the current model: not offered, so the first option is the row below it.
    expect(narrow.options[0]).toMatchObject({ label: "anthropic/claude-haiku-4-5", keyLabel: "", keys: ["Down", "Enter"] });
    expect(narrow.options.map((o) => o.label)).not.toContain("anthropic/claude-opus-5-5");
    expect(narrow.question.split("\n").at(-1)).toBe("● current: anthropic/claude-opus-5-5");
  });
});

describe("rows the card does not offer, and still counts", () => {
  it("overcontext: an over-context row compacts before it switches, so it is never an option", () => {
    const texts = textsOf("omp--v18-4-switch-overcontext.txt");
    expect(texts[WINDOW_AT]).toContain("❯ openai/gpt-4 ⦸ context>8.2k");
    expect(texts[CHIPS_AT]).toContain("⦸ context 11k exceeds 8.2k limit");
    const model = detectSwitchPicker(load("omp--v18-4-switch-overcontext.txt"))!;
    // The pointed row is not offered, so no option carries the pointer badge.
    expect(model.options.some((o) => o.keyLabel === "❯")).toBe(false);
    expect(model.options.map((o) => o.label)).not.toContain("openai/gpt-4");
    // gpt-4.1 is the next model row, one Down away.
    expect(model.options[0]).toMatchObject({ label: "openai/gpt-4.1", keys: ["Down", "Enter"] });
  });

  it("overcontext-moved: every over-context row in the window is left out, the walks count them", () => {
    const texts = textsOf("omp--v18-4-switch-overcontext-moved.txt");
    const over = texts
      .slice(WINDOW_AT, FACTS_AT - 1)
      .map((t) => /^│ [❯ ] (\S+) ⦸ context>/u.exec(t)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(over.length).toBeGreaterThan(1);
    const offered = labels("omp--v18-4-switch-overcontext-moved.txt");
    for (const id of over) expect(offered).not.toContain(id);
  });

  it("truncated: a row omp shortened with `…` has no whole id on screen, so it is never an option", () => {
    const texts = textsOf("omp--v18-4-switch-truncated.txt");
    const clipped = texts.filter((t) => /^│ {3}openrouter\/nvidia\/\S+ ⦸ contex\S*…/u.test(t));
    expect(clipped).toHaveLength(2);
    const offered = labels("omp--v18-4-switch-truncated.txt");
    for (const label of offered) expect(label).not.toContain("…");
    expect(offered).not.toContain("openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.5");
    // Three over-context rows, then the first row the card offers: three Downs from the pointer.
    expect(detectSwitchPicker(load("omp--v18-4-switch-truncated.txt"))!.options[0]).toMatchObject({
      label: "openrouter/nvidia/nemotron-3.5-lightning",
      keys: ["Down", "Down", "Down", "Enter"],
    });
  });

  it("truncated-pointed: the pointer on a shortened row; the rows around it walk from there", () => {
    const options = detectSwitchPicker(load("omp--v18-4-switch-truncated-pointed.txt"))!.options;
    expect(options.some((o) => o.keyLabel === "❯")).toBe(false);
    expect(options.find((o) => o.label === "openrouter/nvidia/nemotron-3.5-lightning:free")!.keys).toEqual([
      "Up",
      "Enter",
    ]);
    expect(options.find((o) => o.label === "openrouter/nvidia/nemotron-3-nano-30b-a3b")!.keys).toEqual([
      "Down",
      "Down",
      "Enter",
    ]);
  });
});

/** The window's model rows, read straight off the screen and independently of the grammar: every
 *  boxed row between the search spacer and the facts spacer that starts with the pointer column and a
 *  token, the rule and the blank padding aside. */
function screenModels(texts: string[]): { id: string; pointed: boolean }[] {
  const title = texts.findIndex((t) => t.startsWith("╭─ Switch Model ─"));
  const bottom = texts.findLastIndex((t) => t.startsWith("╰─"));
  return texts
    .slice(title + 4, bottom - 4)
    .map((t) => /^│ ([❯ ]) (\S+)/u.exec(t))
    .filter((m): m is RegExpExecArray => m !== null && !m[2]!.startsWith("─"))
    .map((m) => ({ id: m[2]!, pointed: m[1] === "❯" }));
}

describe("a pointer on an edge of the window walks to the other edge over model rows, the rule skipped", () => {
  const base = textsOf("omp--v18-4-switch.txt");
  const LAST_AT = WINDOW_AT + 15;
  /** The capture with the pointer moved to `row`. The chips row goes blank: the pointed row is no
   *  longer the current model, and omp prints no chip for it. */
  const pointAt = (row: number): string[] =>
    base.map((t, i) => {
      if (i === WINDOW_AT + 4) return t.replace("❯", " ");
      if (i === row) return t.replace("│   ", "│ ❯ ");
      return i === CHIPS_AT ? t.replace("● current", "         ") : t;
    });

  it("positive control: the capture's rule is between the recents and the rest", () => {
    expect(base[WINDOW_AT + 3]).toMatch(/^│ {3}─+/);
    expect(screenModels(base)).toHaveLength(15);
    expect(base[LAST_AT]).toContain("anthropic/claude-opus-4-5-20251101");
  });

  it("the first row pointed: the last row is Down once per model row, not per screen row", () => {
    const texts = pointAt(WINDOW_AT);
    const rows = screenModels(texts);
    expect(rows[0]!.pointed).toBe(true);
    const model = detectSwitchPicker(fromTexts(texts))!;
    const last = model.options.find((o) => o.label === rows.at(-1)!.id)!;
    // Fifteen model rows and a rule: fourteen steps, though the last row is fifteen screen rows below.
    expect(last.keys).toEqual([...Array.from({ length: 14 }, () => "Down"), "Enter"]);
    // Every other walk is Down x its index over model rows: the rule never counts, and the current
    // model (the fourth model row) is counted though it is not offered.
    for (const option of model.options.slice(0, -1)) {
      const at = rows.findIndex((r) => r.id === option.label);
      expect(option.keys).toEqual([...Array.from({ length: at }, () => "Down"), "Enter"]);
    }
    expect(model.options.find((o) => o.label === "anthropic/claude-fable-5-1")!.keys).toEqual([
      "Down",
      "Down",
      "Down",
      "Down",
      "Enter",
    ]);
    expect(model.options.map((o) => o.label)).not.toContain("anthropic/claude-opus-5-5");
  });

  it("the last row pointed: the first row is Up once per model row", () => {
    const texts = pointAt(LAST_AT);
    const rows = screenModels(texts);
    expect(rows.at(-1)!.pointed).toBe(true);
    const model = detectSwitchPicker(fromTexts(texts))!;
    const first = model.options.find((o) => o.label === rows[0]!.id)!;
    expect(first.keys).toEqual([...Array.from({ length: 14 }, () => "Up"), "Enter"]);
    for (const option of model.options.slice(0, -1)) {
      const at = rows.findIndex((r) => r.id === option.label);
      const steps = rows.length - 1 - at;
      expect(option.keys).toEqual([...Array.from({ length: steps }, () => "Up"), "Enter"]);
    }
    // sonnet-5-5 is the last recent, above the rule: twelve model rows up, thirteen screen rows.
    expect(model.options.find((o) => o.label === "anthropic/claude-sonnet-5-5")!.keys).toHaveLength(13);
  });

  it("the captured edges agree: top-edge walks Down and wrapped walks Up, to every other row", () => {
    const edge = (name: string, key: string, from: "first" | "last") => {
      const model = detectSwitchPicker(load(name))!;
      const rows = screenModels(textsOf(name));
      for (const option of model.options.slice(0, -1)) {
        const at = rows.findIndex((r) => r.id === option.label);
        const steps = from === "first" ? at : rows.length - 1 - at;
        expect(option.keys).toEqual([...Array.from({ length: steps }, () => key), "Enter"]);
      }
    };
    edge("omp--v18-4-switch-top-edge.txt", "Down", "first");
    edge("omp--v18-4-switch-wrapped.txt", "Up", "last");
    // And the first capture with a rule: the pointer on the first recent, the rule below the third.
    edge("omp--v18-4-switch-top.txt", "Down", "first");
  });
});

describe("an over-context row between the pointer and a target counts in the walk and is not offered", () => {
  it("overcontext-moved: two over-context rows sit between the pointer and the target", () => {
    const name = "omp--v18-4-switch-overcontext-moved.txt";
    const texts = textsOf(name);
    expect(texts[WINDOW_AT + 1]).toContain("❯ openai/gpt-4.1");
    expect(texts[WINDOW_AT + 11]).toContain("openrouter/openai/gpt-4 ⦸ context>8.2k");
    expect(texts[WINDOW_AT + 12]).toContain("openrouter/openai/gpt-4-0314 ⦸ context>8.2k");
    const options = detectSwitchPicker(load(name))!.options;
    // gpt-4-1106-preview is the row right after both: twelve rows below the pointer, no rule between.
    // Skipping the two over-context rows would make it ten.
    const target = options.find((o) => o.label === "openrouter/openai/gpt-4-1106-preview")!;
    expect(target.keys).toEqual([...Array.from({ length: 12 }, () => "Down"), "Enter"]);
    expect(options.find((o) => o.label === "openrouter/openai/gpt-4-turbo")!.keys).toHaveLength(14);
    const labelsOffered = options.map((o) => o.label);
    for (const id of ["openai/gpt-4", "openrouter/openai/gpt-4", "openrouter/openai/gpt-4-0314"]) {
      expect(labelsOffered).not.toContain(id);
    }
  });

  it("overcontext: the pointer on an over-context row; every walk counts the others from there", () => {
    const name = "omp--v18-4-switch-overcontext.txt";
    const options = detectSwitchPicker(load(name))!.options;
    const target = options.find((o) => o.label === "openrouter/openai/gpt-4-turbo-preview")!;
    // Sixteen model rows, the pointer on the first: the last is fifteen Downs, over-context rows included.
    expect(target.keys).toEqual([...Array.from({ length: 15 }, () => "Down"), "Enter"]);
    expect(options.find((o) => o.label === "openrouter/openai/gpt-4-1106-preview")!.keys).toHaveLength(14);
  });
});

describe("the current model is named on the card and is not an option", () => {
  it("its full id is the last line of the question, and no option carries it", () => {
    for (const name of LIFTED) {
      const texts = textsOf(name);
      const current = currentOnScreen(texts);
      const model = detectSwitchPicker(load(name))!;
      if (current === null) {
        expect(model.question.split("\n")).toHaveLength(3);
        continue;
      }
      expect(model.question.split("\n").at(-1)).toBe(`● current: ${current}`);
      expect(model.question.split("\n")).toHaveLength(4);
      expect(model.options.map((o) => o.label)).not.toContain(current);
    }
  });

  it("a capture with the mark scrolled out of the window names no current model", () => {
    const model = detectSwitchPicker(load("omp--v18-4-switch-top-edge.txt"))!;
    expect(model.question).toBe("Switch Model\nSession-only switch — role models stay unchanged\n🔍 >");
  });

  it("the current model's own walk is still counted: the rows around it step on it", () => {
    const model = detectSwitchPicker(load("omp--v18-4-switch-roles-chips.txt"))!;
    // Pointer on fable (third row); the current opus is the first row, two Ups away and not offered;
    // haiku is one Up. The recents above the rule are walked over the same model rows.
    expect(model.options.find((o) => o.label === "anthropic/claude-haiku-4-5")!.keys).toEqual(["Up", "Enter"]);
    expect(model.options.map((o) => o.label)).not.toContain("anthropic/claude-opus-5-5");
    expect(model.options.find((o) => o.label === "anthropic/claude-mythos-5-1")!.keys).toEqual([
      "Down",
      "Down",
      "Enter",
    ]);
  });
});

describe("the way out carries the footer's own segment", () => {
  it.each(LIFTED)("%s: the last row says `type to search` and sends Escape", (name) => {
    const close = detectSwitchPicker(load(name))!.options.at(-1)!;
    expect(close).toEqual(wayOut(name));
    expect(close.description).toBe("type to search");
    expect(close.keys).toEqual(["Escape"]);
  });

  // omp clears a typed search on its first Escape and closes only on an empty one, so the label says
  // which of the two the one tap does.
  it.each([
    ["omp--v18-4-switch-search.txt", "sonnet"],
    ["omp--v18-4-switch-search-short.txt", "opus-5"],
    ["omp--v18-4-switch-search-short-moved.txt", "opus-5"],
  ])("%s: a search (`%s`) is typed, so the last row is `Clear search`", (name, typed) => {
    const model = detectSwitchPicker(load(name))!;
    expect(searchOnScreen(textsOf(name))).toBe(typed);
    expect(model.options.at(-1)).toEqual(CLEAR_SEARCH);
    expect(model.options.map((o) => o.label)).not.toContain("Close");
  });

  it.each(["omp--v18-4-switch.txt", "omp--v18-4-switch-top.txt", "omp--v18-4-switch-short-pane.txt"])(
    "%s: no search is typed, so the last row stays `Close`",
    (name) => {
      expect(searchOnScreen(textsOf(name))).toBe("");
      const model = detectSwitchPicker(load(name))!;
      expect(model.options.at(-1)).toEqual(CLOSE);
      expect(model.options.map((o) => o.label)).not.toContain("Clear search");
    },
  );

  it("the label follows the search row alone: typing a character into an empty search flips it", () => {
    const base = textsOf("omp--v18-4-switch.txt");
    const typed = base.map((t, i) => (i === TITLE_AT + 2 ? t.replace("🔍 >", "🔍 > o") : t));
    expect(detectSwitchPicker(fromTexts(base))!.options.at(-1)!.label).toBe("Close");
    expect(detectSwitchPicker(fromTexts(typed))!.options.at(-1)!.label).toBe("Clear search");
  });

  it("the description is read from the footer, not invented", () => {
    // The footer must print `type to search` (it is the footer's whole text, compared exactly), so
    // an edit that drops the segment declines instead of lifting a card that names a missing one.
    const base = textsOf("omp--v18-4-switch.txt");
    expect(base[FOOTER_AT]).toContain(" · type to search · ");
    const dropped = base.map((t, i) => (i === FOOTER_AT ? t.replace(" · type to search", "") : t));
    expect(detectSwitchPicker(fromTexts(dropped))).toBeNull();
  });
});

describe("every tap is a walk the footer printed, and lands on the row it names", () => {
  it.each(LIFTED)("%s", (name) => {
    const texts = textsOf(name);
    expect(texts.join("\n")).toContain(FOOTER);
    const rows = screenModels(texts);
    const from = rows.findIndex((r) => r.pointed);
    expect(from).toBeGreaterThanOrEqual(0);
    const model = detectSwitchPicker(load(name))!;
    const close = model.options.at(-1)!;
    expect(close).toEqual(wayOut(name));
    // The current model is named in the accessible name and never an option; no row is named when
    // none is marked.
    const current = currentOnScreen(texts);
    const lastLine = model.question.split("\n").at(-1);
    if (current === null) expect(model.question.split("\n")).toHaveLength(3);
    else {
      expect(lastLine).toBe(`● current: ${current}`);
      expect(model.options.map((o) => o.label)).not.toContain(current);
    }
    for (const option of model.options.slice(0, -1)) expect(option.description ?? "").not.toMatch(/current/);
    for (const option of model.options.slice(0, -1)) {
      const walk = option.keys.slice(0, -1);
      expect(option.keys.at(-1)).toBe("Enter");
      // One direction only, and no digit: `↑/↓` and `⏎` are the footer's keys.
      expect(new Set(walk).size).toBeLessThanOrEqual(1);
      for (const key of walk) expect(["Up", "Down"]).toContain(key);
      const to = from + walk.filter((k) => k === "Down").length - walk.filter((k) => k === "Up").length;
      // Inside the window, so the walk never wraps and never scrolls.
      expect(to).toBeGreaterThanOrEqual(0);
      expect(to).toBeLessThan(rows.length);
      expect(rows[to]!.id).toBe(option.label);
      expect(option.keyLabel).toBe(to === from ? "❯" : "");
      // The label is an id: a slash, no ellipsis, no badge text.
      expect(option.label).toContain("/");
      expect(option.label).not.toMatch(/…|◫|🧠|\$|t\/s|\s/u);
    }
  });

  it.each(LIFTED)("%s: one prompt-select under the raw transcript, a modal the composer refuses", (name) => {
    const lines = load(name);
    const blocks = ompBuildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw", "prompt-select"]);
    expect(ompModalOnScreen(lines)).toBe(true);
    expect(ompAdapter.composerReady!(lines)).toBe(false);
  });
});

describe("the region, and what stays on screen above the card", () => {
  it("the card starts at the window; the title, status sentence and typed search stay raw above it", () => {
    const lines = load("omp--v18-4-switch-search.txt");
    const region = detectSwitchPickerRegion(lines)!;
    expect(region.startLine).toBe(WINDOW_AT);
    const blocks = ompBuildBlocks(lines);
    const raw = blocks[0]!.lines.map(lineText);
    expect(raw.at(-4)!.startsWith("╭─ Switch Model ─")).toBe(true);
    expect(raw.at(-2)).toContain("🔍 > sonnet");
    expect(blocks[1]!.lines).toEqual(lines.slice(WINDOW_AT));
  });

  it("the signature is the whole box, title through bottom border, trailing padding off", () => {
    const texts = textsOf("omp--v18-4-switch.txt");
    const model = detectSwitchPicker(load("omp--v18-4-switch.txt"))!;
    const rows = model.signature.split("\n");
    expect(rows).toHaveLength(FOOTER_AT - TITLE_AT + 2);
    expect(rows[0]!.startsWith("╭─ Switch Model ─")).toBe(true);
    expect(rows.at(-1)!.startsWith("╰─")).toBe(true);
    expect(rows.at(-2)).toBe(texts[FOOTER_AT]!.trimEnd());
    expect(rows.at(-2)!.startsWith(`│ ${FOOTER} `)).toBe(true);
    expect(rows.every((r) => r === r.trimEnd())).toBe(true);
    expect(model.signature.length).toBeLessThan(32_000);
    // The core signature differs by what the pointer's own move changes: the pointer glyph and the two
    // detail rows, each a fixed token. Every other row is byte-identical.
    const core = model.coreSignature.split("\n");
    expect(core).toHaveLength(rows.length);
    const detailRows = [FACTS_AT - TITLE_AT, CHIPS_AT - TITLE_AT];
    const pointerRow = rows.findIndex((r) => r.includes("❯"));
    expect(pointerRow).toBeGreaterThan(-1);
    rows.forEach((row, i) => {
      if (detailRows.includes(i)) expect(core[i], `row ${i} is a detail row`).not.toBe(row);
      else if (i === pointerRow) expect(core[i]).toBe(row.replace("❯", " "));
      else expect(core[i], `row ${i}`).toBe(row);
    });
    expect(core[detailRows[0]!]).not.toContain("Claude");
    expect(core[detailRows[1]!]).not.toContain("current");
  });
});

describe("the race guard sees the pointer, the search, the window and the scrollbar", () => {
  const base = textsOf("omp--v18-4-switch.txt");
  const edit = (at: number, from: string | RegExp, to: string) =>
    detectSwitchPicker(fromTexts(base.map((t, i) => (i === at ? t.replace(from, to) : t))));
  const original = detectSwitchPicker(fromTexts(base))!;

  it("a pointer moved at the desk is not the same prompt", () => {
    const moved = detectSwitchPicker(load("omp--v18-4-switch-moved.txt"))!;
    expect(promptsEqual(original, moved)).toBe(false);
  });

  it("a scrolled window, a changed search or another current model is not the same prompt", () => {
    expect(promptsEqual(original, detectSwitchPicker(load("omp--v18-4-switch-top.txt"))!)).toBe(false);
    expect(promptsEqual(original, detectSwitchPicker(load("omp--v18-4-switch-wrapped.txt"))!)).toBe(false);
    // The scrollbar thumb one row lower: the same rows, a window scrolled elsewhere in the list.
    const thumbMoved = detectSwitchPicker(
      fromTexts(
        base.map((t, i) =>
          i === WINDOW_AT ? t.replace(/█ │$/, "│ │") : i === WINDOW_AT + 1 ? t.replace(/│ │$/, "█ │") : t,
        ),
      ),
    )!;
    expect(thumbMoved).not.toBeNull();
    expect(promptsEqual(original, thumbMoved)).toBe(false);
    const searched = edit(TITLE_AT + 2, "🔍 >", "🔍 > o")!;
    expect(searched).not.toBeNull();
    expect(promptsEqual(original, searched)).toBe(false);
  });

  it("a price that changed under the same id is not the same prompt, and still lifts", () => {
    const repriced = edit(WINDOW_AT, "$0.75/3.75", "$0.80/3.75")!;
    expect(repriced).not.toBeNull();
    expect(promptsEqual(original, repriced)).toBe(false);
  });

  it("the same screen twice is the same prompt", () => {
    expect(promptsEqual(original, detectSwitchPicker(load("omp--v18-4-switch.txt"))!)).toBe(true);
  });
});

describe("fails closed", () => {
  const base = textsOf("omp--v18-4-switch.txt");
  const short = textsOf("omp--v18-4-switch-short-pane.txt");
  const editAt = (texts: string[], at: number, from: string | RegExp, to: string) =>
    detectSwitchPicker(fromTexts(texts.map((t, i) => (i === at ? t.replace(from, to) : t))));
  const edit = (at: number, from: string | RegExp, to: string) => editAt(base, at, from, to);
  const pointedAt = WINDOW_AT + 4;

  it("positive control: the capture lifts, so every edit below is what declines", () => {
    expect(detectSwitchPicker(fromTexts(base))).not.toBeNull();
    expect(base[TITLE_AT]!.startsWith("╭─ Switch Model ─")).toBe(true);
    expect(base[pointedAt]).toContain("❯ anthropic/claude-opus-5-5 ●");
    expect(base[FOOTER_AT]).toContain(FOOTER);
  });

  it.each([
    ["omp--v18-4-switch-nomatch.txt", "a search with no match: no row to walk from"],
    ["omp--v18-4-switch-quick-roles.txt", "the `@` quick-roles state: another action under another footer"],
    ["omp--v18-4-switch-task.txt", "the task-model state (Alt+P): another title, status and footer"],
    ["omp--v18-4-switch-nerd.txt", "the Nerd Font preset: other glyphs in the footer, pointer and search row"],
    ["omp--v18-4-switch-clipped.txt", "a 74-column pane: omp clipped the footer"],
  ])("%s: %s", (name) => {
    expect(detectSwitchPickerRegion(load(name))).toBeNull();
  });

  it("with any other footer: clipped, re-spelled, rebound, text keycaps, or without the toggle", () => {
    expect(edit(FOOTER_AT, " · Alt+P task model", "")).toBeNull();
    expect(edit(FOOTER_AT, "⎋ close", "⎋ cancel")).toBeNull();
    expect(edit(FOOTER_AT, "⏎ use", "\u{F0311} use")).toBeNull();
    expect(edit(FOOTER_AT, "↑/↓ models", "ctrl+p/ctrl+n models")).toBeNull();
    expect(edit(FOOTER_AT, "⏎ use", "Enter use")).toBeNull();
    expect(edit(FOOTER_AT, "⎋ close", "Esc close")).toBeNull();
    expect(edit(FOOTER_AT, "@ quick roles", "@ quick roles · ⇥ all")).toBeNull();
    expect(edit(FOOTER_AT, "· ⎋ close · Alt+P task model", "…")).toBeNull();
  });

  it("with another title or status sentence, such as task mode or a config error", () => {
    expect(edit(TITLE_AT, "Switch Model", "Switch Task Model")).toBeNull();
    expect(edit(TITLE_AT, "Switch Model", "Select Model")).toBeNull();
    expect(edit(TITLE_AT + 1, "Session-only switch — role models stay unchanged", "Quick role switch")).toBeNull();
    expect(edit(TITLE_AT + 1, "Session-only switch", "Config error: models.yml")).toBeNull();
  });

  it("with the search row in another preset, or without the spacers", () => {
    expect(edit(TITLE_AT + 2, "🔍", "\u{F002}")).toBeNull();
    expect(edit(TITLE_AT + 2, "🔍 >", "[/] >")).toBeNull();
    expect(detectSwitchPicker(fromTexts(base.filter((_, i) => i !== TITLE_AT + 3)))).toBeNull();
    expect(detectSwitchPicker(fromTexts(base.filter((_, i) => i !== FACTS_AT - 1)))).toBeNull();
  });

  it("with the pointer of another preset, on no row, or on two", () => {
    expect(edit(pointedAt, "❯", "\u{F054}")).toBeNull();
    expect(edit(pointedAt, "❯", ">")).toBeNull();
    expect(edit(pointedAt, "❯", " ")).toBeNull();
    expect(edit(WINDOW_AT, "│   ", "│ ❯ ")).toBeNull();
  });

  it("with two current marks, two rules, or a current mark of another preset", () => {
    expect(edit(WINDOW_AT + 5, "claude-fable-5-1 ", "claude-fable-5-1 ●")).toBeNull();
    const rule = base[WINDOW_AT + 3]!;
    expect(detectSwitchPicker(fromTexts(base.map((t, i) => (i === WINDOW_AT + 6 ? rule : t))))).toBeNull();
    expect(edit(pointedAt, "claude-opus-5-5 ●", "claude-opus-5-5 [x]")).toBeNull();
  });

  it("with a badge this grammar does not know, or a word after the id", () => {
    expect(edit(WINDOW_AT + 5, "$10/50", "beta")).toBeNull();
    expect(edit(WINDOW_AT + 5, "claude-fable-5-1 ", "claude-fable-5-1 (preview)")).toBeNull();
    expect(edit(WINDOW_AT + 5, "🧠 53", "IQ 53")).toBeNull();
    // A row whose first token has no slash is not a model id.
    expect(edit(WINDOW_AT + 5, "anthropic/claude-fable-5-1", "claude-fable-5-1-xxxxxxxxxx")).toBeNull();
  });

  it("with detail rows that disagree with the pointed row, or that this grammar does not know", () => {
    expect(base[CHIPS_AT]).toMatch(/│ {3}● current\s*│$/);
    expect(edit(CHIPS_AT, "● current", "         ")).toBeNull();
    expect(edit(CHIPS_AT, "● current", "● default")).toBeNull();
    expect(edit(CHIPS_AT, "● current", "Loading…")).toBeNull();
    expect(edit(CHIPS_AT, "● current", "⦸ context 11k exceeds 8.2k limit")).toBeNull();
    expect(edit(FACTS_AT, /│ {3}\S.*?(\s*│)$/u, "│$1")).toBeNull();
  });

  it("with a blank row inside the list, a scrollbar on some rows only, or padding beside a scrollbar", () => {
    const blank = base[FACTS_AT - 1]!;
    expect(detectSwitchPicker(fromTexts(base.map((t, i) => (i === WINDOW_AT + 8 ? blank : t))))).toBeNull();
    expect(edit(WINDOW_AT + 8, /│ │$/, "  │")).toBeNull();
    expect(detectSwitchPicker(fromTexts(base.map((t, i) => (i === WINDOW_AT + 15 ? blank : t))))).toBeNull();
    // A scrollbar track with no thumb anywhere is not omp's scrollbar.
    expect(edit(WINDOW_AT, "█ │", "│ │")).toBeNull();
  });

  it("with a window shorter than omp's floor of five, or taller than sixty rows", () => {
    expect(detectSwitchPicker(fromTexts(short.filter((_, i) => i !== SHORT_TITLE_AT + 5)))).toBeNull();
    const extra = (n: number) => [
      ...base.slice(0, WINDOW_AT + 8),
      ...Array.from({ length: n }, () => base[WINDOW_AT + 8]!),
      ...base.slice(WINDOW_AT + 8),
    ];
    expect(detectSwitchPicker(fromTexts(extra(44)))).not.toBeNull();
    expect(detectSwitchPicker(fromTexts(extra(45)))).toBeNull();
  });

  it("with no row it can offer: every one over its context or shortened", () => {
    const over = (texts: string[], rows: number[]) =>
      texts.map((t, i) => (rows.includes(i) ? t.replace(/(anthropic\/\S+)( ●)?/u, "$1$2 ⦸ context>8k") : t));
    // omp prints the warning in place of the chips, the current mark included.
    const window = [0, 1, 2, 3].map((r) => SHORT_TITLE_AT + 4 + r);
    const chips = SHORT_TITLE_AT + 11;
    const warned = (texts: string[]) =>
      texts.map((t, i) => (i === chips ? t.replace("● current · ● default ◒", "⦸ context 11k exceeds 8k limit ") : t));
    // Positive control: one row left offerable lifts with that row alone.
    const one = detectSwitchPicker(fromTexts(warned(over(short, window.slice(0, 3)))));
    expect(one?.options.map((o) => o.label)).toEqual(["anthropic/claude-sonnet-5-5", "Close"]);
    expect(detectSwitchPicker(fromTexts(warned(over(short, window))))).toBeNull();
  });

  it("with the current model as the only offerable row: it is never offered, so the screen declines", () => {
    const over = (texts: string[], rows: number[]) =>
      texts.map((t, i) => (rows.includes(i) ? t.replace(/(anthropic\/\S+)/u, "$1 ⦸ context>8k") : t));
    const window = [0, 1, 2, 3].map((r) => SHORT_TITLE_AT + 4 + r);
    // Positive control: the same capture with sonnet left offerable lifts, with sonnet alone.
    const control = detectSwitchPicker(fromTexts(over(short, window.slice(1, 3))));
    expect(control?.options.map((o) => o.label)).toEqual(["anthropic/claude-sonnet-5-5", "Close"]);
    // The pointed row is the current model; haiku, fable and sonnet are over their context. This lifted
    // as the current model plus Close before the current model stopped being an option.
    expect(detectSwitchPicker(fromTexts(over(short, window.slice(1))))).toBeNull();
    // Shortened rows leave the same residue: the current model is the only row with a whole id on screen.
    const shortened = short.map((t, i) =>
      window.slice(1).includes(i) ? t.replace(/^(│ {3}anthropic\/\S{4})\S*/u, "$1…") : t,
    );
    expect(detectSwitchPicker(fromTexts(shortened))).toBeNull();
  });

  it("when the box is too wide for the bridge to bind it", () => {
    const widen = (by: number) =>
      base.map((t, i) =>
        i >= WINDOW_AT && i < WINDOW_AT + 16 ? t.replace(/^(│ [❯ ] \S+(?: ●)?)/u, `$1${" ".repeat(by)}`) : t,
      );
    // Positive control: the same edit, narrower, still lifts, so the length is what declines.
    expect(detectSwitchPicker(fromTexts(widen(1000)))).not.toBeNull();
    expect(detectSwitchPicker(fromTexts(widen(2100)))).toBeNull();
  });
});

describe("tail anchoring", () => {
  it.each(["omp--v18-4-switch.txt", "omp--v18-4-switch-short-pane.txt"])(
    "%s: output below the box, or a row under the border, declines",
    (name) => {
      expect(detectSwitchPicker([...load(name), ...fromTexts(["● Switched model", "  ⎿  done"])])).toBeNull();
      expect(detectSwitchPicker([...load(name), ...fromTexts(["some status row"])])).toBeNull();
    },
  );

  it("trailing blank rows do not move the tail", () => {
    expect(detectSwitchPicker([...load("omp--v18-4-switch.txt"), ...fromTexts(["", "  ", ""])])).not.toBeNull();
  });

  it("a picker quoted in the transcript, above a live composer, is not the picker", () => {
    const quoted = textsOf("omp--v18-4-switch.txt").slice(TITLE_AT);
    const composer = textsOf("omp--v18-4-composer-idle.txt");
    expect(detectSwitchPicker(fromTexts([...quoted, ...composer]))).toBeNull();
  });
});

describe("the grammar claims nothing else in the corpus", () => {
  it("lifts exactly the twenty-three session-state captures, out of every capture in the corpus (none of them offered only the current model)", () => {
    const all = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));
    expect(all.length).toBeGreaterThan(300);
    const lifted = all.filter((name) => detectSwitchPicker(load(name)) !== null);
    expect(lifted.toSorted()).toEqual(LIFTED);
  });
});

// THE POINTER MOVES, THE DIALOG DOES NOT. These are four REAL captures of one picker, the pointer on
// a different row each time, and a fifth with a search typed (`omp--v18-4-switch-ptr-*.txt`,
// `-search-son.txt`). omp rewrites the two detail rows under the list for the pointed model, so a
// walk changes them; a `coreSignature` that kept them made every walked tap answer `changed` and
// never commit (found live, 2026-10-03). Synthetic perturbations had missed it: only two real
// captures with the pointer on different rows show what omp itself repaints.
/** True when two rows differ only by the pointer glyph: one has it where the other has a blank. */
const differsByPointerOnly = (a: string, b: string): boolean => a.replace("❯", " ") === b.replace("❯", " ");

describe("a moved pointer is the same picker (real captures, ADR 0080 point 5)", () => {
  const POINTER_CAPTURES = [
    ["omp--v18-4-switch-ptr-opus-current.txt", null],
    ["omp--v18-4-switch-ptr-haiku.txt", "anthropic/claude-haiku-4-5"],
    ["omp--v18-4-switch-ptr-fable.txt", "anthropic/claude-fable-5-1"],
    ["omp--v18-4-switch-ptr-sonnet.txt", "anthropic/claude-sonnet-5-5"],
  ] as const;

  it("captured: only the detail rows and the pointer differ between positions, so the core blanks them and nothing else", () => {
    const rowsOf = (name: string) => detectSwitchPicker(load(name))!.signature.split("\n");
    const base = rowsOf(POINTER_CAPTURES[0][0]);
    for (const [name] of POINTER_CAPTURES.slice(1)) {
      const rows = rowsOf(name);
      expect(rows).toHaveLength(base.length);
      const differing = rows.flatMap((r, i) => (r === base[i] ? [] : [i]));
      // The pointer's old and new row, the facts row and the chips row: `rows.length - 4` and `- 3`.
      const details = [rows.length - 4, rows.length - 3];
      expect(differing.filter((i) => !details.includes(i) && !differsByPointerOnly(rows[i]!, base[i]!)), name).toEqual([]);
      for (const i of details) expect(rows[i], `${name} detail row ${i}`).not.toBe(base[i]);
    }
  });

  it("the core blanks exactly those rows: no other row of any capture differs in it", () => {
    const coreOf = (name: string) => detectSwitchPicker(load(name))!.coreSignature;
    const cores = new Set(POINTER_CAPTURES.map(([name]) => coreOf(name)));
    expect(cores.size).toBe(1);
  });

  for (const [a] of POINTER_CAPTURES) {
    for (const [b] of POINTER_CAPTURES) {
      if (a === b) continue;
      it(`${a} and ${b}: same identity both ways, not equal`, () => {
        const ma = detectSwitchPicker(load(a))!;
        const mb = detectSwitchPicker(load(b))!;
        expect(promptsSameIdentity(ma, mb)).toBe(true);
        expect(promptsSameIdentity(mb, ma)).toBe(true);
        expect(promptsEqual(ma, mb)).toBe(false);
      });
    }
  }

  it.each(POINTER_CAPTURES)("%s: exactly the pointed offered row has the plan [Enter]", (name, pointed) => {
    const model = detectSwitchPicker(load(name))!;
    const bare = model.options.filter((o) => sameKeys(o.keys, ["Enter"])).map((o) => o.label);
    // The pointer on the current model: that row is hidden, so no offered row is the pointed one.
    expect(bare).toEqual(pointed === null ? [] : [pointed]);
  });

  it("a search typed is another picker: not the same identity as any pointer capture", () => {
    const search = detectSwitchPicker(load("omp--v18-4-switch-search-son.txt"))!;
    for (const [name] of POINTER_CAPTURES) {
      const other = detectSwitchPicker(load(name))!;
      expect(promptsSameIdentity(search, other), name).toBe(false);
      expect(promptsSameIdentity(other, search), name).toBe(false);
    }
  });
});

// THE OVER-ACCEPT DIRECTION (ADR 0080 point 5). Every blank in `coreSignature` is a safety decision:
// it is the only link between the dialog the user tapped and the Enter that goes out after the walk.
// The two detail rows are blanked because they follow the pointer. These tests start from a real
// capture (pointer on haiku, the current model opus), change ONE thing and assert the result.
describe("mutations of a real capture: what the verify read must hold and what it must refuse", () => {
  const BASE = "omp--v18-4-switch-ptr-haiku.txt";
  const base = textsOf(BASE);

  const model = (texts: string[]) => {
    const m = detectSwitchPicker(fromTexts(texts));
    expect(m, "the edited screen must still lift").not.toBeNull();
    return m!;
  };
  const same = (a: string[], b: string[]): boolean => promptsSameIdentity(model(a), model(b));
  /** Replace the one occurrence of `from` in the row containing `needle`, keeping the row's width. */
  const edit = (texts: string[], needle: string, from: string, to: string): string[] => {
    expect(to.length, `${from} and ${to} must have the same width`).toBe(from.length);
    const at = texts.findIndex((t) => t.includes(needle));
    expect(at, needle).toBeGreaterThanOrEqual(0);
    expect(texts[at]).toContain(from);
    return texts.map((t, i) => (i === at ? t.replace(from, to) : t));
  };

  it("holds: the two detail rows replaced by another model's detail rows", () => {
    const other = textsOf("omp--v18-4-switch-ptr-sonnet.txt");
    const bottom = (texts: string[]) => texts.findLastIndex((t) => t.startsWith("╰"));
    const [mine, theirs] = [bottom(base), bottom(other)];
    // The facts row and the chips row, the two rows above the footer.
    const edited = base.map((t, i) => (i === mine - 3 || i === mine - 2 ? other[theirs - (mine - i)]! : t));
    expect(edited[mine - 3]).not.toBe(base[mine - 3]);
    expect(edited[mine - 3]).toContain("Claude Sonnet 5.5");
    expect(same(base, edited)).toBe(true);
    expect(same(edited, base)).toBe(true);
    expect(promptsEqual(model(base), model(edited))).toBe(false);
  });

  it("differs: a model row's id changed", () => {
    expect(same(base, edit(base, "claude-fable-5-1", "fable-5-1", "fable-5-2"))).toBe(false);
  });

  it("differs: a row's badge changed (intelligence, context, price)", () => {
    expect(same(base, edit(base, "claude-fable-5-1", "🧠 53", "🧠 54"))).toBe(false);
    expect(same(base, edit(base, "claude-fable-5-1", "1m ◫", "2m ◫"))).toBe(false);
    expect(same(base, edit(base, "claude-sonnet-5-5", "$2/10", "$2/11"))).toBe(false);
  });

  it("differs: the search text changed", () => {
    const typed = edit(base, "🔍 >", "🔍 >   ", "🔍 > s ");
    expect(model(typed).options.at(-1)!.label).toBe("Clear search");
    expect(same(base, typed)).toBe(false);
    expect(same(typed, edit(base, "🔍 >", "🔍 >   ", "🔍 > t "))).toBe(false);
  });

  it("differs: the current mark moved to another row", () => {
    const cleared = edit(base, "claude-opus-5-5", "5-5 ●", "5-5  ");
    const moved = edit(cleared, "claude-sonnet-5-5", "5-5  ", "5-5 ●");
    expect(model(moved).options.map((o) => o.label)).toContain("anthropic/claude-opus-5-5");
    expect(same(base, moved)).toBe(false);
  });

  it("differs: the current mark removed", () => {
    expect(same(base, edit(base, "claude-opus-5-5", "5-5 ●", "5-5  "))).toBe(false);
  });

  it("differs: a model row swapped for another (the window's order changed)", () => {
    const a = base.findIndex((t) => t.includes("claude-fable-5-1"));
    const b = base.findIndex((t) => t.includes("claude-sonnet-5-5"));
    const edited = [...base];
    [edited[a], edited[b]] = [base[b], base[a]];
    expect(same(base, edited)).toBe(false);
  });
});
