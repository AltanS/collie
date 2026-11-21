import type { Page } from "@playwright/test";

import { SHIPPED_THEME_IDS, type Theme } from "@/lib/theme/schema";

import { STILL_MARK } from "../fixtures/still-mark";

// THE LOOKS R5 WEARS. A look is a theme in one half: the four bundled themes in light and in dark are the eight a person
// can pick, and a generated theme (`generate.ts`) is imported into the device's library and worn the way an imported
// file is, through the same store.

export interface Look {
  /** `collie-dark`, `harbour-light`, `gen-07-flat`: the name a break line and a waiver use. */
  id: string;
  scheme: "light" | "dark";
  /** A bundled theme's id; `collie` is the app's own look and is worn by naming no theme. */
  theme?: string;
  /** An imported theme, already parsed. */
  imported?: Theme;
}

function bundledLooks(): Look[] {
  const looks: Look[] = [];
  for (const theme of SHIPPED_THEME_IDS) {
    for (const scheme of ["light", "dark"] as const) {
      const look: Look = { id: `${theme}-${scheme}`, scheme };
      if (theme !== "collie") look.theme = theme;
      looks.push(look);
    }
  }
  return looks;
}

export const BUNDLED_LOOKS: readonly Look[] = bundledLooks();

/** Put the look on before the page's first script runs: the scheme, the theme, and for an import the library that holds it. */
export async function wearLook(page: Page, look: Look): Promise<void> {
  await page.emulateMedia({ colorScheme: look.scheme });
  const themeId = look.imported?.id ?? look.theme;
  const design = JSON.stringify(themeId === undefined ? STILL_MARK : { ...STILL_MARK, theme: themeId });
  const library = look.imported === undefined ? null : JSON.stringify({ version: 1, themes: [look.imported] });
  await page.addInitScript(
    ([scheme, d, lib]) => {
      localStorage.setItem("collie:theme:v1", scheme);
      localStorage.setItem("collie:design:v1", d);
      if (lib !== null) localStorage.setItem("collie:themes:v1", lib);
    },
    [look.scheme, design, library] as const,
  );
}

/** After the page has settled: the theme it actually wears, so a look that fell back to Collie cannot pass for itself. */
export function wornTheme(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}
