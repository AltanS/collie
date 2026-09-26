import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { lineText, splitLines } from "../blocks";
import { opencodeAdapter } from "./opencode";
import { composerPrompt, extractInputDraft, extractStatusLines, hasComposer } from "./opencode/chrome";
import { detectPermissionDialog } from "./opencode/dialog";
import { describeAdapterConformance } from "./conformance";

// The opencode adapter's CI gate. Tier 1 chrome (composer strip, status/draft probes, the composer
// gate) plus the Tier-2 permission-dialog lift, gated on the captured corpus:
// web/src/fixtures/panes/oc--*.txt — every capture a sandbox opencode 2.0.8 pane, driven and
// captured 2026-09-20 over the crew (see README.md's opencode section).
//
// The own cohort is the six+ permission-dialog captures (each must lift a `prompt-select`); the
// neutral cohort is every other opencode capture — composer states, the slash palette, the command
// palette, the narrow-width variants — each of which must stay raw AND must say so about the
// keyboard (composerReady true exactly on the live-composer screens). The foreign cohort is every
// other adapter's capture: cross-adapter fail-closed, the same leg the other adapters take.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

function loadLines(name: string) {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

const allOcFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("oc--") && f.endsWith(".txt"))
  .toSorted();

const otherFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.endsWith(".txt") && !f.startsWith("oc--"))
  .toSorted();

const ownFixtures = allOcFixtures.filter((f) => f.includes("permission"));

describeAdapterConformance(opencodeAdapter, {
  ownFixtures,
  foreignFixtures: otherFixtures,
  neutralFixtures: allOcFixtures.filter((f) => !ownFixtures.includes(f)),
});

describe("opencode permission dialog lift", () => {
  it("bash dialog: three options, pointer-derived keys, subject as the question", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-bash.txt"));
    expect(region).not.toBeNull();
    expect(region!.model.family).toBe("permission");
    expect(region!.model.question).toBe("$ echo fixture-corpus-probe");
    expect(region!.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
    // The pointer starts on the first option: Enter alone confirms it, forward offsets ride Right.
    expect(region!.model.options.map((o) => o.keys)).toEqual([
      ["Enter"],
      ["Right", "Enter"],
      ["Right", "Right", "Enter"],
    ]);
    // The block replaces [option row … tail]; the title and subject stay on the mirror.
    expect(region!.startLine).toBeGreaterThan(0);
  });

  it("moved selection: the keys follow the pointer the screen currently shows", () => {
    const moved = detectPermissionDialog(loadLines("oc--permission-bash--moved.txt"));
    expect(moved?.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
    // The pointer sits on "Always allow": it confirms with Enter alone; reaching "Allow once"
    // wraps forward two steps (probed) rather than sending Left, which was never probed.
    expect(moved?.model.options.map((o) => o.keys)).toEqual([
      ["Right", "Right", "Enter"],
      ["Enter"],
      ["Right", "Enter"],
    ]);
  });

  it("reject selection: the pointer is derivable there too", () => {
    const rejected = detectPermissionDialog(loadLines("oc--permission-bash--reject.txt"));
    expect(rejected?.model.options.at(-1)?.keys).toEqual(["Enter"]);
  });

  it("edit dialog: same shape, the subject names the file", () => {
    const edit = detectPermissionDialog(loadLines("oc--permission-edit.txt"));
    expect(edit?.model.question).toBe("→ Edit probe.txt");
    expect(edit?.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
  });

  it("narrow width: the hint row is its own row and the options row sits above it", () => {
    const narrow = detectPermissionDialog(loadLines("oc--narrow--permission-bash.txt"));
    expect(narrow?.model.question).toBe("$ echo narrow-width-probe");
    expect(narrow?.model.options.map((o) => o.label)).toEqual([
      "Allow once",
      "Always allow",
      "Reject",
    ]);
    expect(hasComposer(loadLines("oc--narrow--permission-bash.txt"))).toBe(false);
  });

  it("the lifted signature is the dialog's own rows, stable across spinner frames", () => {
    const region = detectPermissionDialog(loadLines("oc--permission-bash.txt"));
    // The spinner row sits ABOVE the title, outside the region.
    expect(region?.model.signature).not.toContain("⠙");
    expect(region?.model.signature).toContain("Permission required");
    expect(region?.model.signature).toContain("$ echo fixture-corpus-probe");
    // The signature is byte-faithful and ends at the footer — the bridge binds to it.
    expect(region?.model.signature.endsWith("enter confirm")).toBe(true);
  });

  it("a foreign dialog capture never lifts an opencode dialog", () => {
    // The pointer chip is a relative-style rule; a foreign capture must not satisfy it.
    const codex = detectPermissionDialog(loadLines("codex--trust-prompt.txt"));
    expect(codex).toBeNull();
  });
});

describe("opencode composer chrome", () => {
  it("composerReady is true on the live composer states", () => {
    for (const name of [
      "oc--fresh-idle.txt",
      "oc--draft-single.txt",
      "oc--draft-wrapped.txt",
      "oc--working.txt",
      "oc--draft-while-working.txt",
      "oc--composer-plan.txt",
      "oc--done--tool-run.txt",
      "oc--narrow--fresh-idle.txt",
      "oc--narrow--draft-wrapped.txt",
      // The slash palette is painted INSIDE the box: the composer still owns the keyboard.
      "oc--slash-palette.txt",
    ]) {
      expect(hasComposer(loadLines(name)), name).toBe(true);
    }
  });

  it("composerReady is false when a modal owns the screen", () => {
    // The ctrl+p command palette floats over the box, leaving the composer tail intact — the
    // overlay predicate is what refuses it.
    expect(hasComposer(loadLines("oc--command-palette.txt"))).toBe(false);
    for (const name of ownFixtures) {
      expect(hasComposer(loadLines(name)), name).toBe(false);
    }
  });

  it("extractInputDraft reads the draft, never the run above it", () => {
    expect(extractInputDraft(loadLines("oc--draft-single.txt"))).toBe(
      "hello from the fixture corpus",
    );
    expect(
      extractInputDraft(loadLines("oc--draft-wrapped.txt"))?.startsWith(
        "a reasonably long draft line",
      ),
    ).toBe(true);
    // The decisive case: the tool rows and spinner sit across MORE blanks than the draft's one.
    expect(extractInputDraft(loadLines("oc--draft-while-working.txt"))).toBe(
      "draft typed while the agent was working",
    );
    expect(extractInputDraft(loadLines("oc--narrow--draft-wrapped.txt"))).toBe(
      "draft text at narrow width wrapping over the edge of the box interior to capture the " +
        "composer fold at ninety columns of terminal width, this should wrap twice or more",
    );
  });

  it("an empty composer answers null — the placeholder is content, not a draft", () => {
    expect(extractInputDraft(loadLines("oc--fresh-idle.txt"))).toBeNull();
    expect(extractInputDraft(loadLines("oc--working.txt"))).toBeNull();
  });

  it("extractStatusLines re-surfaces the rows below the rule", () => {
    const status = extractStatusLines(loadLines("oc--fresh-idle.txt"));
    expect(status.length).toBeGreaterThanOrEqual(2); // cwd row + version row
    expect(lineText(status[0]!)).toContain("shift+tab");
  });

  it("the strip keeps the agent's live run and loses only the composer's own rows", () => {
    const lines = loadLines("oc--draft-while-working.txt");
    const raw = opencodeAdapter.buildBlocks(lines).at(-1)!;
    const text = raw.lines.map((l) => lineText(l)).join("\n");
    expect(text).toContain("Press ctrl+b to move running work to the background");
    expect(text).toContain("sleep 8 && echo done");
    // The composer's own model row is gone; the transcript's turn-footer rows ("Build · …") above
    // it are content and stay — hence the distinctive tail of the composer's row.
    expect(text).not.toContain("OpenCode Go · max");
    expect(text).not.toContain("draft typed while the agent was working");
  });

  it("a foreign buffer is returned raw and untouched (same shape, no opencode chrome)", () => {
    const lines = loadLines("codex--fresh-idle.txt");
    const blocks = opencodeAdapter.buildBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    // locateComposer found no rule, so the strip's only change is a trailing blank trim —
    // byte-identical for a buffer that does not end in blank rows.
    expect(blocks[0]!.kind === "raw" && blocks[0]!.lines.length).toBeLessThanOrEqual(lines.length);
  });
});

describe("opencode composerPrompt binding", () => {
  it("binds the model row — the row the destructive sweep does not move", () => {
    const prompt = composerPrompt(loadLines("oc--draft-single.txt"));
    expect(prompt).toContain("Build ·");
    // The rule and status rows below keep the region inside the bridge's tail window.
    const lines = loadLines("oc--draft-single.txt");
    const nonBlank = lines.filter((l) => lineText(l).trim().length > 0);
    const at = nonBlank.map((l) => lineText(l).replace(/\s+$/, "")).lastIndexOf(prompt!.replace(/\s+$/, ""));
    expect(nonBlank.length - 1 - at).toBeLessThan(6);
  });

  it("no region on the screens composerReady refuses", () => {
    for (const name of ownFixtures) {
      expect(composerPrompt(loadLines(name)), name).toBeNull();
    }
    expect(composerPrompt(loadLines("oc--command-palette.txt"))).toBeNull();
  });
});
