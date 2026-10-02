import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseAnsi } from "../ansi";
import { lineText, splitLines, type Block, type StyledLine } from "../blocks";
import { buildBlocks, withUnreadDialog } from "./index";
import { museAdapter } from "./muse";
import { adapterFor } from "./registry";
import type { HarnessAdapter } from "./types";

// The unread-dialog card (.adr/0053): the ONE control offered over a screen every grammar declined,
// carrying the adapter's DECLARED cancel key. Everything here is about the post-pass — what makes a
// card, what must never make one, and the invariant that no adapter can produce the kind itself.

const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");
const FIXTURES = readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt"));

const linesOf = (text: string): StyledLine[] => splitLines(parseAnsi(text));
const fixtureLines = (name: string): StyledLine[] =>
  linesOf(readFileSync(join(PANES_DIR, name), "utf8"));

/** Every registered agent string. agy and antigravity are two registrations of one adapter. */
const AGENTS = ["claude", "codex", "grok", "omp", "agy", "antigravity", "muse", "opencode"] as const;

/** What the post-pass answers for `agent` on `lines` — the exact composition the three call sites
 *  use (harness/index.ts buildBlocks, agent-chat's dialogPresent, dialog-guard's dialogDetector). */
function pass(agent: string, lines: StyledLine[]): Block[] {
  const adapter = adapterFor(agent)!;
  return withUnreadDialog(adapter, lines, adapter.buildBlocks(lines));
}

const cardOf = (blocks: Block[]) => blocks.find((b) => b.kind === "unread-dialog") ?? null;

describe("the cancel key each adapter declares", () => {
  // The table from .adr/0053, read back off the registry. grok is the divergence the whole
  // declaration exists for: on grok, Escape opens the scrollback view and ctrl+c is the cancel.
  it.each([
    ["claude", "Escape"],
    ["codex", "Escape"],
    ["muse", "Escape"],
    ["agy", "Escape"],
    ["antigravity", "Escape"],
    ["opencode", "Escape"],
    ["omp", "Escape"],
    ["grok", "ctrl+c"],
  ])("%s declares %s", (agent, key) => {
    expect(adapterFor(agent)!.cancelKey).toBe(key);
  });

  it("omp declares its key only together with positive modal evidence (.adr/0076)", () => {
    // omp declined a cancelKey in ADR 0053: its composer scanner has a total, permanent false-negative
    // mode (omp/chrome.ts), so `composerReady` is false forever on a pane with one ZWJ emoji in its
    // statusline template, and a card gated on that alone would paint itself over a live composer.
    // The declaration is therefore only safe with `modalOnScreen`, and the two travel together.
    expect(adapterFor("omp")!.modalOnScreen).toBeTypeOf("function");
  });
});

describe("a real unread modal gets the card", () => {
  // One capture per DECLARING adapter whose own grammars all decline it while `composerReady`
  // answers a definite false. agy/antigravity have no such capture in the corpus — every AGY dialog
  // fixture is one its prompt-select grammar reads — so they are covered by a hand-built screen.
  it.each([
    ["claude", "claude-lab--menu-status-screen--w82.txt", "Escape"],
    ["codex", "codex--ask-notes-focused.txt", "Escape"],
    ["grok", "grok--ask-multi.txt", "ctrl+c"],
    ["muse", "muse--ask-color-notes-open.txt", "Escape"],
    ["opencode", "oc--agents-picker.txt", "Escape"],
    ["omp", "omp--select-menu.txt", "Escape"],
    ["omp", "omp--v18-4-menu-model.txt", "Escape"],
  ])("%s gets the card on %s", (agent, fixture, key) => {
    const lines = fixtureLines(fixture);
    const blocks = pass(agent, lines);
    expect(blocks.map((b) => b.kind)).toEqual(["unread-dialog"]);
    const card = cardOf(blocks)!;
    expect(card.kind === "unread-dialog" && card.cancel).toMatchObject({ key, agent });
    expect(card.kind === "unread-dialog" && card.cancel.signature).not.toBe("");
    // The region is the WHOLE mirror: the card understands nothing, so nothing may be hidden. It is
    // the blocks' OWN lines rather than the input array, because those are what the mirror would
    // have drawn — the adapter's chrome strip has run, and on a native-mirror agent so have the
    // display passes (see `decorateNativeMirror`).
    expect(card.lines).toEqual(adapterFor(agent)!.buildBlocks(lines).flatMap((b) => b.lines));
    expect(card.lines.length).toBeGreaterThan(0);
  });

  it.each([["agy"], ["antigravity"]])(
    "%s gets the card on a hand-built modal (no corpus capture lands raw-only)",
    (agent) => {
      // AGY's composer is ALWAYS boxed (agy/chrome.ts), so a screen with no box is one it cannot
      // type into; no numbered options, so its prompt-select grammar declines.
      const lines = linesOf(
        ["Update available", "", "  A newer version is ready to install.", "", "  esc to cancel"].join(
          "\n",
        ),
      );
      const blocks = pass(agent, lines);
      expect(blocks.map((b) => b.kind)).toEqual(["unread-dialog"]);
      expect(cardOf(blocks)).toMatchObject({ cancel: { key: "Escape", agent } });
    },
  );
});

describe("a screen that does not get the card", () => {
  it("does not get the card when the screen is blank", () => {
    const lines = linesOf("\n   \n\n");
    expect(adapterFor("claude")!.composerReady!(lines)).toBe(false);
    expect(pass("claude", lines).every((b) => b.kind === "raw")).toBe(true);
  });

  it("does not get the card on a first-run trust screen, which a grammar reads", () => {
    // A splash the adapter UNDERSTANDS is not an unread dialog: its blocks are not raw-only, so the
    // first condition already fails.
    const blocks = pass("claude", fixtureLines("claude--trust-prompt.txt"));
    expect(blocks.some((b) => b.kind !== "raw" && b.kind !== "unread-dialog")).toBe(true);
    expect(cardOf(blocks)).toBeNull();
  });

  it("does not get the card while composerReady is true", () => {
    const lines = fixtureLines("claude--fresh-idle.txt");
    expect(adapterFor("claude")!.composerReady!(lines)).toBe(true);
    expect(cardOf(pass("claude", lines))).toBeNull();
  });

  it("does not get the card on omp's `/tree`, which prints no way out", () => {
    // Both of the other conditions hold: the screen is raw and `composerReady` says false. What is
    // missing is omp's positive modal evidence, because neither tree capture names a key that closes
    // it (omp/modal.ts). No evidence, no card, and the raw mirror is what the operator already had.
    for (const name of ["omp--tree.txt", "omp--v18-4-tree.txt"]) {
      const lines = fixtureLines(name);
      const omp = adapterFor("omp")!;
      expect(omp.buildBlocks(lines).every((b) => b.kind === "raw"), name).toBe(true);
      expect(omp.composerReady!(lines), name).toBe(false);
      expect(cardOf(pass("omp", lines)), name).toBeNull();
    }
  });

  it("does not get the card on a live omp composer even when composerReady cannot find it", () => {
    // The failure ADR 0053 declined omp for: a scanner that answers a definite false on a healthy
    // pane. Forced here with an adapter whose `composerReady` is always false. The composer screens
    // print no footer naming a way out, so `modalOnScreen` is what keeps the card off every one.
    const blind = { ...adapterFor("omp")!, composerReady: () => false };
    for (const name of FIXTURES.filter(
      (f) => f.startsWith("omp--") && adapterFor("omp")!.composerReady!(fixtureLines(f)),
    )) {
      const lines = fixtureLines(name);
      expect(cardOf(withUnreadDialog(blind, lines, blind.buildBlocks(lines))), name).toBeNull();
    }
  });

  it("does not get the card when the block list already holds a non-raw block", () => {
    const lines = fixtureLines("claude-lab--menu-status-screen--w82.txt");
    const claude = adapterFor("claude")!;
    const withPopup: Block[] = [
      { kind: "raw", lines },
      { kind: "autocomplete", autocomplete: { entries: [] }, lines },
    ];
    const out = withUnreadDialog(claude, lines, withPopup);
    expect(out).toBe(withPopup); // identity: the pass returns what it was handed
  });

  it("does not get the card when composerReady throws", () => {
    const throwing: HarnessAdapter = {
      ...adapterFor("claude")!,
      composerReady: () => {
        throw new Error("scanner blew up");
      },
    };
    const lines = fixtureLines("claude-lab--menu-status-screen--w82.txt");
    const blocks: Block[] = [{ kind: "raw", lines }];
    expect(withUnreadDialog(throwing, lines, blocks)).toBe(blocks);
  });
});

describe("the card never coexists with a live composer", () => {
  // The property, over every fixture of every DECLARING adapter: no card may stand on a screen the
  // adapter itself says is typeable.
  const declaring = AGENTS.filter((a) => adapterFor(a)!.cancelKey !== undefined);
  it.each(declaring.map((a) => [a]))("%s never coexists with composerReady === true", (agent) => {
    const own = ownFixtures(agent);
    expect(own.length).toBeGreaterThan(0);
    for (const name of own) {
      const lines = fixtureLines(name);
      if (cardOf(pass(agent, lines)) === null) continue;
      expect(adapterFor(agent)!.composerReady!(lines), `${agent} / ${name}`).toBe(false);
    }
  });
});

// ── THE ALLOW-LIST ──────────────────────────────────────────────────────────────────────────────
// Exactly which captures light the card up, pinned per adapter. Its job is DRIFT: widen any of the
// four conditions, or lose an input-box probe, and a screen joins this set silently. Two lists, and
// the split is the point.
//
//   MODALS      — the card is right here. Each is `dialogLive: true` in the capture-lab corpus or a
//                 dialog row in fixtures/panes/README.md.
//   NOT_MODALS  — the card is WRONG here, and it is wrong for a reason that predates it: the
//                 harness's own input-box probe answers `hasInputBox: false` on a screen whose box is
//                 LIVE. Every claude entry is a `knownStall` the corpus already records. The card
//                 inherits those gaps exactly; it does not create them, and the deliberate
//                 second-tap override (.adr/0053) is what keeps each one costing a tap rather than a
//                 locked composer. Shrink this list by fixing the probe, never by loosening the test.
const CARD_FIXTURES = {
  claude: {
    modals: [
      // corpus: a modal carrying its own typeable box; the locator's refusal is the safe read
      "claude-lab--agents-screen--w40.txt",
      "claude-lab--agents-screen--w82.txt",
      // corpus: `/status` screen, `Esc to cancel` footer — the M34 reference capture
      "claude-lab--menu-status-screen--w82.txt",
      // README: a multiSelect with the pointer on its "Type something" field. Declined on purpose,
      // since every toggle digit would be typed into the field, so the card is the honest answer.
      "claude--v2283-multiselect-type-something-focused.txt",
      // corpus: `/tasks` panel, `Esc to close` footer; raw only at 40 columns, where its
      // footer wraps and the menu grammar declines. The w82 capture lifts `menu`, so no card.
      "claude-lab--tasks-panel--w40.txt",
      // README: the `/effort` slider at 40 columns with `low` selected — no `▲` is drawn at all when
      // the marker would sit leftmost (Claude marks `low` by colour only), so the Effort grammar and
      // the generic menu both decline and the card is the honest answer.
      "claude--menu-effort-slider--w40-low.txt",
      // README: the `/plugin` "Add Marketplace" source field, opened from the Marketplaces tab. A text
      // field no grammar reads; the Marketplaces grammar does not claim it (no `Manage marketplaces`
      // title), so the card and its Escape are the way back to the tab.
      "claude--v2283-plugin-marketplaces-add-form--w82.txt",
    ],
    notModals: [
      // corpus, DELIBERATE: a statusline printing numbered rows is refused by ADR 0048 step 4
      // because it cannot be told from a live menu. Box live.
      "claude-lab--statusline-numbered-rows--w82.txt",
    ],
  },
  codex: {
    // README: notes composer focused inside the ask card — a real dialog
    modals: ["codex--ask-notes-focused.txt"],
    notModals: [],
  },
  grok: {
    // README: checkbox ask (`[ ]`), digit submits — a real dialog, and `blocked` on the reply path
    modals: ["grok--ask-multi.txt", "grok--ask-multi-checked.txt"],
    // README: a STRUCTURE fixture, "torn frame: square bubble, no composer". Not a live pane state:
    // it exists to pin that `locateComposer` returns null on a torn buffer. Kept visible here
    // because ctrl+c is grok's declared key and a torn frame is not a modal.
    notModals: ["grok--user-bubble.txt"],
  },
  muse: {
    // README: the per-question note input, open and typed — real dialogs
    modals: [
      "muse--ask-color-notes-open.txt",
      "muse--ask-color-notes-typed.txt",
      "muse--ask-toppings-notes-open.txt",
    ],
    notModals: [],
  },
  // No AGY capture in the corpus lands raw-only with no input box: every AGY dialog fixture is one
  // its own prompt-select grammar reads. An entry appearing here is news either way.
  agy: { modals: [], notModals: [] },
  antigravity: { modals: [], notModals: [] },
  // Every opencode picker: composerReady refuses it (the picker shape) and no grammar reads it, so
  // Escape, which closes a picker (probed on 1.18.32), is its way out. The permission steps and every
  // question dialog the grammars lift (single select, multi select, a many-question call, the Confirm
  // tab: question.ts and question-tabs.ts, issue 329) lift their buttons and get no card. What stays
  // raw is a real modal with `esc dismiss` in its footer, so it gets the card (ADR 0053): a
  // multi-select whose free-text input is open (a digit would be typed as text) and a list too long
  // for a digit (fourteen options).
  opencode: {
    modals: [
      "oc--agents-picker.txt",
      "oc--command-palette.txt",
      "oc--question--multi--free-text.txt",
      "oc--question--tall14.txt",
    ],
    notModals: [],
  },
  // Every omp modal that prints its own way out (omp/modal.ts) and that no grammar lifts: the Ask
  // tool's five screens, the `/model` and `/settings` pickers in both versions, the three tool-approval
  // screens and the `/resume` picker with no session to list. The `/resume` pickers that DO list a
  // session lift as a prompt-select and get no card, and `/tree` prints no way out, so neither is here.
  omp: {
    modals: [
      "omp--approval-bash.txt",
      "omp--approval-write--deny.txt",
      "omp--approval-write.txt",
      "omp--menu-model-moved.txt",
      "omp--menu-model.txt",
      "omp--menu-settings-moved.txt",
      "omp--menu-settings.txt",
      "omp--select-menu-moved.txt",
      "omp--select-menu-noted.txt",
      "omp--select-menu-other.txt",
      "omp--select-menu.txt",
      "omp--select-multi-checked.txt",
      "omp--select-multi-review.txt",
      "omp--select-multi.txt",
      "omp--v18-4-menu-model.txt",
      "omp--v18-4-menu-settings.txt",
      "omp--v18-4-resume-nomatch.txt",
    ],
    notModals: [],
  },
} satisfies Record<string, { modals: string[]; notModals: string[] }>;

/** This adapter's own captures, by file prefix. `claude-lab--` is Claude's capture lab, and
 *  opencode's corpus is filed as `oc--`. */
function ownFixtures(agent: string): string[] {
  const prefix = agent === "antigravity" ? "agy" : agent === "opencode" ? "oc" : agent;
  return FIXTURES.filter(
    (f) => f.split("--")[0] === prefix || (prefix === "claude" && f.startsWith("claude-lab--")),
  );
}

describe("the card appears on only these screens", () => {
  it.each(Object.keys(CARD_FIXTURES).map((a) => [a]))(
    "%s shows the card on only these screens",
    (agent) => {
      // SAFETY: `agent` comes from `Object.keys(CARD_FIXTURES)` in the `it.each` above, so it is a
      // key of that object by construction; the cast only restores what `Object.keys` erased.
      const { modals, notModals } = CARD_FIXTURES[agent as keyof typeof CARD_FIXTURES];
      const own = ownFixtures(agent);
      expect(own.length).toBeGreaterThan(0);
      const seen = own.filter((name) => cardOf(pass(agent, fixtureLines(name))) !== null);
      expect(seen.toSorted()).toEqual([...modals, ...notModals].toSorted());
    },
  );

  it("no grok screen showing the agent generating gets the card", () => {
    // ctrl+c is grok's declared key, so a card on a busy pane would offer to INTERRUPT the run.
    for (const name of ["grok--working.txt", "grok--done.txt", "grok--startup.txt"]) {
      expect(cardOf(pass("grok", fixtureLines(name))), name).toBeNull();
    }
  });
});

describe("the declaration tracks the harness", () => {
  // A drift tripwire, not a parse: the card reads NO footer, but the key it declares was read off
  // one. If a harness changes its cancel binding, the string below stops appearing on that dialog
  // and the declaration is re-examined rather than quietly going wrong.
  it.each([
    ["claude", "claude-lab--menu-status-screen--w82.txt", "Esc to cancel"],
    ["codex", "codex--ask-notes-focused.txt", "esc to"],
    ["muse", "muse--ask-color-notes-open.txt", "Esc to"],
    ["agy", "agy--permission-bash.txt", "esc to cancel"],
    ["antigravity", "agy--permission-bash.txt", "esc to cancel"],
    ["grok", "grok--permission-rm.txt", "Ctrl+c:cancel"],
    // omp prints the key in text keycaps up to 18.1 and in glyph keycaps from 18.4.
    ["omp", "omp--select-menu.txt", "Esc cancel"],
    ["omp", "omp--v18-4-menu-model.txt", "⎋ close"],
    // opencode's pickers print the key as a bare `esc` at the end of the title row.
    ["opencode", "oc--agents-picker.txt", "Select agent                                     esc"],
    // ...and its question dialog prints it as `esc dismiss` at the end of the footer.
    ["opencode", "oc--question--tall14.txt", "esc dismiss"],
  ])("%s: a real dialog's footer names the declared key", (agent, fixture, spelling) => {
    const screen = fixtureLines(fixture).map(lineText).join("\n");
    expect(screen).toContain(spelling);
    // …and the declaration is the key that spelling stands for.
    expect(adapterFor(agent)!.cancelKey).toBe(agent === "grok" ? "ctrl+c" : "Escape");
  });
});

describe("the card is built outside the adapter", () => {
  // Eight adapters over the whole corpus: the slowest assertion in the file, and the one that has to
  // stay exhaustive, so it gets its own budget rather than a sample.
  it("no adapter's own buildBlocks emits the kind, on any fixture", { timeout: 30_000 }, () => {
    for (const agent of AGENTS) {
      const adapter = adapterFor(agent)!;
      for (const name of FIXTURES) {
        const kinds = adapter.buildBlocks(fixtureLines(name)).map((b) => b.kind);
        expect(kinds, `${agent} / ${name}`).not.toContain("unread-dialog");
      }
    }
  });
});

describe("raw terminal mode", () => {
  it("shows no card: raw terminal means no adapter, so the pass cannot run", () => {
    const lines = fixtureLines("claude-lab--menu-status-screen--w82.txt");
    expect(buildBlocks(lines, { agent: "claude" }).map((b) => b.kind)).toEqual(["unread-dialog"]);
    expect(buildBlocks(lines, { agent: "claude", grammars: false }).map((b) => b.kind)).toEqual([
      "raw",
    ]);
  });
});

describe("the signature", () => {
  it("changes when the screen's tail changes, and survives blank padding", () => {
    const base = fixtureLines("claude-lab--menu-status-screen--w82.txt");
    const first = cardOf(pass("claude", base))!;
    const padded = [...base, ...linesOf("\n\n\n")];
    const second = cardOf(pass("claude", padded))!;
    expect(first.kind === "unread-dialog" && second.kind === "unread-dialog").toBe(true);
    if (first.kind !== "unread-dialog" || second.kind !== "unread-dialog") return;
    expect(second.cancel.signature).toBe(first.cancel.signature);

    // A row added under the footer, which stays within the last rows: Claude's `modalOnScreen`
    // needs a key hint there (ADR 0053 addendum 2026-09-26), so replacing the footer would drop the card.
    const moved = [...base, ...linesOf("something else entirely")];
    const third = cardOf(pass("claude", moved))!;
    if (third.kind !== "unread-dialog") return;
    expect(third.cancel.signature).not.toBe(first.cancel.signature);
    // The bridge's expected_prompt must be LITERAL on-screen text.
    const nonBlank = moved.map(lineText).filter((t) => t.trim() !== "");
    expect(nonBlank.at(-1)).toBe(third.cancel.signature.split("\n").at(-1));
  });
});

describe("known live-box gaps the card inherits", () => {
  // INVERTED per the note this replaces (#274 supersedes the #261 bargain): locateTail now steps
  // over the blank rows a paragraph break leaves inside the draft, so a two-paragraph message
  // binds its prompt, composerReady answers true, and no card draws over the live box. The old
  // bargain (card + two-tap escape hatch) proved actively harmful live: the hatch types without
  // the pre-clear sweep, so each tap appended a full duplicate and verify — reading null forever
  // — withheld every submit.
  it("muse: a draft with a blank row inside it no longer gets the card (#274)", () => {
    const base = fixtureLines("muse--draft-single.txt");
    const texts = base.map(lineText);
    let boxRow = -1;
    for (let i = texts.length - 1; i >= 0; i--) {
      if (texts[i]!.trimStart().startsWith("❯")) {
        boxRow = i;
        break;
      }
    }
    expect(boxRow).toBeGreaterThanOrEqual(0);

    const lines = [
      ...base.slice(0, boxRow + 1),
      ...linesOf("\n  second paragraph"),
      ...base.slice(boxRow + 1),
    ];

    expect(museAdapter.composerReady!(lines)).toBe(true);
    expect(cardOf(pass("muse", lines))).toBeNull();
  });
});
