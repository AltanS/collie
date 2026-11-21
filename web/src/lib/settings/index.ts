import { matchTerm, queryTerms, type Range } from "@/lib/fuzzy";
import { t, type MessageKey } from "@/lib/i18n";

import { fragmentRowId, PLACES, pageDef } from "./pages";
import { SETTINGS } from "./registry";
import { PAGE_IDS, type Condition, type PageId, type SettingDef } from "./types";

export { ALIASES, PAGES, PLACES, OLD_BELOW, OLD_FRAGMENTS, OLD_PAGES, currentRowId, pageDef } from "./pages";
export { SETTINGS, NOT_SETTINGS, type RegisteredId } from "./registry";
export type * from "./types";

/** Whether `word` names one of the eleven pages. */
export function isPageId(word: string): word is PageId {
  // SAFETY: widening the tuple of page ids to strings only lets `includes` take any word; nothing is narrowed by it.
  return (PAGE_IDS as readonly string[]).includes(word);
}

/** The setting with this id, or undefined. */
export function settingById(id: string): SettingDef | undefined {
  return SETTINGS.find((s) => s.id === id);
}

/** The rows of one page, in registry order; `below` picks a page under it (undefined: the page itself). */
export function settingsOn(page: PageId, below?: string): readonly SettingDef[] {
  return SETTINGS.filter((s) => s.page === page && s.below === below);
}

/** The heading of a row's group: on its page, or the words of the place it lives in. */
export function groupHeading(setting: SettingDef): MessageKey {
  if (isPageId(setting.page)) {
    const group = pageDef(setting.page).groups.find((g) => g.id === setting.group);
    if (group === undefined) throw new Error(`setting ${setting.id} names the group "${setting.group}", which ${setting.page} does not have`);
    return group.heading;
  }
  const where = new Map<string, MessageKey>(Object.entries(PLACES[setting.page])).get(setting.group);
  if (where === undefined) throw new Error(`setting ${setting.id} names the place group "${setting.group}"`);
  return where;
}

/** The words that say why a row is not on this screen, one line. */
export const CONDITION_LINE = {
  "can-vibrate": "settings.search.when.canVibrate",
  "keyboard-seen": "settings.search.when.keyboardSeen",
  "install-offered": "settings.search.when.installOffered",
  "accounts-offered": "settings.search.when.accountsOffered",
  crew: "settings.search.when.crew",
  "push-server": "settings.search.when.pushServer",
  "tricks-on": "settings.search.when.tricksOn",
  "zen-on": "settings.search.when.zenOn",
  "update-waiting": "settings.search.when.updateWaiting",
  "release-line-skew": "settings.search.when.updateWaiting",
  "has-profile": "settings.search.when.hasProfile",
  "math-ready": "settings.search.when.mathReady",
  "hands-free-offered": "settings.search.when.handsFreeOffered",
  "official-newer": "settings.search.when.updateWaiting",
} as const satisfies Record<Condition, MessageKey>;

/** Where a row opens: its page, or the page below it, with the row's id as the fragment. Null for a place. */
export function settingPath(setting: SettingDef): string | null {
  if (!isPageId(setting.page)) return null;
  // A page below that needs an item (`:id`, `:key`, `load/:machine`) cannot be opened without one: open the page.
  const below = setting.below !== undefined && !setting.below.includes(":") ? `/${setting.below}` : "";
  return `/settings/${setting.page}${below}#${setting.id}`;
}

export interface SettingHit {
  setting: SettingDef;
  /** The row's label, in the reader's language. */
  label: string;
  /** Where the label's letters matched, for the mark. */
  ranges: readonly Range[];
  /** The page's name, or the place's words. */
  page: string;
  /** The group's heading on its page; empty for a place. */
  group: string;
  score: number;
}

const WEIGHT = { label: 4, words: 3, group: 2, page: 2, hint: 1 } as const;

/**
 * The rows a query finds, best first: a row matches when every word of the query is found in its label, its hint,
 * its search words, its group or its page. Only rows a person can look for (`find` is not false). The matching is
 * the app's one fuzzy matcher (`lib/fuzzy.ts`), anchored at the start of a word, so "dark" finds "Light or dark"
 * and not "markdown".
 */
export function searchSettings(query: string, limit = 12): SettingHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const hits: SettingHit[] = [];
  for (const setting of SETTINGS) {
    if (setting.find === false) continue;
    const label = t(setting.label);
    const onPage = isPageId(setting.page);
    const page = isPageId(setting.page) ? t(pageDef(setting.page).title) : t(groupHeading(setting));
    const group = onPage ? t(groupHeading(setting)) : "";
    const fields: { text: string; weight: number; label: boolean }[] = [
      { text: label, weight: WEIGHT.label, label: true },
      { text: (setting.words ?? []).map((w) => t(w)).join(" "), weight: WEIGHT.words, label: false },
      { text: group, weight: WEIGHT.group, label: false },
      { text: page, weight: WEIGHT.page, label: false },
      { text: setting.hint === undefined ? "" : t(setting.hint), weight: WEIGHT.hint, label: false },
    ];
    let score = 0;
    const ranges: Range[] = [];
    let all = true;
    for (const term of terms) {
      let best = 0;
      let bestRanges: readonly Range[] | null = null;
      for (const field of fields) {
        if (field.text === "") continue;
        const m = matchTerm(field.text, term, "anchored");
        if (m === null) continue;
        const value = m.score * field.weight;
        if (value > best) {
          best = value;
          bestRanges = field.label ? m.ranges : null;
        }
      }
      if (best === 0) {
        all = false;
        break;
      }
      score += best;
      if (bestRanges !== null) ranges.push(...bestRanges);
    }
    if (!all) continue;
    hits.push({ setting, label, ranges, page, group, score });
  }
  // Best first; a tie keeps registry order, which is page order.
  return hits.toSorted((a, b) => b.score - a.score).slice(0, limit);
}

/** A row's id as the fragment of an address, read back: the setting, or undefined. */
export function settingOfFragment(hash: string): SettingDef | undefined {
  const id = fragmentRowId(hash);
  return id === undefined ? undefined : settingById(id);
}
