import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { OPTIONAL_THEME_TOKENS, parseTheme, type Half } from "@/lib/theme/schema";

// COLLIE'S TWO HALVES FOR A VERSION 1 OR 2 FIXTURE. The theme specs build an imported theme from
// `src/themes/collie.json` and change one or two tokens. Since schema version 3 (ADR 0120) that file
// names the optional token `pane-active`, and the parser refuses an optional token in a file that
// says version 1 or 2 (`lib/theme/schema.ts`). Such a fixture would be dropped from the library at
// load, so the app would fall back to `collie` and the case would measure the default look. These
// halves leave every optional token out, so a fixture stays the version it says.

const raw = readFileSync(resolve(import.meta.dirname, "../../src/themes/collie.json"), "utf8");
// The app's own parser reads the file, as the store does for a shipped theme (64 KiB is its cap).
const parsed = parseTheme(raw, { maxBytes: 64 * 1024, allowReservedId: true });
if (!parsed.ok) throw new Error(`collie.json is refused: ${parsed.refusals[0]?.detail ?? ""}`);
const collie = parsed.theme;

/** One half with every optional token left out. */
function requiredOnly(half: Half | undefined): Half {
  const out: Half = { ...half };
  for (const token of OPTIONAL_THEME_TOKENS) delete out[token];
  return out;
}

/** `collie.json`'s light and dark halves with the 43 required tokens only. */
export const collieHalves = { light: requiredOnly(collie.light), dark: requiredOnly(collie.dark) } as const;
