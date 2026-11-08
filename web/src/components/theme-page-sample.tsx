import type { CSSProperties } from "react";

import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { glyphSetName } from "@/lib/glyph-sets";
import { markName } from "@/lib/mark-ids";
import { isShippedFont } from "@/lib/shipped-fonts";
import { FALLBACK_KEYS, HALF_KEYS } from "@/lib/theme/report-words";
import { DEFAULT_THEME_ID, THEME_TOKENS, fillHalves, knownCharacter, knownGlyphs, themeFallbacks, type Theme } from "@/lib/theme/schema";
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
 * display face, the icon the stroke and the glyph set, the label the label case, and the two rows the rows rule in
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
        <Icon name="theme" set={knownGlyphs(theme) ?? "lucide"} className="size-3.5 shrink-0" />
        <span className="truncate text-xs font-semibold [font-family:var(--font-display)]">{theme.name}</span>
      </div>
      <div className="bg-background px-2 pt-1.5 pb-2 [background-image:var(--ground-image)] [background-size:var(--ground-size)]">
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
  const character = knownCharacter(theme);
  if (character === undefined) return null;
  return (
    <div data-testid="theme-mark-line" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
      <span className="grid size-7 shrink-0 place-items-center">
        <BrandMark mark={character} size={28} weight="header" paper="var(--card)" />
      </span>
      <span className="min-w-0 truncate">{t("theme.preview.mark", { name: markName(character) })}</span>
    </div>
  );
}

/** The five glyphs the preview draws in a theme's set: the ones a person sees on every screen. */
const SAMPLE_GLYPHS = ["close", "send", "settings", "back", "attach"] as const satisfies readonly IconKey[];

/**
 * The glyph set a theme names, as five sample icons beside its name ("Icons: Phosphor Duotone"), or
 * nothing when the theme names none. The set is passed explicitly: the preview shows this theme's
 * set, not the worn one's. The icons load the set's chunk on their own and draw lucide until it lands.
 */
export function ThemeGlyphsLine({ theme }: { theme: Theme }) {
  useLocale();
  const set = knownGlyphs(theme);
  if (set === undefined) return null;
  return (
    <div data-testid="theme-glyphs-line" className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1.5 text-foreground">
        {SAMPLE_GLYPHS.map((name) => (
          <Icon key={name} name={name} set={set} className="size-4" />
        ))}
      </span>
      <span className="min-w-0 truncate">{t("theme.preview.glyphs", { name: glyphSetName(set) })}</span>
    </div>
  );
}

/**
 * One line for each decoration word of a theme this Collie does not have ("This Collie does not have
 * the icon set "x"; it shows the standard icons."), or nothing. The theme still loads; the line says
 * what this Collie draws instead. The word arrives escaped and quoted (`themeFallbacks`, F4).
 */
export function ThemeFallbackLines({ theme }: { theme: Theme }) {
  useLocale();
  const fallbacks = themeFallbacks(theme);
  if (fallbacks.length === 0) return null;
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted-foreground">
      {fallbacks.map((fallback) => (
        <li key={fallback.path} data-testid="theme-fallback-line">
          {t(FALLBACK_KEYS[fallback.part], { word: fallback.word, path: fallback.path })}
        </li>
      ))}
    </ul>
  );
}
