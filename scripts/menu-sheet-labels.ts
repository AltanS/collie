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

/**
 * Every label of the session actions sheet (components/pane-actions-sheet.tsx) and of a trick's group in
 * it (components/trick-menu-group.tsx): the rows Collie draws, the armed and busy words of Close, the
 * group's heading and its footer lines. A row a trick draws may not fold to one of them.
 */
export const SHEET_LABEL_KEYS = [
  "chat.find.label",
  "chat.history.label",
  "chat.copyOutput.label",
  "walky.sheet.row",
  "walky.off.row",
  "chat.mode.terminal",
  "chat.mode.chat",
  "view.back",
  "paneActions.settings.label",
  "chat.zen.label",
  "paneActions.pin.label",
  "paneActions.unpin.label",
  "paneActions.report.label",
  "paneActions.rename.label",
  "paneActions.focus.labelWithMux",
  "paneActions.focus.labelFallback",
  "paneActions.branchOff.label",
  "paneActions.close.label",
  "paneActions.close.conversation",
  "paneActions.close.confirm",
  "paneActions.close.closing",
  "paneActions.title.fallback",
  "tricks.menu.heading",
  "tricks.menu.waiting",
  "tricks.menu.noAnswer",
  "tricks.menu.asOf",
  "tricks.menu.off",
  "tricks.menu.armed",
  "tricks.menu.more.one",
  "tricks.menu.more.other",
] as const satisfies readonly MessageKey[];

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
