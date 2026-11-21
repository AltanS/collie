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
import * as sheetLabels from "./menu-sheet-labels.ts";
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
        // A label of slots alone ("{name}: {message}") says nothing of its own to match.
        if (label === undefined || !/[\p{L}\p{N}]/u.test(label.replaceAll(/\{[A-Za-z]+\}/gu, ""))) continue;
        const filled = label.replaceAll(/\{[A-Za-z]+\}/gu, "CI");
        if ([...filled].length > 24) continue;
        expect(menuLabelProblem(filled), `${key}: ${filled}`).toBeDefined();
      }
    }
  });

  it("N8: every message key the sheet's own files name is one of its labels, so a new row joins the reserved list by itself", () => {
    const english: Readonly<Record<string, string>> = en;
    const named = new Set<string>();
    for (const file of ["web/src/components/pane-actions-sheet.tsx", "web/src/components/trick-menu-group.tsx"]) {
      for (const [, key = ""] of readFileSync(resolve(import.meta.dir, "..", file), "utf8").matchAll(/"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/gu)) {
        if (english[key] !== undefined) named.add(key);
        for (const plural of Object.keys(english).filter((k) => k.startsWith(`${key}.`) && /\.(?:zero|one|two|few|many|other)$/u.test(k))) named.add(plural);
      }
    }
    const listed = new Set<string>(SHEET_LABEL_KEYS);
    expect([...named].filter((key) => !listed.has(key))).toEqual([]);
    expect(named.has("tricks.menu.moreSee.other")).toBe(true);
    // The list is read from the files, not kept by hand: a row the sheet gains is in it at once.
    expect(sheetLabels.labelKeysIn([`<Row label={t(on ? "paneActions.pin.done" : "tricks.menu.moreSee")} data="no.such.key" />`])).toEqual([
      "paneActions.pin.done",
      "tricks.menu.moreSee.one",
      "tricks.menu.moreSee.other",
    ]);
  });
});
