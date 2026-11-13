// "Character picker": the real Character page (components/character-picker.tsx) in every shipped theme,
// light and dark, at the two phone widths, then the two candidate heads for the Collie collar.
//
// DEV-ONLY, unreachable from the app entry.
//
// THE MOTION SWITCH, in both states, is the page's own row (`CharacterMovesRow`) given a fixed value
// and no store, because the real page reads this device's one choice and could show only one state.
// Its first row's border-top is the card's own, so the frame sits it in a Card as Settings does.
//
// THE PAGE IS THE REAL COMPONENT. Each frame mounts `CharacterPicker` itself, under the theme's own
// colours (the same declarations `PageSample` sets on its box), so a row, a column head and a mark are
// the ones the app draws. Two honest limits: a tap on any row writes this device's real choice (the
// store is one for the whole page), and "From the theme" names the worn theme's character, not the
// frame's, because the worn theme is the page's, not the frame's.
//
// THE COLLAR CARDS draw the shipped collar and a variant of it whose marking is ink at 55%. The shipped
// one is reached through `loadMark`, the registry's own door, because a static import of a chunked mark
// from anywhere under src is a failing case in brand-mark.test.tsx (the chunk would leave its folder).

import { lazy, Suspense, type ReactNode } from "react";

import { loadMark } from "@/components/brand-mark";
import { CharacterMovesRow, CharacterPicker } from "@/components/character-picker";
import { collieFamilyMark } from "@/components/collie-mark";
import { COLLIE_COLLAR_GREY_HEAD } from "@/components/collie-collar-grey-head";
import { collieTheme, displayOf, styleOf } from "@/components/theme-page-sample";
import { THEME_TOKENS, fillHalves, type Theme } from "@/lib/theme/schema";
import { shippedThemes } from "@/lib/theme/store";
import { fullSurfaceDeclarations, type Declaration } from "@/lib/theme/surface";
import { cn } from "@/lib/utils";

import { Card as ShellCard } from "@/components/ui/card";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = { id: "character-picker", title: "Character picker" };

type Half = "light" | "dark";

const HALVES = ["light", "dark"] as const satisfies readonly Half[];
const WIDTHS = [360, 390] as const;
const SIZES = [24, 48, 96] as const;

/** One half of a theme as a page of the given width: its colours and words on one box. */
function ThemeFrame({ theme, half, width, children }: { theme: Theme; half: Half; width?: number; children: ReactNode }) {
  const filled = fillHalves(theme, collieTheme())[half];
  const colours = THEME_TOKENS.flatMap((token): Declaration[] => {
    const value = filled[token];
    return value === undefined ? [] : [[`--${token}`, value]];
  });
  const style = { ...styleOf([...colours, ...fullSurfaceDeclarations(theme.surface), ...displayOf(theme)]), colorScheme: half, width };
  return (
    <div
      style={style}
      className={cn("box-border max-w-full shrink-0 overflow-hidden rounded-xl border border-border bg-background p-4 text-foreground", half === "dark" && "dark")}
    >
      {children}
    </div>
  );
}

/** The collar that ships: the registry's own component, loaded the way the header loads it. */
const ShippedCollar = lazy(async () => ({ default: await loadMark("collie-collar") }));

/** The collar with its marking at 55% grey. Made once, here: a fresh component per render would remount every mark. */
const GreyCollar = collieFamilyMark("collie-collar", COLLIE_COLLAR_GREY_HEAD);

/** The candidate at a few sizes, in one half. Held still: it is the drawing that is being judged. */
function Sizes({ half, which }: { half: Half; which: "shipped" | "grey" }) {
  return (
    <ThemeFrame theme={collieTheme()} half={half}>
      <p className="mb-2 font-mono text-[10px] uppercase text-muted-foreground">{half}</p>
      <div className="flex flex-wrap items-end gap-6">
        {SIZES.map((size) => (
          <div key={size} className="flex flex-col items-center gap-1.5">
            {which === "grey" ? (
              <GreyCollar size={size} weight={size < 80 ? "header" : "full"} turn={0} />
            ) : (
              <Suspense fallback={<span style={{ width: size, height: size }} className="inline-block" />}>
                <ShippedCollar size={size} weight={size < 80 ? "header" : "full"} turn={0} />
              </Suspense>
            )}
            <span className="font-mono text-[10px] text-muted-foreground">{size}</span>
          </div>
        ))}
      </div>
    </ThemeFrame>
  );
}

export function CharacterPickerSection() {
  return (
    <Section def={DEF}>
      <Group title="The page, every theme">
        {shippedThemes().map((theme, i) => (
          <Card key={theme.id} state={`character-picker-${theme.id}`} label={`${i + 1}. ${theme.name}`} span="all">
            <div className="flex flex-wrap items-start gap-4">
              {HALVES.flatMap((half) =>
                WIDTHS.map((width) => (
                  <div key={`${half}-${width}`} className="flex flex-col gap-1">
                    <p className="font-mono text-[10px] uppercase text-muted-foreground">
                      {half} {width}
                    </p>
                    <ThemeFrame theme={theme} half={half} width={width}>
                      <CharacterPicker />
                    </ThemeFrame>
                  </div>
                )),
              )}
            </div>
          </Card>
        ))}
      </Group>
      <Group title="The motion switch">
        {([true, false] as const).map((moves, i) => (
          <Card key={String(moves)} state={moves ? "character-moves-on" : "character-moves-off"} label={`${i + 1}. ${moves ? "Moves, on" : "Still, off"}`} span="all">
            <div className="flex flex-wrap items-start gap-4">
              {HALVES.map((half) => (
                <div key={half} className="flex flex-col gap-1">
                  <p className="font-mono text-[10px] uppercase text-muted-foreground">{half}</p>
                  <ThemeFrame theme={collieTheme()} half={half} width={390}>
                    <ShellCard className="gap-0 py-0 [&_[data-slot=character-moves]]:border-t-0">
                      <CharacterMovesRow moves={moves} onChange={() => {}} />
                    </ShellCard>
                  </ThemeFrame>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </Group>
      <Group title="The collar head">
        <Card state="character-collar-page" label="1. Collar in the page colour (ships)" span={2}>
          <div className="flex flex-wrap gap-4">
            {HALVES.map((half) => (
              <Sizes key={half} half={half} which="shipped" />
            ))}
          </div>
        </Card>
        <Card state="character-collar-grey" label="2. Collar at 55% grey" span={2}>
          <div className="flex flex-wrap gap-4">
            {HALVES.map((half) => (
              <Sizes key={half} half={half} which="grey" />
            ))}
          </div>
        </Card>
      </Group>
    </Section>
  );
}
