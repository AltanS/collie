import { describe, expect, test } from "bun:test";

import { MANIFEST_KEYS, type TrickManifest } from "../../web/src/lib/tricks/schema.ts";
import { addedDiff } from "./card-group.ts";
import { PROPOSAL_KEY_RIGHTS, proposalCard, type ProposerFacts } from "./proposal-card.ts";
import { DECIDES_REPLY_CHIP } from "./version-card.ts";

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
  inputs: { set: { inputs: ["TODO.md"] }, words: "TODO.md" },
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
