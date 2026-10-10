import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { ompAdapter } from "./omp";
import { lineText, rstrip } from "./omp/markers";
import { hasComposer as hasBoxComposer } from "./omp/chrome";
import { locateBorderlessComposer, locateClaudeComposer, locateGlyphComposer } from "./omp/glyph-prompt";
import { locatePiComposer } from "./omp/pi-shape";
import { locateRuleComposer } from "./omp/rule";
import { describeAdapterConformance } from "./conformance";
import { parseKeyHintFooter } from "./menu-hints";
import { decorateOmpDisplay } from "./omp/display";

// The omp adapter's CI gate. This adapter is Tier 1 everywhere EXCEPT FOUR SCREENS: it lifts the
// `/resume` session picker (omp/resume.ts, .adr/0076), the `ask` tool's one-question single-select
// dialog (omp/ask.ts, .adr/0077), the `bash` and `write` tool-approval dialog (omp/approval.ts,
// .adr/0078) and the compact model picker (omp/switch.ts, .adr/0079), and nothing else. So
// `ownFixtures` is exactly the resume captures that list at least one session, the single-select Ask
// captures, the approval captures and the model picker in its session state, and every other capture is a
// NEUTRAL fixture the adapter must leave raw. That is still not a weaker gate than Claude's: the neutral
// cohort is asserted over the entire rest of the corpus rather than over a chosen subset, so no
// interactive block kind is ever constructed from a `/model`, `/settings`, `/tree` or Ask multi-select
// screen; the only key a tap can send there is the unread-dialog card's declared Escape, which this
// adapter does not build (unread-dialog.test.ts pins it). See harness/omp/index.ts for why each of
// those is a later PR.
//
// The FOREIGN cohort is every claude, codex and grok capture, which pins the cross-adapter fail-closed
// leg. The other directions of that loop live in conformance.test.ts (Claude's leg takes omp--* +
// codex--*) and harness/codex.test.ts (codex's leg takes claude--* + omp--*).

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

const allOmpFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("omp--") && f.endsWith(".txt"))
  .toSorted();
const allClaudeFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("claude--") && f.endsWith(".txt"))
  .toSorted();
const allCodexFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("codex--") && f.endsWith(".txt"))
  .toSorted();
const allGrokFixtures = readdirSync(PANES_DIR)
  .filter((f) => f.startsWith("grok--") && f.endsWith(".txt"))
  .toSorted();
const allForeignFixtures = [...allClaudeFixtures, ...allCodexFixtures, ...allGrokFixtures];
// The `claude` and `borderless` composer captures (issue #343, omp v18.4.10) are composers under the
// same `omp--v18-4-` prefix, so the modal cohort names them out. `omp--v18-4-claude-*` and
// `omp--v18-4-borderless-*` are derived from the directory, so a new capture of either shape joins
// this list and the negative cohorts below without a typed entry.
const GLYPH_COMPOSER_FIXTURES = allOmpFixtures.filter((name) =>
  /^omp--v18-4-(?:claude|borderless)-/.test(name),
);
const CLAUDE_COMPOSER_FIXTURES = GLYPH_COMPOSER_FIXTURES.filter((name) => name.includes("-claude-"));
const BORDERLESS_COMPOSER_FIXTURES = GLYPH_COMPOSER_FIXTURES.filter((name) => name.includes("-borderless-"));
// `omp--menu-dismissed.txt` matches this prefix and is a COMPOSER capture, not a modal, and so is
// `omp--v18-4-composer-idle.txt`, the one `omp--v18-4-*` capture that is not a modal.
// `omp--tree.txt` is a modal under a name that fits none of those prefixes, so it is named outright.
const allOmpModalFixtures = allOmpFixtures.filter(
  (name) =>
    name.startsWith("omp--menu-") ||
    name.startsWith("omp--select-") ||
    name.startsWith("omp--approval-") ||
    (name.startsWith("omp--v18-4-") &&
      name !== "omp--v18-4-composer-idle.txt" &&
      !GLYPH_COMPOSER_FIXTURES.includes(name)) ||
    name === "omp--tree.txt",
);

// THE MODEL PICKER COHORT is derived from the directory, not typed: every `omp--v18-4-switch*` capture.
// The states the grammar declines are the exceptions, and they are a decision with a reason each (see the
// DECLINED comment below), so THEY stay a typed list. Everything else in the cohort is a session-state
// capture and must lift; a new one that does not fails conformance and gets filed here by a person.
const DECLINED_SWITCH = [
  "omp--v18-4-switch-clipped.txt",
  "omp--v18-4-switch-nerd.txt",
  "omp--v18-4-switch-nomatch.txt",
  "omp--v18-4-switch-quick-roles.txt",
  "omp--v18-4-switch-task.txt",
];
const SWITCH_COHORT = allOmpFixtures.filter((name) => name.startsWith("omp--v18-4-switch"));
const SWITCH_LIFTED = SWITCH_COHORT.filter((name) => !DECLINED_SWITCH.includes(name));

// The screens this adapter lifts. The `/resume` captures that list at least one session, seven of the
// eight (`omp--v18-4-resume-nomatch.txt` has no rows and stays raw, below), the Ask tool's
// one-question single-select dialog in all three keycap dialects: text (17.2.12), Nerd Font (18.4.4)
// and glyph (18.4.10, and 18.8 with option descriptions), and the tool-approval dialog in both
// captured presets: `nerd` with text keycaps (18.1.17, `bash` and `write`, the latter in both selection
// states) and `unicode` with glyph keycaps (18.4.10, `bash` and `write` in both selection states, and a
// fourteen-row `write`), and the compact model picker's session state (18.4.10: the pointer moved,
// wrapped and at both window edges, searches, over-context and truncated rows, role chips, and windows
// of 16, 15 and 5 rows).
const LIFTED = new Set([
  "omp--menu-resume-moved.txt",
  "omp--menu-resume.txt",
  "omp--v18-4-resume-all-projects.txt",
  "omp--v18-4-resume-moved.txt",
  "omp--v18-4-resume-search.txt",
  "omp--v18-4-resume-untitled-dated.txt",
  "omp--v18-4-resume.txt",
  "omp--select-menu-moved.txt",
  "omp--select-menu-noted.txt",
  "omp--select-menu-other.txt",
  "omp--select-menu.txt",
  "omp--v18-4-ask-single-moved.txt",
  "omp--v18-4-ask-single.txt",
  "omp--v18-8-ask-single-described-moved.txt",
  "omp--v18-8-ask-single-described.txt",
  "omp--approval-bash.txt",
  "omp--approval-write--deny.txt",
  "omp--approval-write.txt",
  "omp--v18-4-approval-bash-moved.txt",
  "omp--v18-4-approval-bash.txt",
  "omp--v18-4-approval-write-long.txt",
  "omp--v18-4-approval-write-moved.txt",
  "omp--v18-4-approval-write.txt",
  // The compact model picker's session state is DERIVED: every `omp--v18-4-switch*` capture except the
  // declined states listed in DECLINED_SWITCH. A new capture of it lifts by default, and the conformance
  // suite fails it loudly if it does not, which is the moment a person files it as declined with a reason.
  ...SWITCH_LIFTED,
]);

// Every omp screen this adapter DECLINES, which is every screen IN THIS CORPUS bar the lifted resume
// pickers, Ask single-selects, tool approvals and model pickers, not every screen omp can draw. These
// are NOT "neutral output" in the plain sense: many of them are live modals with the keyboard, and
// the conformance assertion (raw-only) is exactly the promise worth pinning, because it is a promise
// about a screen where being wrong would type a keystroke. One reason per line.
const DECLINED = new Set([
  // — Composer states. An input box is chrome, never a dialog; stripChrome peels it, the statusline
  //   and stranded-draft probes re-surface what it carried.
  "omp--done--tool-result.txt",
  "omp--done.txt",
  "omp--draft-ghost-suggestion.txt",
  "omp--draft-ghost-suggestion-busy.txt",
  "omp--draft-single.txt",
  "omp--draft-wrapped.txt",
  "omp--fresh-agents-hint.txt",
  "omp--fresh-effort-hint.txt",
  "omp--fresh-idle.txt",
  "omp--menu-dismissed.txt",
  "omp--v18-4-composer-idle.txt",
  "omp--v18-4-borderless-draft.txt",
  "omp--v18-4-borderless-idle.txt",
  "omp--v18-4-borderless-wrapped.txt",
  "omp--v18-4-claude-draft.txt",
  "omp--v18-4-claude-idle.txt",
  "omp--v18-4-claude-titled-draft.txt",
  "omp--v18-4-claude-titled.txt",
  "omp--v18-4-claude-wrapped.txt",
  "omp--v18-pi-effort-hint.txt",
  "omp--v18-rule-draft.txt",
  "omp--v18-rule-idle.txt",
  "omp--v18-rule-effort-hint.txt",
  "omp--v18-rule-wrapped.txt",
  "omp--working.txt",
  // — The slash palette is composer chrome too, and it is drawn BELOW the box, so it is stripped along
  //   with it rather than lifted. What replaces it on the phone is collie's own palette for omp
  //   (lib/agent-commands.ts's `omp` catalog), not a lifted block.
  "omp--slash-palette--filtered.txt",
  "omp--slash-palette.txt",
  // — The pi-shaped composer's own slash palette (omp 18.8, 2026-10-07): the palette REPLACES the
  //   status row rather than sitting under a box, and the draft lives on the filter row between the
  //   composer's two rules. Still chrome — stripped, and the phone draws its own list — but the one
  //   footer omp paints there that `locatePiComposer` accepts, because a slash command typed into the
  //   composer can only be verified (and so submitted) while the palette is up. See pi-shape.ts.
  "omp--v18-8-slash-palette.txt",
  "omp--v18-8-slash-palette-w48.txt",
  // - The `ask` tool's MULTI-select dialog, in both footer dialects, and its review screen. Its toggle
  //   is an arrow walk then Space, a recipe no shared model carries, and its Enter TOGGLES before omp
  //   18.4 (`Space/Enter toggle`) and SUBMITS in 18.4.10 (`␣ toggle · ⏎ submit`); the review screen
  //   renders a NUMBERED summary (`1. toppings: …`), the exact digit trap .adr/0009 exists for.
  //   Fail-closed: raw, with the Escape card (.adr/0077). The single-select dialog is lifted, above.
  "omp--select-multi-checked.txt",
  "omp--select-multi-review.txt",
  "omp--select-multi.txt",
  "omp--v18-4-ask-multi-checked.txt",
  "omp--v18-4-ask-multi.txt",
  // — The answer editor `Other` and `n note` open. A free-text input, never a dialog block: the
  //   phone's composer types into it (omp/answer-editor.ts), and the mirror keeps it visible.
  "omp--answer-editor-empty.txt",
  "omp--answer-editor-long.txt",
  "omp--answer-editor-note.txt",
  "omp--answer-editor-typed.txt",
  "omp--answer-editor-wrapped.txt",
  "omp--v18-4-ask-note-editor.txt",
  // — The full-screen pickers. No `menu` block for these: `parseKeyHintFooter` (the shared, pinned
  //   key-hint grammar) returns [] for the `/model` and `/resume` footers, and for `/settings` it
  //   yields only {Jump sections, [Tab]} + {Close, [Escape]} because `menuKeyFor` rejects the
  //   compound tokens its real actions are named with (`Enter/Space`, `←/→`, `Type`). A modal whose
  //   only button is "Jump sections" is worse than the raw mirror; widening the shared grammar is a
  //   change to a contract Claude's picker is pinned against, and belongs in its own PR. The footers
  //   themselves are asserted below, so that widening cannot happen without this file noticing.
  "omp--menu-model-moved.txt",
  "omp--menu-model.txt",
  "omp--menu-settings-moved.txt",
  "omp--menu-settings.txt",
  "omp--v18-4-menu-model.txt",
  "omp--v18-4-menu-settings.txt",
  // — The `/tree` picker, captured 2026-09-13 against omp v18.1.19 to vouch for the harness bar's
  //   Tree button. Another box at column 0, and declined for the same reason as the pickers above:
  //   its hint row names `Alt+↑/↓`, `PgUp/PgDn`, `Shift+Enter` and `Ctrl+O`, compound tokens
  //   `menuKeyFor` rejects, so a lifted modal would offer almost none of what the screen advertises.
  "omp--tree.txt",
  "omp--v18-4-tree.txt",
  // - The `/resume` picker with NO session to list: omp 18.4.10's "No sessions in current folder. Press
  //   ⇥ to view all." The grammar needs a pointed row to walk from, so it declines, and what the
  //   operator gets is the raw mirror plus the unread-dialog card with its Escape button.
  "omp--v18-4-resume-nomatch.txt",
  // - The compact model picker in every state but the session one (omp/switch.ts, .adr/0079). A search
  //   with no match has no row to walk from. The `@` quick-roles state applies a role's model AND its
  //   thinking level, and the task-model state (Alt+P) changes what spawned subagents run, two other
  //   actions under other footers. The Nerd Font preset is uncaptured as a lift and its footer differs by
  //   two glyphs. On a 74-column pane omp clips the footer, so the way out is not on screen at all and
  //   even the Escape card stays off (omp/modal.test.ts).
  ...DECLINED_SWITCH,
]);

// The own cohort is the lifted captures, so every conformance leg that needs one runs on them
// for real: each lifts, none lifts once output scrolls below it, every key is send_keys-valid, and each
// model signs itself and fails the committing check when a row of it changes. The neutral cohort still
// carries the leg that matters most here: raw-only on the other omp captures and on every foreign
// harness capture.
const ownFixtures = allOmpFixtures.filter((f) => LIFTED.has(f));
const neutralFixtures = allOmpFixtures.filter((f) => DECLINED.has(f));

describeAdapterConformance(ompAdapter, {
  ownFixtures,
  foreignFixtures: allForeignFixtures,
  neutralFixtures,
  // The two pi-shaped palette captures: the composer is on screen and ready, and no region binds.
  // The palette run stands between the composer's own rows and the tail — 8 rows of it in the wide
  // capture, 10 in the 48-column one — so a `composerPrompt` naming those rows would sit further from
  // the tail than `verifyExpectedPrompt` accepts and 409 every destructive sweep with "The input box
  // changed while clearing it" (pi-shape.ts `piComposerPrompt`). Null means an unbound write, exactly
  // as the boxed shape answers for the same palette sitting under its own composer (chrome.ts).
  unboundComposerFixtures: ["omp--v18-8-slash-palette.txt", "omp--v18-8-slash-palette-w48.txt"],
});

// The corpus pin (mirroring claude/chrome.test.ts's): a newly-captured omp fixture must be filed into
// the declined list by a human, not silently absorbed. A capture that lands without a row there fails
// this test before it can quietly widen or narrow the gate above.
describe("the omp corpus", () => {
  const PINNED = [
    "omp--answer-editor-empty.txt",
    "omp--answer-editor-long.txt",
    "omp--answer-editor-note.txt",
    "omp--answer-editor-typed.txt",
    "omp--answer-editor-wrapped.txt",
    "omp--approval-bash.txt",
    "omp--approval-write--deny.txt",
    "omp--approval-write.txt",
    "omp--done--tool-result.txt",
    "omp--done.txt",
    "omp--draft-ghost-suggestion-busy.txt",
    "omp--draft-ghost-suggestion.txt",
    "omp--draft-single.txt",
    "omp--draft-wrapped.txt",
    "omp--fresh-agents-hint.txt",
    "omp--fresh-effort-hint.txt",
    "omp--fresh-idle.txt",
    "omp--menu-dismissed.txt",
    "omp--menu-model-moved.txt",
    "omp--menu-model.txt",
    "omp--menu-resume-moved.txt",
    "omp--menu-resume.txt",
    "omp--menu-settings-moved.txt",
    "omp--menu-settings.txt",
    "omp--select-menu-moved.txt",
    "omp--select-menu-noted.txt",
    "omp--select-menu-other.txt",
    "omp--select-menu.txt",
    "omp--select-multi-checked.txt",
    "omp--select-multi-review.txt",
    "omp--select-multi.txt",
    "omp--slash-palette--filtered.txt",
    "omp--slash-palette.txt",
    "omp--tree.txt",
    "omp--v18-4-approval-bash-moved.txt",
    "omp--v18-4-approval-bash.txt",
    "omp--v18-4-approval-write-long.txt",
    "omp--v18-4-approval-write-moved.txt",
    "omp--v18-4-approval-write.txt",
    "omp--v18-4-ask-multi-checked.txt",
    "omp--v18-4-ask-multi.txt",
    "omp--v18-4-ask-note-editor.txt",
    "omp--v18-4-ask-single-moved.txt",
    "omp--v18-4-ask-single.txt",
    "omp--v18-4-borderless-draft.txt",
    "omp--v18-4-borderless-idle.txt",
    "omp--v18-4-borderless-wrapped.txt",
    "omp--v18-4-claude-draft.txt",
    "omp--v18-4-claude-idle.txt",
    "omp--v18-4-claude-titled-draft.txt",
    "omp--v18-4-claude-titled.txt",
    "omp--v18-4-claude-wrapped.txt",
    "omp--v18-4-composer-idle.txt",
    "omp--v18-4-menu-model.txt",
    "omp--v18-4-menu-settings.txt",
    "omp--v18-4-resume-all-projects.txt",
    "omp--v18-4-resume-moved.txt",
    "omp--v18-4-resume-nomatch.txt",
    "omp--v18-4-resume-search.txt",
    "omp--v18-4-resume-untitled-dated.txt",
    "omp--v18-4-resume.txt",
    "omp--v18-4-switch-clipped.txt",
    "omp--v18-4-switch-moved-up.txt",
    "omp--v18-4-switch-moved.txt",
    "omp--v18-4-switch-narrow-moved.txt",
    "omp--v18-4-switch-narrow.txt",
    "omp--v18-4-switch-nerd.txt",
    "omp--v18-4-switch-nomatch.txt",
    "omp--v18-4-switch-overcontext-moved.txt",
    "omp--v18-4-switch-overcontext.txt",
    "omp--v18-4-switch-ptr-fable.txt",
    "omp--v18-4-switch-ptr-haiku.txt",
    "omp--v18-4-switch-ptr-opus-current.txt",
    "omp--v18-4-switch-ptr-sonnet.txt",
    "omp--v18-4-switch-quick-roles.txt",
    "omp--v18-4-switch-roles-chips.txt",
    "omp--v18-4-switch-search-short-moved.txt",
    "omp--v18-4-switch-search-short.txt",
    "omp--v18-4-switch-search-son.txt",
    "omp--v18-4-switch-search.txt",
    "omp--v18-4-switch-short-pane-scrolled.txt",
    "omp--v18-4-switch-short-pane.txt",
    "omp--v18-4-switch-task.txt",
    "omp--v18-4-switch-top-edge.txt",
    "omp--v18-4-switch-top.txt",
    "omp--v18-4-switch-truncated-pointed.txt",
    "omp--v18-4-switch-truncated.txt",
    "omp--v18-4-switch-wrapped.txt",
    "omp--v18-4-switch.txt",
    "omp--v18-4-tree.txt",
    "omp--v18-8-ask-single-described-moved.txt",
    "omp--v18-8-ask-single-described.txt",
    "omp--v18-8-slash-palette-w48.txt",
    "omp--v18-8-slash-palette.txt",
    "omp--v18-pi-effort-hint.txt",
    "omp--v18-rule-draft.txt",
    "omp--v18-rule-effort-hint.txt",
    "omp--v18-rule-idle.txt",
    "omp--v18-rule-wrapped.txt",
    "omp--working.txt",
  ];

  // The list above is the pin and it stays typed: a new capture is filed by a person. The numbers in
  // the titles are read off it, so they never go stale.
  it(`is exactly the ${PINNED.length} captures this adapter was developed against`, () => {
    expect(allOmpFixtures).toEqual(PINNED);
  });

  it("the model picker cohort is not empty, so a prefix typo cannot make its derived entries vanish", () => {
    expect(SWITCH_COHORT.length).toBeGreaterThan(0);
    expect(SWITCH_LIFTED.length).toBeGreaterThan(0);
  });

  it(`lifts the ${ownFixtures.length} \`/resume\`, Ask single-select, approval and model picker captures and declines the other ${neutralFixtures.length}`, () => {
    expect(ownFixtures).toEqual([...LIFTED].toSorted());
    expect([...ownFixtures, ...neutralFixtures].toSorted()).toEqual(PINNED);
    expect(ownFixtures.filter((f) => neutralFixtures.includes(f))).toEqual([]);
  });
});

// The structural version of the same promise, and the one that survives a refactor of the cohort
// lists above: walk the adapter's OWN output and assert that the only interactive block it can build is
// the `prompt-select` of the `/resume` picker, the Ask single-select, the tool approval or the model
// picker, on the lifted captures and nowhere else. `describeAdapterConformance` checks this per fixture
// through its own kind-agnostic filter; asserting the kinds directly here is what makes the claim in
// omp/index.ts's header, "no interactive kind but those four lists", a test rather than a comment.
describe("ompBuildBlocks emits nothing but raw, bar the four lifted screens", () => {
  it.each(allOmpFixtures.filter((f) => !LIFTED.has(f)))("%s builds only raw blocks", (name) => {
    const blocks = ompAdapter.buildBlocks(fixtureLines(name));
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.map((b) => b.kind)).toEqual(blocks.map(() => "raw"));
  });

  it.each([...LIFTED].toSorted())("%s builds one prompt-select, and nothing else but the raw above it", (name) => {
    const blocks = ompAdapter.buildBlocks(fixtureLines(name));
    expect(blocks.filter((b) => b.kind !== "raw").map((b) => b.kind)).toEqual(["prompt-select"]);
    expect(blocks.at(-1)!.kind).toBe("prompt-select");
  });

  // The Tier-1 claim is about the whole adapter object, not only its pipeline: every surface it
  // exposes must be a pure reader over StyledLine[], so nothing here can ORIGINATE a keystroke. This
  // is the whole list, spelled out — adding a key is how an adapter accidentally goes hot, so make it
  // a deliberate edit with a reason attached.
  it("exposes only read-only surfaces — no dialog, menu or wizard hook", () => {
    expect(Object.keys(ompAdapter).toSorted()).toEqual(
      [
        "agent", // the registry key
        "buildBlocks", // raw-only except the four lifted screens, asserted above
        "cancelKey", // the unread-dialog card's one key, a declaration (.adr/0053, .adr/0076)
        "composerPrompt", // the row a destructive write BINDS to; it sends nothing itself
        "composerReady", // the pre-flight's refusal
        "modalOnScreen", // positive evidence a modal is up: the card's fifth condition
        "replyChunks", // lossless transport plan, not a dialog action
        "draftIsOpaque", // never take over an opaque paste chip as literal text
        "extractInputDraft", // the stranded-draft preview + the type-then-verify half
        "extractStatusLines", // the statusline the strip peels off the mirror
        "newlineSubmits", // the pre-flight's refusal of a multi-line message
      ].toSorted(),
    );
  });
});

// The reply pre-flight's half of Tier 1, asserted directly rather than only through the conformance
// suite's menu leg (which this adapter never reaches, having no menu fixtures). `composerReady` is
// what makes reply-action.ts refuse to type into a modal; a wrong `true` here puts the user's message
// into a picker, and a wrong `false` blocks every reply on a live input.
const ANSWER_EDITOR_FIXTURES = [
  "omp--answer-editor-empty.txt",
  "omp--answer-editor-long.txt",
  "omp--answer-editor-note.txt",
  "omp--answer-editor-typed.txt",
  "omp--answer-editor-wrapped.txt",
  // omp 18.4.10's note editor, opened with `n` on Green: the same prompt-style box.
  "omp--v18-4-ask-note-editor.txt",
];
const COMPOSER_FIXTURES = [
  "omp--done--tool-result.txt",
  "omp--done.txt",
  "omp--draft-ghost-suggestion.txt",
  "omp--draft-ghost-suggestion-busy.txt",
  "omp--draft-single.txt",
  "omp--draft-wrapped.txt",
  "omp--fresh-agents-hint.txt",
  "omp--fresh-effort-hint.txt",
  "omp--fresh-idle.txt",
  "omp--menu-dismissed.txt",
  "omp--slash-palette--filtered.txt",
  "omp--slash-palette.txt",
  "omp--working.txt",
  "omp--v18-4-composer-idle.txt",
  "omp--v18-4-borderless-draft.txt",
  "omp--v18-4-borderless-idle.txt",
  "omp--v18-4-borderless-wrapped.txt",
  "omp--v18-4-claude-draft.txt",
  "omp--v18-4-claude-idle.txt",
  "omp--v18-4-claude-titled-draft.txt",
  "omp--v18-4-claude-titled.txt",
  "omp--v18-4-claude-wrapped.txt",
  "omp--v18-pi-effort-hint.txt",
  "omp--v18-rule-effort-hint.txt",
  "omp--v18-rule-draft.txt",
  "omp--v18-rule-idle.txt",
  "omp--v18-rule-wrapped.txt",
  // The pi-shaped composer with its slash palette up (omp 18.8, 2026-10-07): the palette replaces
  // the status row, and the typed command is verifiable on the filter row — which is the whole
  // reason a `/…` send can complete at all on this shape (pi-shape.ts).
  "omp--v18-8-slash-palette.txt",
  "omp--v18-8-slash-palette-w48.txt",
];

describe("composerReady — the gate the reply path pre-flights on", () => {
  const ready = new Set([...COMPOSER_FIXTURES, ...ANSWER_EDITOR_FIXTURES]);
  it.each(allOmpFixtures.filter((f) => !ready.has(f)))(
    "%s: a modal owns the keyboard ⇒ false",
    (name) => {
      expect(ompAdapter.composerReady!(fixtureLines(name))).toBe(false);
    },
  );

  it.each(COMPOSER_FIXTURES)("%s: the composer is on screen ⇒ true", (name) => {
    expect(ompAdapter.composerReady!(fixtureLines(name))).toBe(true);
    expect(ompAdapter.newlineSubmits!(fixtureLines(name))).toBe(false);
  });

  it.each(ANSWER_EDITOR_FIXTURES)("%s: the answer editor is on screen ⇒ true, and a newline submits it", (name) => {
    expect(ompAdapter.composerReady!(fixtureLines(name))).toBe(true);
    expect(ompAdapter.newlineSubmits!(fixtureLines(name))).toBe(true);
  });

  it("reads the answer as the draft, so the reply guard can verify it", () => {
    const draft = (name: string) => ompAdapter.extractInputDraft(fixtureLines(name));
    expect(draft("omp--answer-editor-empty.txt")).toBeNull();
    expect(draft("omp--v18-4-ask-note-editor.txt")).toBeNull();
    expect(draft("omp--answer-editor-typed.txt")).toBe("a deep teal, like the sea at dusk");
    expect(draft("omp--answer-editor-note.txt")).toBe("only if it is a warm blue");
    expect(draft("omp--answer-editor-wrapped.txt")).toBe(
      "a deep teal, like the sea at dusk — and here is a much longer continuation so that the custom answer editor has to soft wrap this text onto a second and maybe a third row of the box to see how it folds",
    );
    expect(draft("omp--answer-editor-long.txt")).toBe(
      Array.from({ length: 700 }, (_, i) => `word${String(i).padStart(4, "0")}`).join(" "),
    );
  });
});

// omp 18.4 paints a right-aligned key hint (`⇧⇥ to change thinking effort`, or `← ← to see N running
// agents` while a background subagent runs) into an EMPTY editor, in every composer shape. It is not in the input buffer; reading it as a draft put "Draft in
// terminal" on every fresh session and made the pre-clear sweep erase an empty line.
describe("the empty-editor key hint is not a draft", () => {
  it.each([
    "omp--fresh-effort-hint.txt",
    "omp--fresh-agents-hint.txt",
    "omp--v18-rule-effort-hint.txt",
    "omp--v18-pi-effort-hint.txt",
    "omp--v18-4-claude-idle.txt",
    "omp--v18-4-claude-titled.txt",
    "omp--v18-4-borderless-idle.txt",
  ])(
    "%s: composer on screen, no draft",
    (name) => {
      const lines = fixtureLines(name);
      expect(ompAdapter.composerReady!(lines)).toBe(true);
      expect(ompAdapter.extractInputDraft(lines)).toBeNull();
    },
  );
});

describe("OMP 18 rule composer", () => {
  it("recognizes an empty rule composer through the adapter", () => {
    const lines = fixtureLines("omp--v18-rule-idle.txt");

    expect(ompAdapter.composerReady!(lines)).toBe(true);
    expect(ompAdapter.extractInputDraft(lines)).toBeNull();
    expect(ompAdapter.composerPrompt!(lines)).toBe("❯");

    const status = ompAdapter.extractStatusLines(lines);
    expect(status).toHaveLength(1);
    expect(status[0]).toBe(lines.at(-1));
    expect(status[0]!.segments.length).toBeGreaterThan(1);

    const blocks = ompAdapter.buildBlocks(lines);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.kind).toBe("raw");
    if (blocks[0]!.kind === "raw") {
      const rawText = blocks[0]!.lines.map(lineText).join("\n");
      expect(rawText).not.toContain("❯");
      expect(rawText).not.toContain(lineText(status[0]!));
    }
  });

  it("extracts a single-line rule draft for guarded reply verification", () => {
    const lines = fixtureLines("omp--v18-rule-draft.txt");

    expect(ompAdapter.composerReady!(lines)).toBe(true);
    expect(ompAdapter.extractInputDraft(lines)).toBe("COLLIE_RULE_DRAFT");
    expect(ompAdapter.composerPrompt!(lines)).toBe("❯ COLLIE_RULE_DRAFT");
  });

  it("folds wrapped rule rows and excludes the styled inline suggestion", () => {
    const lines = fixtureLines("omp--v18-rule-wrapped.txt");
    const draft =
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho " +
      "sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta eta theta iota " +
      "kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega";

    expect(ompAdapter.composerReady!(lines)).toBe(true);
    expect(ompAdapter.extractInputDraft(lines)).toBe(draft);
    expect(ompAdapter.composerPrompt!(lines)).toBe(
      [
        "❯ alpha beta gamma delta epsilon zeta eta theta iota kappa",
        "  lambda mu nu xi omicron pi rho sigma tau upsilon phi chi",
        "  psi omega alpha beta gamma delta epsilon zeta eta theta",
        "  iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon",
        "  phi chi psi omegas",
      ].join("\n"),
    );
  });

  it("declines once any ordinary output appears below the captured tail", () => {
    const scrolled = [
      ...fixtureLines("omp--v18-rule-draft.txt"),
      ...splitLines(parseAnsi("ordinary output after the composer")),
    ];
    expect(locateRuleComposer(scrolled)).toBeNull();
  });

  it("accepts at most 100 continuation rows", () => {
    const prefix = ["transcript", "────", "❯ head"];
    const continuationRows = Array.from({ length: 100 }, (_, index) => `  row-${index}`);
    const suffix = ["", " π · status"];
    const atCap = splitLines(parseAnsi([...prefix, ...continuationRows, ...suffix].join("\n")));
    const overCap = splitLines(
      parseAnsi([...prefix, ...continuationRows, "  row-100", ...suffix].join("\n")),
    );

    expect(locateRuleComposer(atCap)).not.toBeNull();
    expect(locateRuleComposer(overCap)).toBeNull();
  });

  it.each(allOmpModalFixtures)(
    "%s: the rule scanner rejects an OMP modal fixture",
    (name) => {
      expect(locateRuleComposer(fixtureLines(name))).toBeNull();
    },
  );

  it.each(allForeignFixtures)("%s: the rule scanner rejects a foreign fixture", (name) => {
    expect(locateRuleComposer(fixtureLines(name))).toBeNull();
  });
});

// OMP 18.4's `composer.shape: claude` and `composer.shape: borderless` (issue #343). Neither had a
// locator, so `hasComposer` / `composerReady` / `extractInputDraft` read false / false / null and every
// Send asked "Type anyway?". Captured on omp v18.4.10, one sandbox pane per shape, no model configured.
describe("OMP 18.4 claude and borderless composers", () => {
  const WRAP_WORDS = [
    "COLLIE_SHAPE_WRAP", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
    "nineteen", "twenty", "twentyone", "twentytwo", "twentythree", "twentyfour", "twentyfive",
    "twentysix", "twentyseven", "twentyeight", "twentynine", "thirty", "thirtyone", "thirtytwo",
    "thirtythree", "thirtyfour", "thirtyfive", "END",
  ];
  const WRAPPED_DRAFT = WRAP_WORDS.join(" ");
  const WRAPPED_PROMPT = [
    "❯ COLLIE_SHAPE_WRAP one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen",
    "  seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix twentyseven",
    "  twentyeight twentynine thirty thirtyone thirtytwo thirtythree thirtyfour thirtyfive END",
  ].join("\n");

  // A synthetic tail: `body` rows, then a styled status row (lone separator segments, like the real
  // renderer's), so each negative case changes exactly one thing about a known-good frame.
  const STATUS = " \x1b[38;2;107;114;128mπ\x1b[0m \x1b[38;2;42;48;56m·\x1b[0m \x1b[38;2;0;180;255mmodel\x1b[0m";
  const RULE = "\x1b[38;2;0;180;255m" + "─".repeat(40) + "\x1b[0m";
  const frame = (...rows: string[]) => splitLines(parseAnsi(rows.join("\n")));

  it.each(CLAUDE_COMPOSER_FIXTURES)("%s: the claude locator reads the composer, no other locator does", (name) => {
    const lines = fixtureLines(name);
    const composer = locateClaudeComposer(lines);
    expect(composer).not.toBeNull();
    expect(composer!.style).toBe("claude");
    expect(composer!.status).toBe(lines.length - 1);
    expect(lineText(lines[composer!.top!]!)).toMatch(/^─/);
    expect(locateBorderlessComposer(lines)).toBeNull();
    expect(locateRuleComposer(lines)).toBeNull();
    expect(locatePiComposer(lines)).toBeNull();
    expect(hasBoxComposer(lines)).toBe(false);
    expect(ompAdapter.composerReady!(lines)).toBe(true);
  });

  it.each(BORDERLESS_COMPOSER_FIXTURES)("%s: the borderless locator reads the composer, no other locator does", (name) => {
    const lines = fixtureLines(name);
    const composer = locateBorderlessComposer(lines);
    expect(composer).not.toBeNull();
    expect(composer!.style).toBe("borderless");
    expect(composer!.status).toBe(lines.length - 1);
    expect(locateClaudeComposer(lines)).toBeNull();
    expect(locateRuleComposer(lines)).toBeNull();
    expect(locatePiComposer(lines)).toBeNull();
    expect(hasBoxComposer(lines)).toBe(false);
    expect(ompAdapter.composerReady!(lines)).toBe(true);
  });

  it("reads an empty claude composer, the title chip and the key hint included", () => {
    for (const name of ["omp--v18-4-claude-idle.txt", "omp--v18-4-claude-titled.txt"]) {
      const lines = fixtureLines(name);
      expect(ompAdapter.extractInputDraft(lines)).toBeNull();
      expect(ompAdapter.composerPrompt!(lines)).toMatch(/^❯ +⇧⇥ to change thinking effort$/);
      const status = ompAdapter.extractStatusLines(lines);
      expect(status).toHaveLength(1);
      expect(status[0]).toBe(lines.at(-1));
      const blocks = ompAdapter.buildBlocks(lines);
      expect(blocks.map((b) => b.kind)).toEqual(["raw"]);
      if (blocks[0]!.kind === "raw") {
        const rawText = blocks[0]!.lines.map(lineText).join("\n");
        expect(rawText).not.toContain("❯");
        expect(rawText).not.toContain(lineText(status[0]!).trim());
      }
    }
    // The title is the one thing that tells the two captures apart, and it lives in the top rule.
    expect(lineText(fixtureLines("omp--v18-4-claude-titled.txt").at(-4)!)).toContain("Shape lab title");
  });

  it("reads claude drafts back exactly, wrapped rows folded with single spaces", () => {
    const draft = (name: string) => ompAdapter.extractInputDraft(fixtureLines(name));
    expect(draft("omp--v18-4-claude-draft.txt")).toBe("COLLIE_CLAUDE_SHAPE_DRAFT");
    expect(draft("omp--v18-4-claude-titled-draft.txt")).toBe("COLLIE_TITLED_DRAFT");
    expect(draft("omp--v18-4-claude-wrapped.txt")).toBe(WRAPPED_DRAFT);
    expect(ompAdapter.composerPrompt!(fixtureLines("omp--v18-4-claude-draft.txt"))).toBe(
      "❯ COLLIE_CLAUDE_SHAPE_DRAFT",
    );
    expect(ompAdapter.composerPrompt!(fixtureLines("omp--v18-4-claude-wrapped.txt"))).toBe(WRAPPED_PROMPT);
  });

  it("reads an empty borderless composer", () => {
    const lines = fixtureLines("omp--v18-4-borderless-idle.txt");
    expect(ompAdapter.extractInputDraft(lines)).toBeNull();
    expect(ompAdapter.composerPrompt!(lines)).toMatch(/^❯ +⇧⇥ to change thinking effort$/);
    const status = ompAdapter.extractStatusLines(lines);
    expect(status).toHaveLength(1);
    expect(status[0]).toBe(lines.at(-1));
    const blocks = ompAdapter.buildBlocks(lines);
    expect(blocks.map((b) => b.kind)).toEqual(["raw"]);
    if (blocks[0]!.kind === "raw") {
      const rawText = blocks[0]!.lines.map(lineText).join("\n");
      expect(rawText).not.toContain("❯");
      expect(rawText).not.toContain(lineText(status[0]!).trim());
    }
  });

  it("reads borderless drafts back exactly, wrapped rows folded with single spaces", () => {
    const draft = (name: string) => ompAdapter.extractInputDraft(fixtureLines(name));
    expect(draft("omp--v18-4-borderless-draft.txt")).toBe("COLLIE_BORDERLESS_DRAFT");
    expect(draft("omp--v18-4-borderless-wrapped.txt")).toBe(WRAPPED_DRAFT);
    expect(ompAdapter.composerPrompt!(fixtureLines("omp--v18-4-borderless-draft.txt"))).toBe(
      "❯ COLLIE_BORDERLESS_DRAFT",
    );
    expect(ompAdapter.composerPrompt!(fixtureLines("omp--v18-4-borderless-wrapped.txt"))).toBe(WRAPPED_PROMPT);
  });

  // The rejection cohorts: both locators decline every omp modal and composer of another shape, and
  // every foreign capture, so the shapes cannot steal one another's panes.
  const OTHER_OMP = allOmpFixtures.filter((name) => !GLYPH_COMPOSER_FIXTURES.includes(name));
  it.each([...OTHER_OMP, ...allForeignFixtures])("%s: neither new locator claims it", (name) => {
    const lines = fixtureLines(name);
    expect(locateClaudeComposer(lines)).toBeNull();
    expect(locateBorderlessComposer(lines)).toBeNull();
    expect(locateGlyphComposer(lines)).toBeNull();
  });

  it("keeps the shapes apart: each locator declines the other shape's captures", () => {
    for (const name of BORDERLESS_COMPOSER_FIXTURES) expect(locateClaudeComposer(fixtureLines(name))).toBeNull();
    for (const name of CLAUDE_COMPOSER_FIXTURES) expect(locateBorderlessComposer(fixtureLines(name))).toBeNull();
  });

  it("the claude locator needs the status row directly under the bottom rule", () => {
    const good = frame("transcript", "", RULE, "❯ hello", RULE, STATUS);
    expect(locateClaudeComposer(good)).not.toBeNull();
    expect(locateClaudeComposer(frame("transcript", "", RULE, "❯ hello", RULE, "", STATUS))).toBeNull();
    expect(locateClaudeComposer(frame("transcript", "", RULE, "❯ hello", RULE, STATUS, "output below"))).toBeNull();
    expect(locateClaudeComposer(frame("transcript", "", RULE, "❯ hello", RULE, " plain text no separator"))).toBeNull();
    expect(locateClaudeComposer(frame("transcript", "", RULE, "❯ hello", "──", STATUS))).toBeNull();
  });

  it("the claude locator needs a top rule in the bottom rule's colour right above the prompt", () => {
    const otherRule = "\x1b[38;2;255;179;71m" + "─".repeat(40) + "\x1b[0m";
    expect(locateClaudeComposer(frame("transcript", otherRule, "❯ hello", RULE, STATUS))).toBeNull();
    expect(locateClaudeComposer(frame("transcript", "", "❯ hello", RULE, STATUS))).toBeNull();
    expect(locateClaudeComposer(frame("transcript", RULE, "", "❯ hello", RULE, STATUS))).toBeNull();
  });

  // issue 343, 18.3.0 form by description: no capture exists. The reporter's paste shows the titled top
  // rule with no closing rule glyph after the title and a bottom rule shorter than the top. The lines
  // are the 18.4.10 `claude-titled-draft` capture with exactly those two edits made on the raw bytes.
  describe("issue 343, 18.3.0 form by description", () => {
    const CLOSING_GLYPH = "\x1b[38;2;119;245;108m─\x1b[0m\r";
    const from18410 = readFileSync(join(PANES_DIR, "omp--v18-4-claude-titled-draft.txt"), "utf8").split("\n");
    const topIndex = from18410.findIndex((row) => row.includes("Shape lab title") && row.includes("──"));
    const bottomIndex = topIndex + 2;
    const form1830 = (mutate?: (rows: string[]) => void) => {
      const rows = [...from18410];
      expect(rows[topIndex]!.endsWith(CLOSING_GLYPH)).toBe(true);
      rows[topIndex] = rows[topIndex]!.slice(0, -CLOSING_GLYPH.length) + "\r";
      rows[bottomIndex] = "\x1b[0m\x1b[38;2;119;245;108m" + "─".repeat(40) + "\x1b[0m\r";
      mutate?.(rows);
      return splitLines(parseAnsi(rows.join("\n")));
    };

    it("locates as claude and reads the draft with no closing glyph and a 40-glyph bottom rule", () => {
      const lines = form1830();
      expect(lineText(lines[topIndex]!).trimEnd()).toMatch(/^─+ Shape lab title$/);
      expect(lineText(lines[bottomIndex]!).trimEnd()).toBe("─".repeat(40));
      const composer = locateClaudeComposer(lines);
      expect(composer).not.toBeNull();
      expect(composer!.style).toBe("claude");
      expect(ompAdapter.extractInputDraft(lines)).toBe("COLLIE_TITLED_DRAFT");
    });

    it("declines a top row with fewer than 8 rule glyphs before its text", () => {
      const lines = form1830((rows) => {
        rows[topIndex] = "\x1b[38;2;119;245;108m" + "─".repeat(7) + " Shape lab title\x1b[0m\r";
      });
      expect(locateClaudeComposer(lines)).toBeNull();
    });

    it("declines a top row that is plain text", () => {
      const lines = form1830((rows) => {
        rows[topIndex] = "\x1b[38;2;119;245;108mShape lab title\x1b[0m\r";
      });
      expect(locateClaudeComposer(lines)).toBeNull();
    });
  });

  it("the claude locator folds a draft with a blank line and caps the draft rows", () => {
    const lines = frame("transcript", RULE, "❯ first", "  ", "  third", RULE, STATUS);
    expect(locateClaudeComposer(lines)).not.toBeNull();
    expect(ompAdapter.extractInputDraft(lines)).toBe("first third");
    expect(ompAdapter.composerPrompt!(lines)).toBe("❯ first\n\n  third");
    const rows = Array.from({ length: 100 }, (_, i) => `  row-${i}`);
    expect(locateClaudeComposer(frame("transcript", RULE, "❯ head", ...rows, RULE, STATUS))).not.toBeNull();
    expect(locateClaudeComposer(frame("transcript", RULE, "❯ head", ...rows, "  row-100", RULE, STATUS))).toBeNull();
  });

  it("the borderless locator needs every piece of the tail", () => {
    expect(locateBorderlessComposer(frame("transcript", "", "❯ hello", STATUS))).not.toBeNull();
    expect(ompAdapter.extractInputDraft(frame("transcript", "", "❯ hello", "  more", STATUS))).toBe("hello more");
    // a blank row between the prompt and the status row is the `rule` shape's tail, never this one
    expect(locateBorderlessComposer(frame("transcript", "❯ hello", "", STATUS))).toBeNull();
    // anything below the status row
    expect(locateBorderlessComposer(frame("❯ hello", STATUS, "output below"))).toBeNull();
    // a status row without styled separator segments, or with the wrong indent
    expect(locateBorderlessComposer(frame("❯ hello", " π · model"))).toBeNull();
    expect(locateBorderlessComposer(frame("❯ hello", "  " + STATUS.trimStart()))).toBeNull();
    // a shell prompt with a command typed is not a composer
    expect(locateBorderlessComposer(frame("❯ ls -la", "total 0"))).toBeNull();
    // a transcript row above the status row that is not the prompt or an indented continuation
    expect(locateBorderlessComposer(frame("❯ hello", "output", STATUS))).toBeNull();
    // a box row in the way
    expect(locateBorderlessComposer(frame("❯ hello", "│ box │", STATUS))).toBeNull();
    // a modal's key-hint footer at the tail
    expect(
      locateBorderlessComposer(frame("❯ hello", "│ ⏎ select · ↑/↓ move · ⎋ cancel │", "╰──────────────────╯", STATUS)),
    ).toBeNull();
  });

  it("the borderless locator declines a pointer row of a picker and caps the draft rows", () => {
    const picker = frame("  Resume Session", "❯ first session", "  2 minutes ago", "", "  [Enter select · Esc cancel]");
    expect(locateBorderlessComposer(picker)).toBeNull();
    const rows = Array.from({ length: 100 }, (_, i) => `  row-${i}`);
    expect(locateBorderlessComposer(frame("transcript", "❯ head", ...rows, STATUS))).not.toBeNull();
    expect(locateBorderlessComposer(frame("transcript", "❯ head", ...rows, "  row-100", STATUS))).toBeNull();
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
    // omp 18.4 prints glyph keycaps (`⏎`, `⌦/⌫`, `⇥`, `⎋`), which the shared grammar does not know either.
    { fixture: "omp--v18-4-menu-model.txt", row: 57 },
    { fixture: "omp--v18-4-menu-settings.txt", row: 57 },
    { fixture: "omp--v18-4-resume.txt", row: 56 },
    { fixture: "omp--v18-4-resume-all-projects.txt", row: 56 },
    // The Ask tool's 18.4.10 footers: the single-select one ask.ts reads with its own exact comparison,
    // and the multi-select one nothing lifts.
    { fixture: "omp--v18-4-ask-single.txt", row: 208 },
    { fixture: "omp--v18-4-ask-multi.txt", row: 282 },
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

describe("omp mobile display cleanup", () => {
  it("marks light fills and leaves dark diffs alone", () => {
    const esc = String.fromCharCode(27);
    const light = `${esc}[48;2;250;250;250mlight card${esc}[0m`;
    const dark = `${esc}[48;2;15;18;22mdark body${esc}[0m`;
    const diff = `${esc}[48;2;33;58;43m+ semantic diff${esc}[0m`;
    const [lightLine, darkLine, diffLine] = decorateOmpDisplay(
      splitLines(parseAnsi(`${light}\n${dark}\n${diff}`)),
    );

    expect(lightLine!.segments[0]!.mobileTransparentBg).toBe(true);
    expect(darkLine!.segments[0]!.bg).toBe("rgb(15,18,22)");
    expect(darkLine!.segments[0]!.mobileTransparentBg).toBeUndefined();
    expect(diffLine!.segments[0]!.bg).toBe("rgb(33,58,43)");
    expect(diffLine!.segments[0]!.mobileTransparentBg).toBeUndefined();
  });

  it("does not change visible text", () => {
    const esc = String.fromCharCode(27);
    const lines = splitLines(parseAnsi(`${esc}[48;2;250;250;250mcard${esc}[0m`));
    expect(decorateOmpDisplay(lines).map(lineText)).toEqual(lines.map(lineText));
  });

  it("returns the same array when nothing is light", () => {
    const lines = splitLines(parseAnsi("plain text"));
    expect(decorateOmpDisplay(lines)).toBe(lines);
  });

  it("ompBuildBlocks marks the fill on the raw block", () => {
    const esc = String.fromCharCode(27);
    const [block] = ompAdapter.buildBlocks(
      splitLines(parseAnsi(`${esc}[48;2;250;250;250mlight card${esc}[0m`)),
    );
    expect(block!.kind).toBe("raw");
    if (block!.kind !== "raw") return;
    expect(block.lines.some((line) => line.segments.some((segment) => segment.mobileTransparentBg))).toBe(
      true,
    );
  });
});
