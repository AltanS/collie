import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MARKS, type MarkId } from "@/lib/mark-ids";
import { describeMarkConformance, keyframeNames, sheetOf } from "@/test/mark-conformance";

import { loadMark } from "./brand-mark";

// THE MARK CONTRACT, HELD OVER EVERY REGISTERED MARK. A mark in `MARKS` (lib/mark-ids.ts) that fails
// this file cannot ship: there is no skip list and no per-mark exception, and registering a mark IS
// opting in. It uses the real generated modules and no mock, so a regeneration that drifts from
// `mark-contract.ts` fails here, in this repo, before it reaches a header.
//
// The cases themselves live in `test/mark-conformance.tsx`. This file owns what only the registry
// can say: that the marks share nothing they should not, and that each stays inside its size budget.
//
// SIZE BUDGET, per file, in bytes of the generated module (a mark ships as its own chunk, and the
// Collie mark ships in the entry):
//
//     collie-mark.tsx          76 KB      the full drawing, with the shaded beads
//     every theme mark         34 KB      kawaii, kawaii-tilt, pixel, glass, sheep, owl, the two Collie
//                                         coat variants (collar, blaze, about 20 KB each), and the rest
//
// "KB" is 1000 bytes. A mark over its line does not get a bigger line here: shrink the drawing, or
// the lead moves the number on purpose, in this table and in the test below.

const BUDGET_BYTES = { collie: 76_000, theme: 34_000 } as const;

const FILES = {
  collie: "collie-mark.tsx",
  "collie-collar": "collie-collar-mark.tsx",
  "collie-blaze": "collie-blaze-mark.tsx",
  kawaii: "kawaii-mark.tsx",
  "kawaii-tilt": "kawaii-tilt-mark.tsx",
  pixel: "pixel-mark.tsx",
  glass: "glass-mark.tsx",
  "glass-front": "glass-front-mark.tsx",
  sheep: "sheep-mark.tsx",
  owl: "owl-mark.tsx",
} as const;

const entries = await Promise.all(
  MARKS.map(async ({ id, prefix }) => ({ id, prefix, Mark: await loadMark(id) })),
);

describeMarkConformance(entries);

describe("the registry", () => {
  it("has a source file for every mark, and a mark for every file", () => {
    expect(Object.keys(FILES).toSorted()).toEqual(MARKS.map((m) => m.id).toSorted());
  });

  it("gives every family its own prefix, and every mark in a family that one prefix", () => {
    const prefixOfFamily = new Map<string, string>();
    for (const { id, family, prefix } of MARKS) {
      expect(prefixOfFamily.get(family) ?? prefix, `${id} breaks its family's prefix`).toBe(prefix);
      prefixOfFamily.set(family, prefix);
    }
    const prefixes = [...prefixOfFamily.values()];
    expect(new Set(prefixes).size, "two families share a prefix").toBe(prefixes.length);
  });

  it("names a family only by one of its own marks' ids, so a family has a head", () => {
    for (const { family } of MARKS) expect(MARKS.some((m) => m.id === family)).toBe(true);
  });

  it("shares a keyframe name only inside one family, and only where the whole stylesheet is the same", () => {
    // A <style> in an SVG is document-wide, so two marks that draw the same keyframe name write one
    // rule between them. Marks of one family are one stylesheet with another head (collieFamilyMark),
    // so the name is the same rule by construction. Anywhere else it is a leak.
    const seen = new Map<string, { id: MarkId; family: string; sheet: string }>();
    for (const { id, Mark } of entries) {
      const family = MARKS.find((m) => m.id === id)?.family;
      if (family === undefined) throw new Error(`${id} is not registered`);
      const { container } = render(<Mark />);
      const root = container.querySelector<SVGSVGElement>("svg[data-mark]");
      if (root === null) throw new Error(`${id} drew no root`);
      const sheet = sheetOf(root);
      for (const name of keyframeNames(sheet)) {
        const first = seen.get(name);
        if (first === undefined) {
          seen.set(name, { id, family, sheet });
          continue;
        }
        expect(first.family, `${name} is in ${id} and ${first.id}, which are not one family`).toBe(family);
        expect(sheet, `${id} and ${first.id} share ${name} but not their whole stylesheet`).toBe(first.sheet);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it("draws each Collie coat with a head of its own", () => {
    const html = (id: MarkId) => {
      const Mark = entries.find((entry) => entry.id === id)?.Mark;
      if (Mark === undefined) throw new Error(`no ${id}`);
      return render(<Mark />).container.innerHTML;
    };
    expect(new Set([html("collie"), html("collie-collar"), html("collie-blaze")]).size).toBe(3);
  });

  for (const { id } of MARKS) {
    it(`keeps ${id} inside its size budget`, () => {
      const file = join(import.meta.dirname, FILES[id]);
      const limit = id === "collie" ? BUDGET_BYTES.collie : BUDGET_BYTES.theme;
      expect(statSync(file).size).toBeLessThanOrEqual(limit);
    });

    it(`has ${id} import the contract and not carry a copy of it`, () => {
      const source = readFileSync(join(import.meta.dirname, FILES[id]), "utf8");
      expect(source).toMatch(/from "\.\/mark-contract"/);
    });
  }
});
