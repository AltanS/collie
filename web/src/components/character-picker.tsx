import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { BrandMark, preloadMark } from "@/components/brand-mark";
import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { setDesignMark, useDesignPrefs } from "@/lib/design";
import { t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n/messages/en";
import { useThemeMarkId } from "@/lib/mark";
import { MARK_IDS, markName, type MarkId } from "@/lib/mark-ids";
import { cn } from "@/lib/utils";

// The Character page: which character the header draws on this device. "From the theme" is the
// default and is stored as the ABSENCE of the field (lib/design.ts), so a device that goes back to it
// stores what a device that never chose stores. The others are fixed ids (lib/mark-ids.ts).
//
// One row per choice, each showing the character three ways in three columns under their heads:
// Still (held), Loading (the fast turn) and Idle (dimmed and held). A native <select> cannot hold a
// drawing, so this is a radio group of rows. "From the theme" draws the character the worn theme
// would give, so the row shows what it means.
//
// HOW COST IS KEPT LOW. Eleven rows is thirty-three marks, and a running animation asks for a frame
// every vsync (issue 748, mark-contract.ts). So the page holds ONE IntersectionObserver for all its
// rows, tracks which rows are on screen, and gives every mark in a row that is not `turn={0}`, which
// pauses all of its animations (`data-still`). A row starts as not visible and is let go only when
// the observer says it is on screen. The Still column is always held. Where the page has no
// IntersectionObserver every mark stays still: a held mark costs nothing and is never wrong.
//
// THE MARKS ARE DRAWN ON THE CARD (`paper="var(--card)"`), because the knockout that makes a bead
// read as in front of the head must be the colour it sits on. A selected row therefore cannot be a
// filled pill: the fill would show as a halo around every bead. Selection is a check in a slot that
// is always there, so choosing repaints and re-lays-out nothing (DESIGN.md §2).
//
// CHARACTER NAMES ARE PROPER NOUNS and are not translated; "From the theme" and the heads are phrases.

const MARK_SIZE = 28;

type Choice = MarkId | "theme";

const CHOICES: readonly Choice[] = ["theme", ...MARK_IDS];

const COLUMNS = [
  { state: "rest", head: "settings.character.still" },
  { state: "loading", head: "settings.character.loading" },
  { state: "idle", head: "settings.character.idle" },
] as const satisfies readonly { state: "rest" | "loading" | "idle"; head: MessageKey }[];

/** The mark column's width: wide enough for the head "Loading" and a 28 px mark. */
const COLUMN = "w-10 shrink-0";

/** One row's keys: the choice at the end of a step, wrapping round. */
function stepFrom({ index, key }: { index: number; key: string }): number | null {
  const last = CHOICES.length - 1;
  if (key === "ArrowDown" || key === "ArrowRight") return index === last ? 0 : index + 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return index === 0 ? last : index - 1;
  if (key === "Home") return 0;
  if (key === "End") return last;
  return null;
}

/** The page's own list of characters: the card of this page. Device-local, like the typeface. */
export function CharacterPicker() {
  useLocale();
  const chosen: Choice = useDesignPrefs().mark ?? "theme";
  const fromTheme = useThemeMarkId();
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const ids = useId();
  // The rows on screen. Empty to begin with: a row is held until the observer has seen it.
  const [visible, setVisible] = useState<ReadonlySet<string>>(() => new Set());

  // The chunks of the nine other characters, fetched once so the rows are not empty boxes.
  useEffect(() => {
    for (const id of MARK_IDS) void preloadMark(id);
  }, []);

  // ONE observer for the page. It keeps the set of rows on screen; no row has an observer of its own.
  useEffect(() => {
    const list = listRef.current;
    if (list === null || globalThis.IntersectionObserver === undefined) return;
    const observer = new IntersectionObserver((entries) => {
      setVisible((before) => {
        const next = new Set(before);
        for (const entry of entries) {
          const row = entry.target.getAttribute("data-row");
          if (row === null) continue;
          if (entry.isIntersecting) next.add(row);
          else next.delete(row);
        }
        return next.size === before.size && [...next].every((row) => before.has(row)) ? before : next;
      });
    });
    for (const row of list.querySelectorAll("[data-row]")) observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const select = (choice: Choice) => {
    if (choice === chosen) return;
    setDesignMark(choice === "theme" ? null : choice);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, index: number) => {
    const to = stepFrom({ index, key: event.key });
    if (to === null) return;
    const target = CHOICES[to];
    if (target === undefined) return;
    event.preventDefault();
    rowRefs.current[to]?.focus();
    select(target);
  };

  return (
    <Card className="gap-0 py-0" data-slot="character-picker">
      <p className="p-4 text-sm text-muted-foreground">{t("settings.character.description")}</p>

      <div className="flex items-end gap-2 border-t border-border px-4 pt-2 pb-1 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1" />
        {COLUMNS.map((column) => (
          <span key={column.state} className={cn(COLUMN, "text-center")}>
            {t(column.head)}
          </span>
        ))}
        <span className="size-4 shrink-0" />
      </div>

      <div ref={listRef} role="radiogroup" aria-label={t("settings.character.title")} data-slot="list-group" className="border-t border-border">
        {CHOICES.map((choice, index) => {
          const selected = choice === chosen;
          const isTheme = choice === "theme";
          const mark = isTheme ? fromTheme : choice;
          const onScreen = visible.has(choice);
          const nameId = `${ids}-${choice}-name`;
          const subId = `${ids}-${choice}-sub`;
          return (
            <button
              key={choice}
              ref={(node) => {
                rowRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-labelledby={nameId}
              aria-describedby={isTheme ? subId : undefined}
              // One stop in the group, on the chosen row; the arrow keys walk the rest.
              tabIndex={selected ? 0 : -1}
              data-row={choice}
              onClick={() => select(choice)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className="flex min-h-11 w-full items-center gap-2 border-b border-border px-4 py-2 text-left text-sm transition-colors last:border-b-0 active:bg-muted/60"
            >
              <span className="min-w-0 flex-1">
                <span id={nameId} className="block font-medium [overflow-wrap:anywhere]">
                  {isTheme ? t("settings.character.fromTheme") : markName(choice)}
                </span>
                {isTheme && (
                  <span id={subId} className="block text-xs text-muted-foreground">
                    {markName(fromTheme)}
                  </span>
                )}
              </span>
              {COLUMNS.map((column) => (
                <span key={column.state} className={cn(COLUMN, "grid h-7 place-items-center")}>
                  <BrandMark
                    mark={mark}
                    size={MARK_SIZE}
                    weight="header"
                    paper="var(--card)"
                    state={column.state}
                    // Still is always held. The other two turn only while their row is on screen.
                    turn={column.state === "rest" || !onScreen ? 0 : undefined}
                  />
                </span>
              ))}
              <span className="grid size-4 shrink-0 place-items-center">{selected && <Icon name="done" aria-hidden className="size-4 text-foreground" />}</span>
            </button>
          );
        })}
      </div>

      <p className="border-t border-border p-4 text-sm text-muted-foreground">{t("settings.character.note")}</p>
    </Card>
  );
}
