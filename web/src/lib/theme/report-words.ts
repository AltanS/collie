// The words a theme check prints, as message keys: one headline per refusal code, the name of each
// half, and the contrast warning line (M59).
//
// Two readers print them. The Theme card in Settings resolves each key through `t()`, in the
// device's language. `collie theme check` resolves the same keys in the English bundle, so a
// person who checks a file in a terminal reads the sentence the phone would show them. One table,
// two readers: a new refusal code cannot reach one and skip the other.
//
// This file imports types only, like `schema.ts`, so the CLI can load it without a DOM or React.

import type { MessageKey } from "../i18n/messages/en";
import type { TemplateVars } from "../i18n/template";
import type { FallbackPart, Refusal, RefusalCode, RefusalContrast } from "./schema";

/** The refusal headlines, one per parser code. A record, so a new code cannot skip a sentence. */
export const REFUSAL_KEYS = {
  size: "theme.refusal.size",
  json: "theme.refusal.json",
  version: "theme.refusal.version",
  id: "theme.refusal.id",
  name: "theme.refusal.name",
  author: "theme.refusal.author",
  "unknown-key": "theme.refusal.unknown-key",
  value: "theme.refusal.value",
  font: "theme.refusal.font",
  "no-half": "theme.refusal.no-half",
  "reserved-id": "theme.refusal.reserved-id",
  surface: "theme.refusal.surface",
  ansi: "theme.refusal.ansi",
  character: "theme.refusal.mark",
  unreadable: "theme.refusal.unreadable",
  glyphs: "theme.refusal.glyphs",
} as const satisfies Record<RefusalCode, MessageKey>;

/** The headline of a file made for a newer Collie: `{version}` is the version it says. */
export const NEWER_VERSION_KEY = "theme.refusal.version-newer" satisfies MessageKey;

/** The headline of a contrast refusal: `{ink} on {ground} measures {ratio}`, below `{floor}`. */
export const CONTRAST_REFUSAL_KEY = "theme.refusal.contrast" satisfies MessageKey;

/** A refusal's headline: its key, and the values its slots take. */
export type RefusalHeadline =
  | { key: MessageKey }
  | { key: typeof NEWER_VERSION_KEY; vars: { version: number } }
  | { key: typeof CONTRAST_REFUSAL_KEY; vars: RefusalContrast };

/**
 * The headline of a refusal, in one place for both readers. A file that says a newer version reads
 * "made for a newer Collie" with the version; a contrast refusal names its two colours, the measured
 * ratio and the floor; every other refusal reads its code's sentence.
 */
export function refusalHeadline(refusal: Refusal): RefusalHeadline {
  if (refusal.newerVersion !== undefined) return { key: NEWER_VERSION_KEY, vars: { version: refusal.newerVersion } };
  if (refusal.contrast !== undefined) return { key: CONTRAST_REFUSAL_KEY, vars: refusal.contrast };
  return { key: REFUSAL_KEYS[refusal.code] };
}

/** The values a headline's slots take, or undefined for a headline with none. */
export function headlineVars(headline: RefusalHeadline): TemplateVars | undefined {
  if (!("vars" in headline)) return undefined;
  if (headline.key === NEWER_VERSION_KEY) return { version: headline.vars.version };
  const { ink, ground, ratio, floor } = headline.vars;
  return { ink, ground, ratio, floor };
}

/** The line for a decoration word this Collie does not know, one per part. `{word}` is escaped and quoted. */
export const FALLBACK_KEYS = {
  glyphs: "theme.fallback.glyphs",
  character: "theme.fallback.character",
  ground: "theme.fallback.ground",
  font: "theme.fallback.font",
} as const satisfies Record<FallbackPart, MessageKey>;

/** The name of each half, as the picker and the contrast line say it. */
export const HALF_KEYS = {
  light: "settings.theme.option.light",
  dark: "settings.theme.option.dark",
} as const satisfies Record<"light" | "dark", MessageKey>;

/** The contrast warning line: `{half}: {check} measures {ratio}. The floor is {floor}.` */
export const CONTRAST_FAIL_KEY = "theme.preview.contrast.fail" satisfies MessageKey;

const MORE_PATTERN = /^and \d+ more$/;

/** True for the parser's closing line ("and 12 more"), which counts causes rather than naming one. */
export function isMoreLine(refusal: Refusal): boolean {
  return refusal.code === "json" && refusal.path === "$" && MORE_PATTERN.test(refusal.detail);
}
