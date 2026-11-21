import { Fragment, useLayoutEffect, useRef, type ReactNode, type RefObject, type UIEventHandler } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router";
import { Icon } from "@/components/icons/icon";

import { RouteHeader } from "@/components/app-header";
import { SETTINGS_COLUMN, useSettingsShell, type SettingsShellApi } from "@/components/settings-shell";
import { Button, FOCUS_RING } from "@/components/ui/button";
import { useEntryScroll } from "@/hooks/use-entry-scroll";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t, type MessageKey } from "@/lib/i18n";
import { settingsPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { cn } from "@/lib/utils";
import { BandMain } from "@/components/ui/strip-host";

// The shell every Settings SECTION page wears: the shell's own header filled with a back button and
// a title, then one scrolling column of cards. Four pages share it, and sharing it is the point —
// four hand-rolled copies of the same header is how the old Settings header drifted from the
// shell's in the first place (see the note in routes/settings.tsx).
//
// Back goes to `/settings`, never home: a section is a CHILD of the index, and ADR 0067 says back
// goes up one level. `nav.up` is what makes a tap and the system gesture agree about that.
//
// A page one level further down (Voice's Host speech and Whistle model) names its own `parent`, so Back
// lands on the section it was opened from.
//
// ON A LARGE SCREEN the page stands in the right column of Settings (components/settings-shell.tsx), which owns the
// one header. The page then draws no header of its own: a plain title (`h1`) at the top of its column, with Back
// beside it on a page one level down or more, and its path as the header's crumbs. The children are the same.
export function SettingsPage({
  title,
  heading,
  parent,
  onScroll,
  foot,
  keepScroll = false,
  headingBelow = false,
  backLabel = "settings.nav.back",
  crumbs,
  action,
  children,
}: {
  title: MessageKey;
  /** A title already in words (an account's own name). It stands in for `title`, which stays the page's key. */
  heading?: string;
  parent?: string;
  /** The column's scroll, for a page whose floating button folds as the list moves (Accounts). */
  onScroll?: UIEventHandler<HTMLElement>;
  /** A band under the scrolling column that holds the page's own button (the Add form's), above the keyboard. */
  foot?: ReactNode;
  /** Keep the column's scroll for this history entry, so a step back from a page below lands where it was (Tricks). */
  keepScroll?: boolean;
  /** The page draws its own `h1` in its column (a trick's details: the trick's name), so the header's title is a plain label. */
  headingBelow?: boolean;
  /** The back button's name (Updates names its own). */
  backLabel?: MessageKey;
  /** The path below the section, for the large screen's header (a trick's name; an account's name, then Change login). Default: the page's title. */
  crumbs?: readonly string[];
  /** The page's primary action at the end of its title row, on a large screen only (Profiles' Add). The phone draws its own. */
  action?: ReactNode;
  children: ReactNode;
}) {
  const nav = useNav();
  const scroller = useRef<HTMLElement | null>(null);
  useEntryScroll(scroller, keepScroll);
  const scope = useScope();
  const shell = useSettingsShell();
  useLocale();

  if (shell !== null) {
    return (
      <WideSettingsPage
        shell={shell}
        name={heading ?? t(title)}
        parent={parent}
        crumbs={crumbs ?? [heading ?? t(title)]}
        headingBelow={headingBelow}
        backLabel={backLabel}
        onScroll={onScroll}
        scroller={scroller}
        foot={foot}
        action={action}
      >
        {children}
      </WideSettingsPage>
    );
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(parent ?? settingsPath(scope))}
              aria-label={t(backLabel)}
            >
              <Icon name="back" className="size-5" />
            </Button>
            {headingBelow ? (
              <p data-slot="settings-page-title" className="min-w-0 truncate text-lg font-semibold tracking-tight">
                {heading ?? t(title)}
              </p>
            ) : (
              <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{heading ?? t(title)}</h1>
            )}
          </>
        }
      />
      {/* `relative` for the same reason the home scroller carries it: an `sr-only` (position:
          absolute) deep in the page would otherwise escape the scroller and grow the document's
          own scrollbar. */}
      <BandMain base={16} onScroll={onScroll} scrollRef={scroller} className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {children}
      </BandMain>
      {foot}
    </div>
  );
}

/** The page in the right column of the large-screen Settings: its title, its path in the header, its own scroll. */
function WideSettingsPage({
  shell,
  name,
  parent,
  crumbs,
  headingBelow,
  backLabel,
  onScroll,
  scroller,
  foot,
  action,
  children,
}: {
  shell: SettingsShellApi;
  name: string;
  parent: string | undefined;
  crumbs: readonly string[];
  headingBelow: boolean;
  backLabel: MessageKey;
  onScroll: UIEventHandler<HTMLElement> | undefined;
  scroller: RefObject<HTMLElement | null>;
  foot: ReactNode;
  action: ReactNode;
  children: ReactNode;
}) {
  const nav = useNav();
  const { key } = useLocation();
  const titleRef = useRef<HTMLElement | null>(null);
  // A row of the list opened this section: its title takes the focus, so the keyboard lands where the reading starts.
  useLayoutEffect(() => {
    if (shell.takeFocus()) titleRef.current?.focus({ preventScroll: true });
  }, [shell, key]);
  const path = parent === undefined || shell.section === null ? null : [shell.section, ...crumbs];
  const titleClass = cn("min-w-0 truncate rounded-sm", FOCUS_RING);
  return (
    <div data-slot="settings-page" className="flex min-h-0 flex-1 flex-col">
      {path !== null && shell.crumbs !== null
        ? createPortal(
            <p data-slot="settings-path" className="flex min-w-0 items-center gap-2 pl-2 text-sm text-muted-foreground">
              {path.map((part, i) => (
                <Fragment key={i}>
                  <span aria-hidden="true">/</span>
                  <span className={cn("truncate", i === path.length - 1 ? "min-w-0 text-foreground" : "max-w-64 shrink-0")}>{part}</span>
                </Fragment>
              ))}
            </p>,
            shell.crumbs,
          )
        : null}
      <BandMain base={16} onScroll={onScroll} scrollRef={scroller} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div data-slot="settings-column" className={cn(SETTINGS_COLUMN, "flex flex-col space-y-4 pt-4 pb-8")}>
          <div data-slot="settings-page-head" className="flex min-h-11 items-center gap-1">
            {parent !== undefined && (
              // One level up, as the phone header's arrow on this page. -12px: the arrow's drawing stands on the column's edge.
              <Button variant="ghost" size="icon" className="-ml-3 size-11" onClick={() => nav.up(parent)} aria-label={t(backLabel)}>
                <Icon name="back" className="size-5" />
              </Button>
            )}
            {headingBelow ? (
              // The page draws its own `h1` below (a trick's name); this is the plain label the phone header carries.
              <p ref={(el) => void (titleRef.current = el)} tabIndex={-1} data-slot="settings-page-title" className={cn(titleClass, "text-base font-semibold text-muted-foreground")}>
                {name}
              </p>
            ) : (
              <h1 ref={(el) => void (titleRef.current = el)} tabIndex={-1} className={cn(titleClass, "text-xl font-semibold tracking-tight")}>
                {name}
              </h1>
            )}
            {action !== undefined && <div className="ml-auto flex shrink-0 items-center">{action}</div>}
          </div>
          {children}
        </div>
      </BandMain>
      {/* The page's band (a form's button) ends on the column's edges: the column's gutter, and none of the band's own. */}
      {foot !== undefined && <div data-slot="settings-foot" className={cn(SETTINGS_COLUMN, "[&>*]:px-0")}>{foot}</div>}
    </div>
  );
}
