import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SearchField } from "@/components/ui/search-field";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import { lazyChunk } from "@/lib/lazy-route";
import { scopeSearch } from "@/lib/scope";
import { useScope } from "@/lib/session";
import { cn } from "@/lib/utils";

/**
 * The results and the registry they read: a chunk of their own (ADR 0169 `lazyChunk`), loaded on the first word
 * typed and fetched by the idle preload before that. A chunk that a new build removed reloads the app once.
 */
const loadResults = lazyChunk(() => import("./settings-search-results"));
const Results = lazy(loadResults);

// THE SEARCH OF SETTINGS (ADR 0170). One field at the top of the phone's index and of the large screen's list. It
// reads the registry, so it finds every declared row, those of a pane's own sheets and of a view too:
//
//   - a row on a page opens that page with the row's id as the fragment; the page scrolls to it and marks it
//     (components/settings-page.tsx);
//   - a row that lives only in a pane, a view or the New page says where it is, and has no link;
//   - a row shown only in a state that is not this one says why, in one line, and has no link.
//
// While the field holds words, the results stand where the list was: the list and the results never show at once,
// so the field never pushes a list down under itself. Escape clears the field; `/` puts the cursor in it while
// Settings has the focus and no text field does (the shortcut table binds `/` only after the prefix, as Find).

/**
 * The field, and in place of `children` (the list) its results while it holds words. `compact`: the large screen's
 * list column, whose rows are 44px with no second line; the phone's index draws its results as a card's rows.
 */
export function SettingsSearch({ compact = false, children }: { compact?: boolean; children: ReactNode }) {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const [query, setQuery] = useState("");
  const field = useRef<HTMLInputElement | null>(null);
  // The path Enter opens, as the results last reported it.
  const firstPath = useRef<string | null>(null);
  const onFirstPath = useCallback((path: string | null) => {
    firstPath.current = path;
  }, []);

  // `/` focuses the field while Settings has the focus and no text field does, unless a binding already took it.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable || active.closest("input, textarea, select") !== null)) return;
      if (document.querySelector("[role=dialog][aria-modal=true]") !== null) return;
      event.preventDefault();
      field.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const open = (path: string) => {
    // The scope rides in the query, before the fragment.
    const at = path.indexOf("#");
    const to = `${path.slice(0, at)}${scopeSearch(scope)}${path.slice(at)}`;
    setQuery("");
    nav.down(to);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      return;
    }
    if (event.key !== "Enter") return;
    const path = query.trim() === "" ? null : firstPath.current;
    if (path === null) return;
    event.preventDefault();
    open(path);
  };

  const searching = query.trim() !== "";
  return (
    <div data-slot="settings-search" className={cn("flex flex-col", compact ? "gap-1" : "gap-4")}>
      <SearchField
        ref={field}
        value={query}
        onChange={setQuery}
        placeholder={t("settings.search.placeholder")}
        label={t("settings.search.label")}
        enterKeyHint="go"
        onKeyDown={onKeyDown}
        inputClassName={compact ? "bg-background" : undefined}
        trailing={
          <Button
            variant="ghost"
            size="icon"
            className={cn("absolute top-0 right-0 size-11", !searching && "invisible")}
            aria-label={t("settings.search.clear")}
            tabIndex={searching ? 0 : -1}
            onClick={() => {
              setQuery("");
              field.current?.focus();
            }}
          >
            <Icon name="close" className="size-4" />
          </Button>
        }
      />
      {searching ? (
        <Suspense fallback={null}>
          {compact ? (
            <Results query={query} onOpen={open} onFirstPath={onFirstPath} compact />
          ) : (
            <Card className="gap-0 py-0" data-slot="settings-search-card">
              <Results query={query} onOpen={open} onFirstPath={onFirstPath} compact={false} />
            </Card>
          )}
        </Suspense>
      ) : (
        children
      )}
    </div>
  );
}
