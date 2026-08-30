import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { ompAdapter } from "./omp";
import { lineText, rstrip } from "./omp/markers";
import { describeAdapterConformance } from "./conformance";
import { parseKeyHintFooter } from "./menu-hints";

// The omp adapter's CI gate. This adapter is Tier 1 BY CHOICE — it up-levels nothing, so `ownFixtures`
// is empty and every one of the 20 captures is a NEUTRAL fixture the adapter must leave raw. That is
// not a weaker gate than Claude's; it is the whole promise this contribution makes, asserted over the
// entire corpus rather than over a chosen subset: no interactive block kind is ever constructed, so no
// tap can reach a keystroke. See harness/omp/index.ts for why the dialog layer is a later PR.
//
// The FOREIGN cohort is every claude and codex capture, which pins the cross-adapter fail-closed leg.
// The other directions of that loop live in conformance.test.ts (Claude's leg takes omp--* + codex--*)
// and harness/codex.test.ts (codex's leg takes claude--* + omp--*).

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allOmpFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("omp--") && f.endsWith(".txt"))
  .sort();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .sort();
const allCodexFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("codex--") && f.endsWith(".txt"))
  .sort();
const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .sort();

// Every omp screen this adapter DECLINES — which is every screen IN THIS CORPUS, not every screen omp
// can draw (omp's tool-approval dialog, in particular, was never captured; see omp/index.ts). These
// are NOT "neutral output" in the plain sense: eleven of them are live modals with the keyboard, and
// the conformance assertion (raw-only) is exactly the promise worth pinning, because it is a promise
// about a screen where being wrong would type a keystroke. One reason per line.
const DECLINED = [
  // — Composer states. An input box is chrome, never a dialog; stripChrome peels it, the statusline
  //   and stranded-draft probes re-surface what it carried.
  "omp--done--tool-result.txt",
  "omp--done.txt",
  "omp--draft-ghost-suggestion.txt",
  "omp--draft-ghost-suggestion-busy.txt",
  "omp--draft-single.txt",
  "omp--draft-wrapped.txt",
  "omp--fresh-idle.txt",
  "omp--menu-dismissed.txt",
  "omp--working.txt",
  // — The slash palette is composer chrome too, and it is drawn BELOW the box, so it is stripped along
  //   with it rather than lifted. What replaces it on the phone is collie's own palette for omp
  //   (lib/agent-commands.ts's `omp` catalog), not a lifted block.
  "omp--slash-palette--filtered.txt",
  "omp--slash-palette.txt",
  // — The `ask` tool's dialogs. A boxed widget whose `handleInput` we have not read; its `Other (type
  //   your own)` and `n note` rows open free-text inputs that would strand a phone user mid-dialog;
  //   and `omp--select-multi-review.txt` renders a NUMBERED summary (`1. toppings: …`), the exact
  //   digit trap .adr/0009 exists for. Fail-closed: raw.
  "omp--select-menu-moved.txt",
  "omp--select-menu.txt",
  "omp--select-multi-checked.txt",
  "omp--select-multi-review.txt",
  "omp--select-multi.txt",
  // — The full-screen pickers. No `menu` block for these: `parseKeyHintFooter` (the shared, pinned
  //   key-hint grammar) returns [] for the `/model` and `/resume` footers, and for `/settings` it
  //   yields only {Jump sections, [Tab]} + {Close, [Escape]} because `menuKeyFor` rejects the
  //   compound tokens its real actions are named with (`Enter/Space`, `←/→`, `Type`). A modal whose
  //   only button is "Jump sections" is worse than the raw mirror; widening the shared grammar is a
  //   change to a contract Claude's picker is pinned against, and belongs in its own PR. The footers
  //   themselves are asserted below, so that widening cannot happen without this file noticing.
  "omp--menu-model-moved.txt",
  "omp--menu-model.txt",
  "omp--menu-resume-moved.txt",
  "omp--menu-resume.txt",
  "omp--menu-settings-moved.txt",
  "omp--menu-settings.txt",
];

// Nothing is up-levelled, so there is no own cohort. `describeAdapterConformance` registers a todo for
// each leg that needs one rather than passing vacuously, and still runs the leg that matters here:
// raw-only on all 22 omp captures and all 38 claude ones.
const ownFixtures: string[] = [];
const neutralFixtures = allOmpFixtures.filter((f) => DECLINED.includes(f));

describeAdapterConformance(ompAdapter, {
  ownFixtures,
  foreignFixtures: [...allClaudeFixtures, ...allCodexFixtures, ...allGrokFixtures],
  neutralFixtures,
});

// The corpus pin (mirroring claude/chrome.test.ts's): a newly-captured omp fixture must be filed into
// the declined list by a human, not silently absorbed. A capture that lands without a row there fails
// this test before it can quietly widen or narrow the gate above.
describe("the omp corpus", () => {
  const PINNED = [
    "omp--done--tool-result.txt",
    "omp--done.txt",
    "omp--draft-ghost-suggestion-busy.txt",
    "omp--draft-ghost-suggestion.txt",
    "omp--draft-single.txt",
    "omp--draft-wrapped.txt",
    "omp--fresh-idle.txt",
    "omp--menu-dismissed.txt",
    "omp--menu-model-moved.txt",
    "omp--menu-model.txt",
    "omp--menu-resume-moved.txt",
    "omp--menu-resume.txt",
    "omp--menu-settings-moved.txt",
    "omp--menu-settings.txt",
    "omp--select-menu-moved.txt",
    "omp--select-menu.txt",
    "omp--select-multi-checked.txt",
    "omp--select-multi-review.txt",
    "omp--select-multi.txt",
    "omp--slash-palette--filtered.txt",
    "omp--slash-palette.txt",
    "omp--working.txt",
  ];

  it("is exactly the 22 captures this adapter was developed against", () => {
    expect(allOmpFixtures).toEqual(PINNED);
  });

  it("declines all twenty-two — nothing is up-levelled", () => {
    expect(neutralFixtures).toEqual(PINNED);
    expect(ownFixtures).toEqual([]);
  });
});

// The structural version of the same promise, and the one that survives a refactor of the cohort
// lists above: walk the adapter's OWN output and assert no block it can build is anything but `raw`.
// `describeAdapterConformance` checks this per fixture through its own kind-agnostic filter; asserting
// the kinds directly here is what makes the claim in omp/index.ts's header — "emits NO interactive
// block kind" — a test rather than a comment.
describe("ompBuildBlocks emits nothing but raw", () => {
  it.each(allOmpFixtures)("%s builds only raw blocks", (name) => {
    const blocks = ompAdapter.buildBlocks(fixtureLines(name));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((b) => b.kind)).toEqual(blocks.map(() => "raw"));
  });

  // The Tier-1 claim is about the whole adapter object, not only its pipeline: every surface it
  // exposes must be a pure reader over StyledLine[], so nothing here can ORIGINATE a keystroke. This
  // is the whole list, spelled out — adding a key is how an adapter accidentally goes hot, so make it
  // a deliberate edit with a reason attached.
  it("exposes only read-only surfaces — no dialog, menu or wizard hook", () => {
    expect(Object.keys(ompAdapter).sort()).toEqual(
      [
        "agent", // the registry key
        "buildBlocks", // raw-only, asserted above
        "composerPrompt", // the row a destructive write BINDS to; it sends nothing itself
        "composerReady", // the pre-flight's refusal
        "extractInputDraft", // the stranded-draft preview + the type-then-verify half
        "extractStatusLines", // the statusline the strip peels off the mirror
      ].sort(),
    );
  });
});

// The reply pre-flight's half of Tier 1, asserted directly rather than only through the conformance
// suite's menu leg (which this adapter never reaches, having no menu fixtures). `composerReady` is
// what makes reply-action.ts refuse to type into a modal; a wrong `true` here puts the user's message
// into a picker, and a wrong `false` blocks every reply on a live composer.
const COMPOSER_FIXTURES = [
  "omp--done--tool-result.txt",
  "omp--done.txt",
  "omp--draft-ghost-suggestion.txt",
  "omp--draft-ghost-suggestion-busy.txt",
  "omp--draft-single.txt",
  "omp--draft-wrapped.txt",
  "omp--fresh-idle.txt",
  "omp--menu-dismissed.txt",
  "omp--slash-palette--filtered.txt",
  "omp--slash-palette.txt",
  "omp--working.txt",
];

describe("composerReady — the gate the reply path pre-flights on", () => {
  it.each(allOmpFixtures.filter((f) => !COMPOSER_FIXTURES.includes(f)))(
    "%s: a modal owns the keyboard ⇒ false",
    (name) => {
      expect(ompAdapter.composerReady!(fixtureLines(name))).toBe(false);
    },
  );

  it.each(COMPOSER_FIXTURES)("%s: the composer is on screen ⇒ true", (name) => {
    expect(ompAdapter.composerReady!(fixtureLines(name))).toBe(true);
  });
});

// WHY NO `menu` BLOCK — pinned against the real footers rather than asserted in prose. omp's modals
// stay raw because the SHARED key-hint grammar (harness/menu-hints.ts) finds nothing sendable in the
// keys those screens name; that is a fact about another module, and menu-hints.ts is shared, so the
// day it is widened for a future adapter omp's modals would silently start lifting. These assertions
// are the tripwire: widen `menuKeyFor` or `parseKeyHintFooter` and this file fails, which is the
// prompt to re-derive omp's decision rather than inherit someone else's.
describe("the shared menu grammar finds nothing to lift in omp's modals", () => {
  // Each modal's footer row, by index into the parsed capture — the row a menu detector would hand
  // `parseKeyHintFooter`. Read through the production parse pipeline, then stripped of omp's own box
  // sides where it has them: that is the MOST GENEROUS input the shared grammar could be given, so a
  // `[]` here is not an artefact of a border glyph landing inside a segment.
  const FOOTERS: { fixture: string; row: number }[] = [
    { fixture: "omp--menu-model.txt", row: 55 },
    { fixture: "omp--menu-model-moved.txt", row: 55 },
    { fixture: "omp--menu-resume.txt", row: 54 },
    { fixture: "omp--menu-resume-moved.txt", row: 54 },
    { fixture: "omp--select-menu.txt", row: 54 },
    { fixture: "omp--select-menu-moved.txt", row: 54 },
    { fixture: "omp--select-multi.txt", row: 57 },
    { fixture: "omp--select-multi-checked.txt", row: 57 },
    { fixture: "omp--select-multi-review.txt", row: 57 },
  ];

  it.each(FOOTERS)("$fixture: its footer yields no menu action at all", ({ fixture, row }) => {
    // omp writes `<key> <verb>` where the shared grammar requires `<key> to <verb>`, so every segment
    // is skipped before a key token is even looked up. A modal with zero buttons is not a modal worth
    // drawing — the raw mirror plus the special-keys pad is strictly better.
    expect(parseKeyHintFooter(footerText(fixture, row))).toEqual([]);
  });

  it.each(["omp--menu-settings.txt", "omp--menu-settings-moved.txt"])(
    "%s: the one footer that parses yields only degenerate actions",
    (fixture) => {
      // `/settings` is the exception, and its two survivors are exactly why omp gets no menu block:
      // `menuKeyFor` rejects the compound tokens its REAL actions are named with (`Enter/Space`,
      // `←/→`, `Type`), so what is left is a tab-jump and a cancel. Shipping that as the modal's whole
      // button row would tell a phone user those are their options, which is worse than raw.
      expect(parseKeyHintFooter(footerText(fixture, 55))).toEqual([
        { label: "Jump sections", keys: ["Tab"] },
        { label: "Close", keys: ["Escape"], cancel: true },
      ]);
    },
  );

  it("the footer indices above are the real footers, not stale line numbers", () => {
    // A fixture is byte-frozen, but an index is easy to get wrong and a wrong one would assert `[]`
    // about a blank line. Every row above must carry the `·`-separated hint shape these screens use.
    for (const { fixture, row } of FOOTERS) {
      expect(footerText(fixture, row), fixture).toContain(" · ");
    }
    expect(footerText("omp--menu-settings.txt", 55)).toContain(" · ");
  });
});

function fixtureLines(name: string) {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}

// omp boxes most of its footers (`│ <hints> … │`); `/resume` prints its own bracketed and unboxed.
// Peeling the sides is what a menu detector would do before deriving actions, so it is what the
// assertions above test against.
const BOXED_FOOTER = /^│\s(.*)\s│$/;

function footerText(name: string, row: number): string {
  const text = rstrip(lineText(fixtureLines(name)[row]!));
  const boxed = BOXED_FOOTER.exec(text);
  return (boxed === null ? text : boxed[1]!).trim();
}
