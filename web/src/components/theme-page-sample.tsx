import type { CSSProperties } from "react";
import { Palette } from "lucide-react";

import { BrandMark } from "@/components/brand-mark";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { markName } from "@/lib/mark-ids";
import { isShippedFont } from "@/lib/shipped-fonts";
import { HALF_KEYS } from "@/lib/theme/report-words";
import { DEFAULT_THEME_ID, THEME_TOKENS, fillHalves, type Theme } from "@/lib/theme/schema";
import { shippedThemes } from "@/lib/theme/store";
import { displayDeclarations, fullSurfaceDeclarations, type Declaration } from "@/lib/theme/surface";

// A theme drawn small, in its own colours and words, without applying it: the import preview sheet
// draws one per half, and so does every row of the community Browse sheet (M59 spec 06). Its own
// module so both sheets import it and neither imports the other.

/** The default theme, the base a theme's missing tokens are filled from. */
export function collieTheme(): Theme {
  const found = shippedThemes().find((theme) => theme.id === DEFAULT_THEME_ID);
  if (found === undefined) throw new Error(`the shipped theme ${DEFAULT_THEME_ID} is missing`);
  return found;
}

/** The display face a file names, or the UI face: the declaration a sample box sets for its titles. */
export function displayOf(theme: Theme): readonly Declaration[] {
  const face = theme.fonts?.display;
  return face !== undefined && isShippedFont(face) ? displayDeclarations(face) : [["--font-display", "var(--font-sans)"]];
}

/** Declarations as a style object. */
export function styleOf(declarations: readonly Declaration[]): CSSProperties {
  // SAFETY: React passes custom properties through to the style attribute verbatim; the cast exists
  // only because CSSProperties has no index signature for `--*`. Names come from surface.ts and the
  // token list, values from the table or from the parser's checked colours.
  return Object.fromEntries(declarations) as CSSProperties;
}

/**
 * One half of the file as a small page: the half's colours (a token it leaves out from `collie`) and
 * the file's words as custom properties on one box, its `color-scheme` set to the half. The band reads
 * `--band-ground` and `--band-rule`, the ground `--background` and `--ground-image`, the title the
 * display face, the icon the stroke, the label the label case, and the two rows the rows rule in
 * index.css. Decorative: the words below say the same in text.
 */
export function PageSample({ theme, half }: { theme: Theme; half: "light" | "dark" }) {
  useLocale();
  const filled = fillHalves(theme, collieTheme())[half];
  const colours = THEME_TOKENS.flatMap((token): Declaration[] => {
    const value = filled[token];
    return value === undefined ? [] : [[`--${token}`, value]];
  });
  const style = { ...styleOf([...colours, ...fullSurfaceDeclarations(theme.surface), ...displayOf(theme)]), colorScheme: half };
  return (
    <div
      aria-hidden
      data-testid={`theme-page-sample-${half}`}
      style={style}
      className="overflow-hidden rounded-md border border-border text-foreground"
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-band-rule bg-band-ground px-2">
        <Palette className="size-3.5 shrink-0" />
        <span className="truncate text-xs font-semibold [font-family:var(--font-display)]">{theme.name}</span>
      </div>
      <div className="bg-background px-2 pt-1.5 pb-2 [background-image:var(--ground-image)]">
        <SectionLabel placement="above">{t(HALF_KEYS[half])}</SectionLabel>
        <div data-slot="list-group" className="flex flex-col rounded-sm border-[length:var(--row-rule)] border-rule">
          <div className="h-4" />
          <div className="h-4" />
        </div>
      </div>
    </div>
  );
}


/**
 * The character a theme names, drawn small beside its name ("Character: Kawaii"), or nothing when the theme names
 * none. The mark is passed explicitly: the preview shows this theme's character, not the worn theme's.
 * It is drawn on the card colour, because both sheets that show it sit on the card.
 */
export function ThemeMarkLine({ theme }: { theme: Theme }) {
  useLocale();
  if (theme.character === undefined) return null;
  return (
    <div data-testid="theme-mark-line" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
      <span className="grid size-7 shrink-0 place-items-center">
        <BrandMark mark={theme.character} size={28} weight="header" paper="var(--card)" />
      </span>
      <span className="min-w-0 truncate">{t("theme.preview.mark", { name: markName(theme.character) })}</span>
    </div>
  );
}
