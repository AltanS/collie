// The generated sheet labels (web/src/lib/tricks/sheet-labels.ts) match the twelve catalogues, so a new or
// changed label of the session actions sheet, in any language, fails here until the file is written again.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { menuLabelProblem } from "../web/src/lib/tricks/schema.ts";
import { SHEET_LABEL_FOLDS } from "../web/src/lib/tricks/sheet-labels.ts";
import { de } from "../web/src/lib/i18n/messages/de.ts";
import { en, type MessageKey } from "../web/src/lib/i18n/messages/en.ts";
import { ja } from "../web/src/lib/i18n/messages/ja.ts";
import { SHEET_LABEL_KEYS, SHEET_LABELS_FILE, sheetFolds, sheetLabelsFile } from "./menu-sheet-labels.ts";

describe("menu-sheet-labels", () => {
  it("the generated file is current: run `bun scripts/menu-sheet-labels.ts --write` when this fails", () => {
    expect(readFileSync(resolve(import.meta.dir, "..", SHEET_LABELS_FILE), "utf8")).toBe(sheetLabelsFile());
    expect(SHEET_LABEL_FOLDS).toEqual(sheetFolds());
  });

  it("menu-label-reserved-phrase-any-locale: every sheet label of every catalogue it lists is refused as a row label", () => {
    const catalogues: readonly Partial<Record<MessageKey, string>>[] = [en, de, ja];
    for (const catalogue of catalogues) {
      for (const key of SHEET_LABEL_KEYS) {
        const label = catalogue[key];
        if (label === undefined) continue;
        const filled = label.replaceAll(/\{[A-Za-z]+\}/gu, "CI");
        if ([...filled].length > 24) continue;
        expect(menuLabelProblem(filled), `${key}: ${filled}`).toBeDefined();
      }
    }
  });
});
