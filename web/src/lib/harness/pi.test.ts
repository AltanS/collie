import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { describeAdapterConformance } from "./conformance";
import { buildBlocks } from "./index";
import { piAdapter } from "./pi";
import { adapterFor } from "./registry";

const PANES = join(import.meta.dirname, "../../fixtures/panes");
const fixtures = readdirSync(PANES).filter((name) => name.endsWith(".txt")).toSorted();
const own = fixtures.filter((name) => name.startsWith("pi--omo-v5130-"));
const stockPi = fixtures.filter((name) => name.startsWith("pi--v0851-"));
const lifted = own.filter((name) => /-single-described(?:-moved)?\.txt$/.test(name));
const load = (name: string) => splitLines(parseAnsi(readFileSync(join(PANES, name), "utf8")));

describeAdapterConformance(piAdapter, {
  ownFixtures: lifted,
  // Deliberately unsupported dialogs join the raw cohort, not the interactive one.
  neutralFixtures: [...own.filter((name) => !lifted.includes(name)), ...stockPi],
  foreignFixtures: fixtures.filter((name) => !name.startsWith("pi--omo-v5130-") && !stockPi.includes(name)),
});

describe("pi adapter routing", () => {
  it("lifts an OmO question through the public pi dispatch", () => {
    const lines = load("pi--omo-v5130-single-described.txt");
    expect(buildBlocks(lines, { agent: "pi" }).map((block) => block.kind)).toEqual(["prompt-select"]);
    expect(adapterFor("pi")?.composerReady?.(lines)).toBe(false);
  });

  it.each(["multi", "single-other-focused", "answer-editor"])(
    "offers only the printed Escape key on the unmodelled %s state", (state) => {
      const lines = load(`pi--omo-v5130-${state}.txt`);
      expect(piAdapter.buildBlocks(lines).every((block) => block.kind === "raw")).toBe(true);
      expect(piAdapter.composerReady?.(lines)).toBe(false);
      expect(buildBlocks(lines, { agent: "pi" }).map((block) => block.kind)).toEqual(["unread-dialog"]);
    },
  );

  it("retains the raw mirror when the terminal view disables grammars", () => {
    const lines = load("pi--omo-v5130-single-described.txt");
    expect(buildBlocks(lines, { agent: "pi", grammars: false })).toEqual([{ kind: "raw", lines }]);
  });

  it("allows the captured OmO composer and binds its input frame", () => {
    const lines = load("pi--omo-v5130-idle.txt");
    expect(piAdapter.composerReady?.(lines)).toBe(true);
    expect(piAdapter.extractInputDraft(lines)).toBeNull();
    expect(piAdapter.composerPrompt?.(lines)).toBeDefined();
    expect(buildBlocks(lines, { agent: "pi" }).every((block) => block.kind === "raw")).toBe(true);
  });

  it("keeps stock pi sendable: its editor is a composer and its draft is read back", () => {
    const idle = load("pi--v0851-idle.txt");
    const draft = load("pi--v0851-draft.txt");
    expect(piAdapter.composerReady?.(idle)).toBe(true);
    expect(piAdapter.extractInputDraft(draft)).toBe("collie stock pi draft probe");
    expect(buildBlocks(idle, { agent: "pi" }).every((block) => block.kind === "raw")).toBe(true);
  });
});
