import { describe, expect, test } from "bun:test";

import { ACCESS_LINES, MANIFEST_KEYS, WATCH_MAX, WATCH_PATH_MAX, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { addedDiff } from "./card-group.ts";
import { PROPOSAL_KEY_RIGHTS, PROPOSAL_TOO_LARGE, proposalCard, proposalVersionCard, type ProposerFacts } from "./proposal-card.ts";
import { DECIDES_REPLY_CHIP, RUNS_AS_YOU, runsAsYou } from "./version-card.ts";

// EVERY RIGHT HAS A LINE ON THE CARD (the first full trick run, 2026-11-16, decision 1). A trick with
// `decides = "reply"` once got "It asks for no rights." This walks every key the table calls a right and
// sets it alone on a bare manifest: the card must change for it, in its summary and in its view.

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const WHO: ProposerFacts = { by: "agent", host: "workshop", label: "repo#one" };
const BARE: TrickManifest = { id: "legs", name: "Legs", run: "program.ts", mode: "once", contract: 2, icon: "plug", places: [] };

type RightKey = { [K in keyof typeof PROPOSAL_KEY_RIGHTS]: (typeof PROPOSAL_KEY_RIGHTS)[K] extends "chip" | "reads" ? K : never }[keyof typeof PROPOSAL_KEY_RIGHTS];

/** One value per right-bearing key, and the words the card must then hold. A new right is a compile error here until it has both. */
const SAMPLES = {
  places: { set: { places: ["status"] }, words: "the status line" },
  env: { set: { env: ["GITHUB_TOKEN"] }, words: "GITHUB_TOKEN" },
  decides: { set: { decides: "reply" }, words: DECIDES_REPLY_CHIP },
  access: { set: { access: "see" }, words: ACCESS_LINES.see },
  inputs: { set: { inputs: ["TODO.md"] }, words: "TODO.md" },
  on: { set: { on: ["session.status"] }, words: "runs when a session changes state" },
  watch: { set: { watch: ["~/notes/todo.md", "/etc/hosts"] }, words: "runs when these files change: ~/notes/todo.md, /etc/hosts" },
} as const satisfies { readonly [K in RightKey]: { set: Partial<TrickManifest>; words: string } };

function cardOf(manifest: TrickManifest) {
  const made = proposalCard({ id: "legs", manifest, proposer: WHO, diff: addedDiff([{ rel: "program.ts", bytes: enc("console.log(1);\n") }]), warnings: [], crew: false });
  if (!made.ok) throw new Error(made.error);
  return made.card;
}

describe("every right a trick asks for has a line on the proposal card", () => {
  test("the table classes every manifest key", () => {
    expect(Object.keys(PROPOSAL_KEY_RIGHTS).toSorted()).toEqual([...MANIFEST_KEYS].toSorted());
  });

  const bare = cardOf(BARE);
  for (const [key, sample] of Object.entries(SAMPLES)) {
    test(`${key}: the summary and the view name it, and "no rights" is gone`, () => {
      const card = cardOf({ ...BARE, ...sample.set });
      expect(card.summary).not.toBe(bare.summary);
      expect(card.summary).not.toContain("It asks for no rights.");
      expect(JSON.stringify(card.view)).toContain(sample.words);
    });
  }

  test('decides = "reply" alone reads as a right, never as "no rights"', () => {
    expect(bare.summary).toContain("It asks for no rights.");
    const card = cardOf({ ...BARE, decides: "reply" });
    expect(card.summary).toContain(`It asks for ${DECIDES_REPLY_CHIP}.`);
  });
});

// THE CARD'S HONEST LINE (Altan, 2026-11-17): a trick with a program says, first, that it runs as you.
describe("the honest line", () => {
  test("a trick with a program: the card's view opens with it, word for word", () => {
    expect(RUNS_AS_YOU).toBe("This trick runs as you on this machine. It can do there what you can do.");
    const view = cardOf(BARE).view ?? [];
    expect(view[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
  });

  test("a trick with no program (an agent view only) gets no such line", () => {
    const { run: _run, ...rest } = BARE;
    const noProgram: TrickManifest = rest;
    expect(runsAsYou(noProgram)).toEqual([]);
    expect(runsAsYou(undefined)).toEqual([]);
  });
});

// SECURITY READ 2, ITEM 1: a proposal never offers a yes over rights the card cannot show. Both proposal
// cards refuse the proposal (`card_too_large`) when the facts do not fit one view; eight watch paths at the
// cap always fit.
describe("rights that do not fit a card", () => {
  const wide = "𝔀";
  const tooMuch: Partial<TrickManifest> = {
    env: Array.from({ length: 32 }, (_, i) => `TOKEN_${String(i).padStart(2, "0")}_${"X".repeat(55)}`),
    watch: Array.from({ length: WATCH_MAX }, (_, i) => `/home/dev/${String(i)}${wide.repeat(WATCH_PATH_MAX - 11)}`),
  };
  const atCap = Array.from({ length: WATCH_MAX }, (_, i) => `/home/dev/${String(i)}${"w".repeat(WATCH_PATH_MAX - 11)}`);
  const diff = addedDiff([{ rel: "program.ts", bytes: enc("console.log(1);\n") }]);

  test("a new trick: eight paths at the cap all show; past the view the proposal is refused", () => {
    const words = JSON.stringify(cardOf({ ...BARE, watch: atCap }).view);
    for (const path of atCap) expect(words).toContain(path);
    expect(proposalCard({ id: "legs", manifest: { ...BARE, ...tooMuch }, proposer: WHO, diff, warnings: [], crew: false })).toEqual({ ok: false, code: "card_too_large", error: PROPOSAL_TOO_LARGE });
  });

  test("a new version: eight paths at the cap all show with Use; past the view the proposal is refused, so no Use", () => {
    const fits = proposalVersionCard({ id: "legs", manifest: { ...BARE, watch: atCap }, baseManifest: BARE, proposer: WHO, diff, warnings: [], crew: false });
    if (!fits.ok) throw new Error(fits.error);
    const words = JSON.stringify(fits.card.view ?? fits.card.group);
    for (const path of atCap) expect(words).toContain(path);
    expect(fits.card.options?.map((option) => option.intent)).toEqual(["on", "later"]);
    expect(proposalVersionCard({ id: "legs", manifest: { ...BARE, ...tooMuch }, baseManifest: BARE, proposer: WHO, diff, warnings: [], crew: false })).toEqual({ ok: false, code: "card_too_large", error: PROPOSAL_TOO_LARGE });
  });
});

// ACCESS ON THE PROPOSAL CARDS (M105 spec 04, decision 3): the one line of the level, right after the honest
// line, on a new trick's card and on the card of a version that raises the level. A version that keeps or
// lowers it says nothing new.
describe("access on the proposal cards", () => {
  const diff = addedDiff([{ rel: "program.ts", bytes: enc("console.log(1);\n") }]);
  const versionOf = (base: TrickManifest, next: TrickManifest) => {
    const made = proposalVersionCard({ id: "legs", manifest: next, baseManifest: base, proposer: WHO, diff, warnings: [], crew: false });
    if (!made.ok) throw new Error(made.error);
    return made.card;
  };

  test("a new trick's card: the honest line, then the level's line, then the chip", () => {
    const see = cardOf({ ...BARE, access: "see" });
    expect(see.view?.[0]).toEqual({ kind: "para", text: RUNS_AS_YOU });
    expect(see.view?.[1]).toEqual({ kind: "para", text: ACCESS_LINES.see });
    expect(JSON.stringify(see.view)).toContain("a look at your machines, sessions and usage");
    const read = cardOf({ ...BARE, access: "read" });
    expect(read.view?.[1]).toEqual({ kind: "para", text: ACCESS_LINES.read });
    expect(JSON.stringify(cardOf(BARE).view)).not.toContain("It sees your machines");
  });

  test("a version that raises the level shows the line and the right; one that keeps or lowers it does not", () => {
    const raised = versionOf(BARE, { ...BARE, access: "read" });
    expect(raised.view?.[1]).toEqual({ kind: "para", text: ACCESS_LINES.read });
    expect(raised.summary).toContain("It now also asks for a look at what is on your sessions' screens.");
    for (const card of [versionOf({ ...BARE, access: "see" }, { ...BARE, access: "see" }), versionOf({ ...BARE, access: "read" }, { ...BARE, access: "see" })]) {
      expect(JSON.stringify(card.view)).not.toContain("It sees your machines");
      expect(card.summary).toContain("It asks for no new rights.");
    }
  });
});
