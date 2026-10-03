import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { ompAdapter } from "./omp";
import { lineText, rstrip } from "./omp/markers";
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
// `omp--menu-dismissed.txt` matches this prefix and is a COMPOSER capture, not a modal, and so is
// `omp--v18-4-composer-idle.txt`, the one `omp--v18-4-*` capture that is not a modal.
// `omp--tree.txt` is a modal under a name that fits none of those prefixes, so it is named outright.
const allOmpModalFixtures = allOmpFixtures.filter(
  (name) =>
    name.startsWith("omp--menu-") ||
    name.startsWith("omp--select-") ||
    name.startsWith("omp--approval-") ||
    (name.startsWith("omp--v18-4-") && name !== "omp--v18-4-composer-idle.txt") ||
    name === "omp--tree.txt",
);

// The screens this adapter lifts. The `/resume` captures that list at least one session, seven of the
// eight (`omp--v18-4-resume-nomatch.txt` has no rows and stays raw, below), the Ask tool's
// one-question single-select dialog in all three keycap dialects: text (17.2.12), Nerd Font (18.4.4)
// and glyph (18.4.10), and the tool-approval dialog in both captured presets: `nerd` with text keycaps
// (18.1.17, `bash` and `write`, the latter in both selection states) and `unicode` with glyph keycaps
// (18.4.10, `bash` and `write` in both selection states, and a fourteen-row `write`), and the compact
// model picker's session state (18.4.10, twenty-three captures: the pointer moved, wrapped and at both
// window edges, searches, over-context and truncated rows, role chips, and windows of 16, 15 and 5 rows).
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
  "omp--approval-bash.txt",
  "omp--approval-write--deny.txt",
  "omp--approval-write.txt",
  "omp--v18-4-approval-bash-moved.txt",
  "omp--v18-4-approval-bash.txt",
  "omp--v18-4-approval-write-long.txt",
  "omp--v18-4-approval-write-moved.txt",
  "omp--v18-4-approval-write.txt",
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
]);

// Every omp screen this adapter DECLINES, which is every screen IN THIS CORPUS bar the lifted resume
// pickers, Ask single-selects, tool approvals and model pickers, not every screen omp can draw. These
// are NOT "neutral output" in the plain sense: nineteen of them are live modals with the keyboard, and
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
  "omp--v18-4-switch-clipped.txt",
  "omp--v18-4-switch-nerd.txt",
  "omp--v18-4-switch-nomatch.txt",
  "omp--v18-4-switch-quick-roles.txt",
  "omp--v18-4-switch-task.txt",
]);

// The own cohort is the forty-four lifted captures, so every conformance leg that needs one runs on them
// for real: each lifts, none lifts once output scrolls below it, every key is send_keys-valid, and each
// model signs itself and fails the committing check when a row of it changes. The neutral cohort still
// carries the leg that matters most here: raw-only on the other 44 omp captures and on every foreign
// harness capture.
const ownFixtures = allOmpFixtures.filter((f) => LIFTED.has(f));
const neutralFixtures = allOmpFixtures.filter((f) => DECLINED.has(f));

describeAdapterConformance(ompAdapter, {
  ownFixtures,
  foreignFixtures: allForeignFixtures,
  neutralFixtures,
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
    "omp--v18-pi-effort-hint.txt",
    "omp--v18-rule-draft.txt",
    "omp--v18-rule-effort-hint.txt",
    "omp--v18-rule-idle.txt",
    "omp--v18-rule-wrapped.txt",
    "omp--working.txt",
  ];

  it("is exactly the 88 captures this adapter was developed against", () => {
    expect(allOmpFixtures).toEqual(PINNED);
  });

  it("lifts the forty-four `/resume`, Ask single-select, approval and model picker captures and declines the other forty-four", () => {
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
  "omp--v18-pi-effort-hint.txt",
  "omp--v18-rule-effort-hint.txt",
  "omp--v18-rule-draft.txt",
  "omp--v18-rule-idle.txt",
  "omp--v18-rule-wrapped.txt",
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
