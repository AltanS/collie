import { useRef, type FormEvent, type KeyboardEvent } from "react";

import { Icon } from "@/components/icons/icon";
import { SearchField } from "@/components/ui/search-field";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface SessionFilterFieldProps {
  query: string;
  onQuery: (query: string) => void;
  /** The rows the query leaves, and all of them, for the count line (`3 of 14`). */
  shown: number;
  total: number;
  /** Enter, or the keyboard's Go key: open the first row shown. The caller decides what that is. */
  onGo: () => void;
  /** The block's own place: sticky, bleed, padding. The field and the count line are drawn the same way everywhere. */
  className?: string;
}

/**
 * THE SESSION FILTER'S FIELD (M97): the box a person types a loose name into, over a list of sessions.
 * The switcher (the sheet on a phone, the standing sidebar on a large screen) mounts it, and the
 * Dashboard is to mount the same one. It owns the words, the clear button and the count line; the
 * query, the matching and the list belong to the caller (`lib/pane-filter.ts`).
 *
 * - The hint is the placeholder (no label above the field), the field's accessible name the same.
 * - The clear button stands in the field's right edge in a reserved slot: `invisible` while the field
 *   is empty, never unmounted, so the first letter typed moves nothing (DESIGN.md §2). A tap puts the
 *   caret back in the field, because the person is typing there.
 * - The count line is a reserved line under the field, drawn invisible while the field is empty, and
 *   polite to a screen reader (`aria-live`), so each letter's count is read without interrupting.
 * - Enter and the keyboard's Go key open the first row shown (`onGo`): the form's submit catches the Go
 *   key of a keyboard that sends no Enter. Escape clears a query and stops there; a second Escape on an
 *   empty field is left to whatever holds the field (the sheet closes on it).
 * - No autofocus: on a phone the keyboard would cover the list the person just opened. No shortcut is
 *   the way in (mobile first).
 */
export function SessionFilterField({ query, onQuery, shown, total, onGo, className }: SessionFilterFieldProps) {
  useLocale();
  const input = useRef<HTMLInputElement>(null);
  const active = query !== "";
  const name = t("sessionFilter.placeholder");

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      // Handled here, so the form's own submit does not fire a second time.
      e.preventDefault();
      onGo();
      return;
    }
    if (e.key !== "Escape" || !active) return;
    // The sheet closes on an Escape that reaches the window; this one only clears.
    e.preventDefault();
    e.stopPropagation();
    onQuery("");
  };
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onGo();
  };

  return (
    <form role="search" aria-label={name} data-slot="session-filter" onSubmit={onSubmit} className={cn("flex flex-col gap-1", className)}>
      <SearchField
        ref={input}
        value={query}
        onChange={onQuery}
        placeholder={name}
        label={name}
        enterKeyHint="go"
        onKeyDown={onKeyDown}
        trailing={
          <button
            type="button"
            aria-label={t("sessionFilter.clear")}
            onClick={() => {
              onQuery("");
              input.current?.focus();
            }}
            className={cn(
              "absolute right-0 top-0 flex size-11 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              !active && "invisible",
            )}
          >
            <Icon name="clear" className="size-4" aria-hidden />
          </button>
        }
      />
      <p
        aria-live="polite"
        data-slot="session-filter-count"
        className={cn("h-4 truncate px-1 text-[11px]/4 tabular-nums text-muted-foreground", !active && "invisible")}
      >
        {active ? t("sessionFilter.count", { shown, total }) : ""}
      </p>
    </form>
  );
}
