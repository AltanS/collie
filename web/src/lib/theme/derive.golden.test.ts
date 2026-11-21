import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { DERIVE_VERSION, deriveTokens } from "./derive";
import { fillHalves, parseTheme, type Theme } from "./schema";

// THE GOLDEN VALUES of deriveTokens for both halves of the four bundled looks, as one snapshot file. A change to a
// floor, MARGIN, STEP or a relation repaints every installed theme; here it shows as a diff to review, and it is the
// moment to bump DERIVE_VERSION (derive.ts), so a first frame never wears values an older version stored.

const read = (id: string): Theme => {
  const parsed = parseTheme(readFileSync(resolve(__dirname, `../../themes/${id}.json`), "utf8"), { maxBytes: 64 * 1024, allowReservedId: true });
  if (!parsed.ok) throw new Error(`${id} does not parse`);
  return parsed.theme;
};

describe("the golden values of the bundled looks", () => {
  const collie = read("collie");
  for (const id of ["collie", "nightwatch", "daylight", "harbour"]) {
    it(id, () => {
      const filled = fillHalves(read(id), collie);
      expect({ version: DERIVE_VERSION, light: deriveTokens(filled.light, "light"), dark: deriveTokens(filled.dark, "dark") }).toMatchSnapshot();
    });
  }
});
