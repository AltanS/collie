#!/usr/bin/env bun
// THE SHEET'S OWN LABELS, FOLDED, GENERATED. A trick's row in a session's settings (the `menu` place) may
// not read as one of the rows Collie draws in that sheet, in any of the twelve languages the app speaks
// (tricks/schema.ts `menuLabelProblem`). The schema is loaded by the bridge, which carries no message
// catalogue, so the folded labels live in `web/src/lib/tricks/sheet-labels.ts`, written whole from the
// catalogues by this script. Nobody edits that file by hand.
//
//   bun scripts/menu-sheet-labels.ts            print a diff and exit 1 when the file is stale
//   bun scripts/menu-sheet-labels.ts --write    write the file
//
// `scripts/menu-sheet-labels.test.ts` holds the file to this script, so a new or changed label of the
// sheet in any language fails until the file is written again.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { skeletonWords } from "../web/src/lib/fold.ts";
import type { MessageKey } from "../web/src/lib/i18n/messages/en.ts";
import { en } from "../web/src/lib/i18n/messages/en.ts";
import { de } from "../web/src/lib/i18n/messages/de.ts";
import { es } from "../web/src/lib/i18n/messages/es.ts";
import { fr } from "../web/src/lib/i18n/messages/fr.ts";
import { it } from "../web/src/lib/i18n/messages/it.ts";
import { ja } from "../web/src/lib/i18n/messages/ja.ts";
import { ko } from "../web/src/lib/i18n/messages/ko.ts";
import { pt } from "../web/src/lib/i18n/messages/pt.ts";
import { ru } from "../web/src/lib/i18n/messages/ru.ts";
import { tr } from "../web/src/lib/i18n/messages/tr.ts";
import { zh } from "../web/src/lib/i18n/messages/zh.ts";
import { zhTW } from "../web/src/lib/i18n/messages/zh-TW.ts";
import { runReferenceCli } from "./reference-kit.ts";

/** The file this script writes. */
export const SHEET_LABELS_FILE = "web/src/lib/tricks/sheet-labels.ts";

/** The files that draw the session actions sheet and a trick's group in it. */
export const SHEET_SOURCES = ["web/src/components/pane-actions-sheet.tsx", "web/src/components/trick-menu-group.tsx"] as const;

/** A string literal shaped like a message key. */
const KEY_LITERAL = /"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/gu;
/** The plural forms a `tn()` key base takes. */
const PLURAL_FORM = /\.(?:zero|one|two|few|many|other)$/u;

/**
 * Every English message key the given source texts name, once each, in the order first named: a key
 * itself, or a `tn()` base with each of its plural forms. Any other string is left out.
 */
export function labelKeysIn(sources: readonly string[]): MessageKey[] {
  const english: Readonly<Record<string, string>> = en;
  // SAFETY: `en` is the catalogue MessageKey is drawn from, so every key it has is a MessageKey.
  const keys = Object.keys(en) as MessageKey[];
  const found = new Set<MessageKey>();
  for (const source of sources) {
    for (const [, literal = ""] of source.matchAll(KEY_LITERAL)) {
      for (const key of keys) {
        if (key === literal || (key.startsWith(`${literal}.`) && PLURAL_FORM.test(key) && english[literal] === undefined)) found.add(key);
      }
    }
  }
  return [...found];
}

/**
 * Every label of the session actions sheet (components/pane-actions-sheet.tsx) and of a trick's group in
 * it (components/trick-menu-group.tsx): every message key those files name, so the rows Collie draws, the
 * armed and busy words of Close, the status lines, the group's heading and its footer lines. Read from the
 * files (review 12 N8): a row the sheet gains is in the list without a hand edit, and the generated file
 * is stale until it is written again. A row a trick draws may not fold to one of them.
 */
export const SHEET_LABEL_KEYS: readonly MessageKey[] = labelKeysIn(SHEET_SOURCES.map((file) => readFileSync(resolve(import.meta.dir, "..", file), "utf8")));

/**
 * The words of the permission card's buttons (components/ask-card.tsx): a row label or a footer line may
 * not start with them in any language, so a trick's row cannot pass for a permission Collie asks for
 * (review 12 N2).
 */
export const PERMISSION_LEAD_KEYS = ["ask.effect.allow", "ask.effect.allowAlways", "ask.effect.deny"] as const satisfies readonly MessageKey[];

/** One permission word: its folded words to match at a label's start, and the word as the card says it. */
export type PermissionLead = { readonly lead: string; readonly says: string };

const CATALOGUES: readonly Partial<Record<MessageKey, string>>[] = [en, de, es, fr, it, ja, ko, pt, ru, tr, zh, zhTW];

/** A `{slot}` of a template. */
const SLOT = /\{[A-Za-z]+\}/gu;

/** One label folded: whole words to match exactly, or the folded words before and after its slots. */
export type SheetFold = { readonly words: string } | { readonly head: string; readonly tail: string };

/** A text folded to its words, as the menu label rule folds a label: no padding. */
function folded(text: string): string {
  return skeletonWords(text).trim();
}

/** Every label of {@link SHEET_LABEL_KEYS} in every catalogue that has it, folded, once each, sorted. */
export function sheetFolds(): SheetFold[] {
  const seen = new Map<string, SheetFold>();
  for (const catalogue of CATALOGUES) {
    for (const key of SHEET_LABEL_KEYS) {
      const label = catalogue[key];
      if (label === undefined) continue;
      const pieces = label.split(SLOT);
      if (pieces.length === 1) {
        const words = folded(label);
        if (words !== "") seen.set(`w ${words}`, { words });
        continue;
      }
      const head = folded(pieces[0] ?? "");
      const tail = folded(pieces.at(-1) ?? "");
      // A label that is all slots says nothing of its own to match.
      if (head === "" && tail === "") continue;
      seen.set(`t ${head}\u0000${tail}`, { head, tail });
    }
  }
  return [...seen.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, fold]) => fold);
}

/** Every word of {@link PERMISSION_LEAD_KEYS} in every catalogue, folded, once each (the first catalogue's word), sorted. */
export function permissionLeads(): PermissionLead[] {
  const seen = new Map<string, PermissionLead>();
  for (const catalogue of CATALOGUES) {
    for (const key of PERMISSION_LEAD_KEYS) {
      const says = catalogue[key];
      if (says === undefined) continue;
      const lead = folded(says);
      if (lead !== "" && !seen.has(lead)) seen.set(lead, { lead, says });
    }
  }
  return [...seen.values()].toSorted((a, b) => (a.lead < b.lead ? -1 : a.lead > b.lead ? 1 : 0));
}

/** The whole generated file. */
export function sheetLabelsFile(): string {
  const rows = sheetFolds().map((fold) => `  ${JSON.stringify(fold)},`);
  const leads = permissionLeads().map((lead) => `  ${JSON.stringify(lead)},`);
  return [
    "// GENERATED by `bun scripts/menu-sheet-labels.ts --write` from the twelve message catalogues. Do not edit.",
    "//",
    "// The labels of the session actions sheet and of a trick's group in it, folded as tricks/schema.ts",
    "// `menuLabelProblem` folds a row's label (fold.ts `skeletonWords`, trimmed). `words` is a label with no slot,",
    "// matched whole; `head` and `tail` are the folded words before the first slot and after the last one.",
    "",
    "export type SheetFold = { readonly words: string } | { readonly head: string; readonly tail: string };",
    "",
    "export const SHEET_LABEL_FOLDS: readonly SheetFold[] = [",
    ...rows,
    "];",
    "",
    "// The words of the permission card's buttons in every language, folded alike. `lead` is matched at a label's",
    "// start, `says` is the word as the card says it.",
    "",
    "export type PermissionLead = { readonly lead: string; readonly says: string };",
    "",
    "export const PERMISSION_LEADS: readonly PermissionLead[] = [",
    ...leads,
    "];",
    "",
  ].join("\n");
}

if (import.meta.main) process.exit(runReferenceCli(process.argv.slice(2), SHEET_LABELS_FILE, "bun scripts/menu-sheet-labels.ts --write", sheetLabelsFile()));
