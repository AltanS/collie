import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MARKS } from "@/lib/mark-ids";
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
//     every theme mark         34 KB      kawaii, kawaii-tilt, pixel, glass, sheep, owl, and the rest
//
// "KB" is 1000 bytes. A mark over its line does not get a bigger line here: shrink the drawing, or
// the lead moves the number on purpose, in this table and in the test below.

const BUDGET_BYTES = { collie: 76_000, theme: 34_000 } as const;

const FILES = {
  collie: "collie-mark.tsx",
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

  it("gives every mark its own prefix", () => {
    const prefixes = MARKS.map((m) => m.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("shares no keyframe name between two marks, because a <style> in an SVG is document-wide", () => {
    const seen = new Map<string, string>();
    for (const { id, Mark } of entries) {
      const { container } = render(<Mark />);
      const root = container.querySelector<SVGSVGElement>("svg[data-mark]");
      if (root === null) throw new Error(`${id} drew no root`);
      for (const name of keyframeNames(sheetOf(root))) {
        expect(seen.get(name), `${name} is in ${id} and ${seen.get(name)}`).toBeUndefined();
        seen.set(name, id);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
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
