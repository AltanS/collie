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
import type { FallbackPart, Refusal, RefusalCode } from "./schema";

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
