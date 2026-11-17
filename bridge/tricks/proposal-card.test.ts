import { describe, expect, test } from "bun:test";

import { ACCESS_LINES, MANIFEST_KEYS, SHOWS_IN_WORDS, WATCH_MAX, WATCH_PATH_MAX, type TrickManifest, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import { PROPOSAL_USE_LABEL } from "../../web/src/lib/hill/code-card.ts";
import { addedDiff } from "./card-group.ts";
import { PROPOSAL_KEY_RIGHTS, PROPOSAL_ON, PROPOSAL_TOO_LARGE, PROPOSAL_USE, proposalCard, proposalVersionCard, runsOnSentence, type ProposerFacts } from "./proposal-card.ts";
import { asksForSentence, DECIDES_REPLY_CHIP, KEEPS_RUNNING, keepsRunning, RUNS_AS_YOU, runsAsYou } from "./version-card.ts";

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
    expect(JSON.stringify(see.view)).toContain("the state of your machines and sessions");
    const read = cardOf({ ...BARE, access: "read" });
    expect(read.view?.[1]).toEqual({ kind: "para", text: ACCESS_LINES.read });
    expect(JSON.stringify(cardOf(BARE).view)).not.toContain("It reads your machines");
  });

  test("with settings too: the honest line, then the level's line, then the settings line, on both cards", () => {
    const fields: NonNullable<TrickManifest["fields"]> = [{ key: "repo", kind: "text", label: "Repository" }];
    const asks = asksForSentence(fields);
    const order = (view: readonly ViewNode[] | undefined): number[] => {
      const texts = (view ?? []).map((node) => ("text" in node ? node.text : undefined));
      return [RUNS_AS_YOU, ACCESS_LINES.see, asks].map((text) => texts.indexOf(text));
    };
    const fresh = order(cardOf({ ...BARE, contract: 3, access: "see", fields }).view);
    expect(fresh[0]).toBe(0);
    expect(fresh[1]).toBe(1);
    expect(fresh[2]).toBeGreaterThan(fresh[1] ?? 0);
    const raised = order(versionOf({ ...BARE, contract: 3 }, { ...BARE, contract: 3, access: "see", fields }).view);
    expect(raised[0]).toBe(0);
    expect(raised[1]).toBe(1);
    expect(raised[2]).toBeGreaterThan(raised[1] ?? 0);
  });

  test("a version that raises the level shows the line and the right; one that keeps or lowers it does not", () => {
    const raised = versionOf(BARE, { ...BARE, access: "read" });
    expect(raised.view?.[1]).toEqual({ kind: "para", text: ACCESS_LINES.read });
    expect(raised.summary).toContain("It now also asks for your sessions' screens.");
    expect(versionOf(BARE, { ...BARE, access: "see" }).summary).toContain("It now also asks for the state of your machines and sessions.");
    for (const card of [versionOf({ ...BARE, access: "see" }, { ...BARE, access: "see" }), versionOf({ ...BARE, access: "read" }, { ...BARE, access: "see" })]) {
      expect(JSON.stringify(card.view)).not.toContain("It reads your machines");
      expect(card.summary).toContain("It asks for no new rights.");
    }
  });
});

describe("the yes carries no confirm of its own: the phone's hold is the guard (ADR 0156)", () => {
  test("a new version's yes keeps the label the phone tells it apart by", () => {
    expect(PROPOSAL_USE.label).toBe(PROPOSAL_USE_LABEL);
    expect(PROPOSAL_ON.label).not.toBe(PROPOSAL_USE_LABEL);
  });

  test("the Switch it on and Use the new version options carry no confirm, so the phone's hold alone asks", () => {
    expect("confirm" in PROPOSAL_ON).toBe(false);
    expect("confirm" in PROPOSAL_USE).toBe(false);
    const options = cardOf(BARE).options ?? [];
    expect(options.map((o) => o.intent)).toEqual(["on", "later"]);
    for (const option of options) expect(option.confirm).toBeUndefined();
  });
});

describe("no card without code to read (2026-11-17)", () => {
  test("a new trick's empty file shows one line that says so", () => {
    const diff = addedDiff([{ rel: "empty.ts", bytes: new Uint8Array() }]);
    expect(diff.files).toEqual([{ rel: "empty.ts", change: "added", plus: 0, minus: 0, hunk: ["empty.ts: an empty file, added"] }]);
  });
});

// THE LINE OF A TRICK THAT REACTS (Altan, 2026-11-17): `on` and `watch` start the program with no phone open, so
// the card says "It keeps running with no phone open." right after the rights lines. A plain timer waits for a
// phone's look (service.ts WATCH_WINDOW_MS), so it gets no such line, and neither does a tap-only trick.
describe("the line of a trick that keeps running with no phone open", () => {
  const diff = addedDiff([{ rel: "program.ts", bytes: enc("console.log(1);\n") }]);
  const versionOf = (base: TrickManifest, next: TrickManifest) => {
    const made = proposalVersionCard({ id: "legs", manifest: next, baseManifest: base, proposer: WHO, diff, warnings: [], crew: false });
    if (!made.ok) throw new Error(made.error);
    return made.card;
  };
  const textsOf = (view: readonly ViewNode[] | undefined): (string | undefined)[] => (view ?? []).map((node) => ("text" in node ? node.text : undefined));
  const READS = [
    ["on", { on: ["session.status"] }],
    ["watch", { watch: ["~/notes/todo.md"] }],
  ] as const satisfies readonly (readonly [string, Partial<TrickManifest>])[];

  test("the words, exactly", () => {
    expect(KEEPS_RUNNING).toBe("It keeps running with no phone open.");
  });

  for (const [key, set] of READS) {
    test(`${key}: the proposal card and the version card carry it, after the rights lines and the honest line`, () => {
      const fresh = cardOf({ ...BARE, ...set });
      const at = textsOf(fresh.view).indexOf(KEEPS_RUNNING);
      expect(at).toBeGreaterThan(0);
      expect(textsOf(fresh.view)[0]).toBe(RUNS_AS_YOU);
      // The chip bar of the rights comes first, then the line.
      expect((fresh.view ?? []).findIndex((node) => node.kind === "bar")).toBeLessThan(at);
      const version = versionOf(BARE, { ...BARE, ...set });
      expect(textsOf(version.view)).toContain(KEEPS_RUNNING);
    });
  }

  test("a tap-only trick, a plain timer and a trick with no program carry none", () => {
    expect(textsOf(cardOf(BARE).view)).not.toContain(KEEPS_RUNNING);
    expect(textsOf(cardOf({ ...BARE, every: "30s", everyMs: 30_000 }).view)).not.toContain(KEEPS_RUNNING);
    expect(textsOf(versionOf(BARE, { ...BARE, access: "see" }).view)).not.toContain(KEEPS_RUNNING);
    const { run: _run, ...noProgram } = { ...BARE, on: ["session.status" as const] };
    expect(keepsRunning(noProgram)).toEqual([]);
    expect(keepsRunning(undefined)).toEqual([]);
  });

  test("a version that keeps the same watch still says it: the line follows the new version, not the change", () => {
    const next: TrickManifest = { ...BARE, watch: ["~/notes/todo.md"] };
    expect(textsOf(versionOf(next, { ...next, access: "see" }).view)).toContain(KEEPS_RUNNING);
  });
});

// "It will run on <machine>." (Altan, 2026-11-17): under the proposer's sentence, only when the proposal came from
// another machine of the crew than the one that runs the trick.
describe("where it will run", () => {
  const diff = addedDiff([{ rel: "program.ts", bytes: enc("console.log(1);\n") }]);
  const proposed = (runsOn: string | null | undefined) => {
    const input: Parameters<typeof proposalCard>[0] = { id: "legs", manifest: BARE, proposer: WHO, diff, warnings: [], crew: true };
    if (runsOn !== undefined) input.runsOn = runsOn;
    const made = proposalCard(input);
    if (!made.ok) throw new Error(made.error);
    return made.card;
  };

  test("the words", () => {
    expect(runsOnSentence("lodge")).toBe("It will run on lodge.");
    expect(runsOnSentence("lo\u202edge")).toBe("It will run on lo?dge.");
  });

  test("a card with a machine says it right after the proposer; one without says nothing", () => {
    expect(proposed("lodge").summary).toStartWith("A session on workshop proposes it. It will run on lodge. ");
    expect(proposed(null).summary).not.toContain("It will run on");
    expect(proposed(undefined).summary).not.toContain("It will run on");
  });

  test("a version card says it too", () => {
    const made = proposalVersionCard({ id: "legs", manifest: { ...BARE, access: "see" }, baseManifest: BARE, proposer: WHO, diff, warnings: [], crew: true, runsOn: "lodge" });
    if (!made.ok) throw new Error(made.error);
    expect(made.card.summary).toStartWith("A session on workshop proposes it. It will run on lodge. ");
  });

  test("on a group of cards, card 1 holds the two sentences as two paragraphs, proposer first", () => {
    const long = Array.from({ length: 400 }, (_, n) => `console.log(${String(n)});`).join("\n");
    const made = proposalCard({ id: "legs", manifest: BARE, proposer: WHO, diff: addedDiff([{ rel: "program.ts", bytes: enc(long) }]), warnings: [], crew: true, runsOn: "lodge" });
    if (!made.ok) throw new Error(made.error);
    const first = made.card.group?.parts[0];
    expect(first?.[0]).toEqual({ kind: "para", text: "A session on workshop proposes it." });
    expect(first?.[1]).toEqual({ kind: "para", text: "It will run on lodge." });
  });
});

// WHERE THE TRICK SHOWS (the operator, 2026-11-17): the proposal card and the version card of a proposal each carry
// one line built from the manifest's places, after the rights lines. A trick with no place gets no line.
describe("the line of where a proposed trick shows", () => {
  const diff = addedDiff([{ rel: "program.ts", bytes: enc("console.log(1);\n") }]);
  const textsOf = (view: readonly ViewNode[] | undefined): (string | undefined)[] => (view ?? []).map((node) => ("text" in node ? node.text : undefined));
  const LINE = "It shows in: the left end of the usage row of each session, a page of its own (a row under Tricks on the Dashboard).";

  test("a new trick's card names its places, after the chip bar of its rights", () => {
    const card = cardOf({ ...BARE, places: ["status", "session"] });
    const texts = textsOf(card.view);
    expect(texts).toContain(LINE);
    expect((card.view ?? []).findIndex((node) => node.kind === "bar")).toBeLessThan(texts.indexOf(LINE));
    expect(SHOWS_IN_WORDS.status).toBe("the left end of the usage row of each session");
  });

  test("a trick with no place carries no line, on either card", () => {
    expect(textsOf(cardOf(BARE).view).some((text) => text?.startsWith("It shows in:"))).toBe(false);
    const made = proposalVersionCard({ id: "legs", manifest: BARE, baseManifest: BARE, proposer: WHO, diff, warnings: [], crew: false });
    if (!made.ok) throw new Error(made.error);
    expect(textsOf(made.card.view).some((text) => text?.startsWith("It shows in:"))).toBe(false);
  });

  test("the version card of a proposal names the new version's places", () => {
    const next: TrickManifest = { ...BARE, places: ["status", "session"], access: "see" };
    const made = proposalVersionCard({ id: "legs", manifest: next, baseManifest: BARE, proposer: WHO, diff, warnings: [], crew: false });
    if (!made.ok) throw new Error(made.error);
    expect(textsOf(made.card.view)).toContain(LINE);
  });
});
