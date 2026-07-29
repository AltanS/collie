import { useEffect, useMemo, useRef } from "react";
import { Search, TerminalSquare, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agent-icon";
import { SectionHeader } from "@/components/section-header";
import { StatusDot } from "@/components/status-badge";
import { timeAgoShort } from "@/lib/format";
import { paneParts, paneSearchText } from "@/lib/pane-name";
import {
  ageBasisFor,
  ageStampOf,
  bucketOf,
  isAttention,
  sectionHeaderProps,
  TRIAGE_ORDER,
  triage,
  type AgeBasis,
} from "@/lib/triage";
import { STATUS_LABEL } from "@/lib/types";
import type { AgentView } from "@/lib/types";

/** Panes above which the filter field appears. Below it, scanning is faster than typing. */
export const FILTER_FROM = 8;

/** Whether a herd of this size gets a filter field. Exported so the sheet that OWNS the field (it
 *  lives in the sticky header, not the scrolling body) applies the same rule this list does. */
export function shouldFilter(total: number): boolean {
  return total >= FILTER_FROM;
}

/** Rows the "Here" section will spend before handing the rest to the space route. */
const HERE_CAP = 5;

/**
 * The one ordering this component uses everywhere: most urgent bucket first, then most recently
 * active. Extracted because the FILTERED list used to skip it and render raw snapshot order — so
 * typing "moonward" listed a blocked pane 7th, below four idle ones, in a sheet whose whole contract
 * is that it and the dashboard "must not disagree about what needs you".
 */
function byUrgencyThenRecency(x: AgentView, y: AgentView): number {
  return (
    TRIAGE_ORDER.indexOf(bucketOf(x)) - TRIAGE_ORDER.indexOf(bucketOf(y)) ||
    (y.lastActiveAt ?? 0) - (x.lastActiveAt ?? 0)
  );
}

/** The panes a query selects, in the same order the sections use. Empty query → no matches (the
 *  caller shows the sectioned list instead). */
export function matchPanes(all: readonly AgentView[], query: string): AgentView[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return all.filter((p) => paneSearchText(p).toLowerCase().includes(q)).sort(byUrgencyThenRecency);
}

interface ThreadSidebarProps {
  agents: AgentView[];
  /** Bare shell panes (no agent) — listed in a trailing "Shells" group so fresh spaces are reachable. */
  shellPanes?: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** The space the open pane lives in — what the "Here" section is scoped to. Omit to drop it. */
  currentSpaceId?: string;
  /** Open the space route (the overflow target when a space holds more panes than "Here" shows). */
  onOpenSpace?: (spaceId: string) => void;
  /** Whether the Recent section is expanded, and how to fold it. Omit to leave it always open. */
  recentOpen?: boolean;
  onRecentOpenChange?: (open: boolean) => void;
  /** Whether the Shells section is expanded, and how to fold it. Omit to leave it always open. */
  shellsOpen?: boolean;
  onShellsOpenChange?: (open: boolean) => void;
  /**
   * The live filter query. Owned by the sheet, not by this list: the field lives in the sheet's
   * STICKY header so it survives scrolling a list that runs several screens deep, and so it stops
   * sliding down the viewport as the panel shrinks around a narrowing result set.
   */
  query?: string;
  /** Clear the query — wired to the no-match state's escape hatch. */
  onClearQuery?: () => void;
  /** Override the list container padding (e.g. flush inside a bottom sheet). */
  className?: string;
}

// The pane switcher behind the swipe-up "Switch pane" sheet: every agent pane grouped and sorted
// exactly like the dashboard (lib/triage.ts — the two must not disagree about what needs you), then
// any bare shell panes under a trailing "Shells" group, with the open one highlighted. Switching is
// the ONLY action here — closing a pane lives in the pane pill's long-press sheet (with its own
// confirm), so a fat-thumbed switch can never destroy a pane.
//
// This sheet sees the WHOLE herd, so it has the same problem the dashboard had: the two long tails
// (Recent, and 30-odd bare shells) bury the handful of agents you actually came to switch to. Both
// fold, and both remember it, using the dashboard's own header primitive.
//
// Three things keep it usable once the herd is genuinely large (measured on a 58-pane herd: 1133px
// of content in a 543px sheet, 2376px with the shells open — 4.4 screens):
//
//   1. A FILTER, past FILTER_FROM panes. Typing beats scrolling four screens, and it matches on
//      `paneSearchText` so a project, a tab, or a session name all find the pane.
//   2. A "HERE" section — the panes of the space you're already in. It is the one thing this sheet
//      knows that the dashboard doesn't; without it the switcher rendered byte-identically no matter
//      which pane you opened it from. Capped at HERE_CAP so it can't push the alert off the first
//      screen, with the remainder handed to the space route rather than growing the sheet.
//   3. ORIENTATION that survives the folds — see `currentIn` below.
//
// A pane in your current space appears twice: once under "Here", once in its triage section. That's
// deliberate. "Here" is a shortcut, not a partition, and quietly withholding a blocked pane from
// "Needs you" because it happened to be nearby would break the one promise triage makes.
export function ThreadSidebar({
  agents,
  shellPanes = [],
  currentPaneId,
  onSelect,
  currentSpaceId,
  onOpenSpace,
  recentOpen = true,
  onRecentOpenChange,
  shellsOpen = true,
  onShellsOpenChange,
  query = "",
  onClearQuery,
  className,
}: ThreadSidebarProps) {
  const all = useMemo(() => [...agents, ...shellPanes], [agents, shellPanes]);
  const q = query.trim();
  const matches = useMemo(() => matchPanes(all, query), [all, query]);

  // Which section holds the pane you're in. Fold state is a preference, but hiding YOUR OWN pane is
  // a bug: on a herd with 34 shells the Shells group is collapsed by default, so opening the
  // switcher from a shell showed no "you are here" anywhere — the row wasn't even rendered.
  const currentIn = useMemo(() => {
    if (!currentPaneId) return null;
    if (shellPanes.some((p) => p.paneId === currentPaneId)) return "shells" as const;
    const a = agents.find((p) => p.paneId === currentPaneId);
    return a ? bucketOf(a) : null;
  }, [agents, shellPanes, currentPaneId]);

  // The current space's panes, most urgent first then most recently active — the same ordering rule
  // triage uses, applied within one space.
  const here = useMemo(() => {
    if (!currentSpaceId) return [];
    return all.filter((p) => p.workspaceId === currentSpaceId).sort(byUrgencyThenRecency);
  }, [all, currentSpaceId]);
  const hereLabel = here[0]?.workspaceLabel || here[0]?.workspaceId;

  // Shells by when YOU last opened them, newest first. The bridge sends them alphabetically, which
  // ranks 34 interchangeable rows by a property nobody is looking for; `lastSeenAt` is the only
  // timestamp that moves for a bare shell, so it is both the useful order and the only honest age.
  // Finding a shell BY NAME is what the filter is for.
  const shells = useMemo(
    () => [...shellPanes].sort((x, y) => (y.lastSeenAt ?? 0) - (x.lastSeenAt ?? 0)),
    [shellPanes],
  );

  // Scroll the current row into view — ONCE, when the sheet opens. This deliberately lives here and
  // not on the row: a row unmounts and remounts whenever its pane changes triage bucket (done →
  // recent on the first poll after you read it, or idle → blocked), and while this effect sat on the
  // row that remount re-fired it — measured yanking a user who had scrolled 824px back to the top,
  // mid-browse, on the pane they were most likely to be watching. Empty deps + the ref guard make it
  // an open-once, and BottomSheet unmounts its children on close, so "once per mount" IS "once per
  // open". A user who has already scrolled owns the scroll position; we don't take it back.
  const listRef = useRef<HTMLDivElement>(null);
  const didScroll = useRef(false);
  useEffect(() => {
    if (didScroll.current) return;
    const row = listRef.current?.querySelector<HTMLElement>("[data-autofocus]");
    if (!row) return;
    didScroll.current = true;
    // Optional-called: jsdom has no layout and doesn't implement scrollIntoView, and this is
    // presentation only — the unit tests shouldn't have to stub it to render the list.
    row.scrollIntoView?.({ block: "center" });
  }, []);

  if (all.length === 0) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">No agents running.</div>
    );
  }

  return (
    <div ref={listRef} className={cn("flex flex-col gap-4 px-2 py-3", className)}>
      {q ? (
        <Section id="switch-results" label="Matches" count={matches.length} dot="bg-status-unknown">
          {/* The count is the only feedback the filter gives, and it was announced to nobody: a
              screen-reader user typing heard silence as the list went 9 → 2 → 0. One status node,
              not aria-live on the list, which would narrate every row on every keystroke — and when
              there are no matches the VISIBLE sentence is that node, so the fact is stated once
              rather than three times (heading, live region, and body all saying zero). */}
          {matches.length > 0 && (
            <p role="status" aria-live="polite" className="sr-only">
              {matches.length} {matches.length === 1 ? "pane matches" : "panes match"} “{q}”
            </p>
          )}
          {matches.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-2 py-8 text-center">
              <p
                role="status"
                aria-live="polite"
                className="max-w-full text-sm text-muted-foreground [overflow-wrap:anywhere]"
              >
                No panes match “{q.length > 40 ? `${q.slice(0, 40)}…` : q}”.
              </p>
              {onClearQuery && (
                <button
                  type="button"
                  onClick={onClearQuery}
                  className="min-h-11 rounded-lg px-4 text-sm font-medium text-foreground underline underline-offset-4 transition-colors hover:bg-muted/60 active:bg-muted"
                >
                  Clear filter
                </button>
              )}
            </div>
          ) : (
            matches.map((p) => (
              <PaneRow
                key={p.paneId}
                pane={p}
                active={p.paneId === currentPaneId}
                onSelect={onSelect}
                // Matches are ranked by byUrgencyThenRecency, which reads lastActiveAt.
                ageBasis="active"
              />
            ))
          )}
        </Section>
      ) : (
        <>
          {here.length > 1 && (
            <Section
              id="switch-here"
              label={hereLabel ? `Here · ${hereLabel}` : "Here"}
              count={here.length}
              dot="bg-primary"
            >
              {/* Sighted users read "shortcut" from the position, the heading and the rail. Without
                  this a screen-reader user hears the same pane, the same age and "current page"
                  twice with nothing saying it is one pane listed under two organising ideas. */}
              <p className="sr-only">
                A shortcut to the space you are in. Each of these panes is also listed under its
                status below.
              </p>
              {here.slice(0, HERE_CAP).map((p) => (
                <PaneRow
                  key={p.paneId}
                  pane={p}
                  active={p.paneId === currentPaneId}
                  onSelect={onSelect}
                  autoFocus={p.paneId === currentPaneId}
                  ageBasis="active"
                  scope="space"
                />
              ))}
              {here.length > HERE_CAP && onOpenSpace && currentSpaceId && (
                <button
                  type="button"
                  onClick={() => onOpenSpace(currentSpaceId)}
                  className="flex min-h-11 w-full items-center rounded-lg px-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/60 active:bg-muted"
                >
                  Open {hereLabel} ({here.length - HERE_CAP} more) →
                </button>
              )}
            </Section>
          )}

          {triage(agents).map((g) => {
            const members = g.agents;
            if (members.length === 0) return null;
            // Recent is the only foldable triage section, and only where the parent wired the state.
            // It is force-opened when it holds the pane you're in — see `currentIn`.
            const foldable = !!g.collapsible && onRecentOpenChange !== undefined;
            const open = foldable ? recentOpen || currentIn === g.key : true;
            return (
              <Section
                key={g.key}
                id={`switch-${g.key}`}
                {...sectionHeaderProps(g)}
                {...(foldable ? { open, onToggle: onRecentOpenChange } : {})}
              >
                {members.map((a) => (
                  <PaneRow
                    key={a.paneId}
                    pane={a}
                    active={a.paneId === currentPaneId}
                    onSelect={onSelect}
                    // "Here" already claimed the autofocus when it holds the current pane; don't
                    // hand the sheet two candidates for where to open.
                    autoFocus={a.paneId === currentPaneId && here.length <= 1}
                    ageBasis={ageBasisFor(g.key)}
                  />
                ))}
              </Section>
            );
          })}

          {shellPanes.length > 0 && (
            <Section
              id="switch-shells"
              label="Shells"
              count={shellPanes.length}
              dot="bg-status-unknown"
              {...(onShellsOpenChange
                ? { open: shellsOpen || currentIn === "shells", onToggle: onShellsOpenChange }
                : {})}
            >
              {shells.map((p) => (
                <PaneRow
                  key={p.paneId}
                  pane={p}
                  active={p.paneId === currentPaneId}
                  onSelect={onSelect}
                  autoFocus={p.paneId === currentPaneId && here.length <= 1}
                  // A bare shell's lastActiveAt never advances, so dating shells by it printed the
                  // same "15h" on 32 of 34 rows — including the one you were standing in.
                  ageBasis="seen"
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The switcher's filter field. Lives with the matching logic but is RENDERED by the sheet, into its
 * sticky header (`BottomSheet headerExtra`) — two problems, one move:
 *
 *   - In the scrolling body it went fully behind the sticky title at 6% of the scroll range, so the
 *     escape hatch vanished the moment you started browsing the thing it exists to shorten.
 *   - The panel is `max-h-[82dvh]` with no floor, so a narrowing result set shrank the sheet from the
 *     top and slid the field you were typing into DOWN the viewport — measured 312px in one
 *     keystroke, 37% of a phone's height. The sheet floors its height while this is mounted.
 */
export function PaneFilterField({
  value,
  onChange,
  total,
  onCommit,
}: {
  value: string;
  onChange: (next: string) => void;
  /** Panes being filtered — the placeholder says how many, so the field states the problem it solves. */
  total: number;
  /** Enter with exactly one match: commit it. Never fires on an ambiguous query. */
  onCommit?: () => void;
}) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="text"
        inputMode="search"
        // The Android IME shows a generic action key without this; "go" matches what Enter does.
        enterKeyHint="go"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !onCommit) return;
          e.preventDefault();
          onCommit();
        }}
        aria-label="Filter panes"
        placeholder={`Filter ${total} panes…`}
        // Not autofocused: the sheet's whole job is showing the list, and popping the Android
        // keyboard on open would cover it. h-11 keeps the field on the 44px touch floor, and
        // text-base (16px) is what stops iOS zooming the page on focus.
        className="h-11 w-full rounded-md border border-input bg-transparent pl-9 pr-12 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring"
      />
      {value !== "" && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear filter"
          // `type="text"` gets no native clear affordance on Android Chrome, so seventeen characters
          // meant seventeen backspaces or closing the sheet.
          className="absolute right-0 top-0 flex size-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

// Uses the dashboard's own header primitive so the fold affordance is identical in both places —
// level 3 because the sheet's own title is the h2. Passing no `open`/`onToggle` renders a plain
// pinned heading with nothing to press.
function Section({
  id,
  label,
  count,
  accent,
  dot,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count: number;
  accent?: boolean;
  /** Status-palette bullet beside the header — the same colors the status badges use, so each
   *  section carries its at-a-glance color key. */
  dot: string;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const foldable = open !== undefined && onToggle !== undefined;
  return (
    <section className="flex flex-col gap-0.5">
      <SectionHeader
        level={3}
        label={label}
        count={count}
        dot={dot}
        className="px-2"
        {...(accent ? { accent } : {})}
        {...(foldable ? { open, onToggle, controls: id } : {})}
      />
      {(!foldable || open) && <div id={id}>{children}</div>}
    </section>
  );
}

function PaneRow({
  pane,
  active,
  onSelect,
  autoFocus,
  ageBasis,
  scope = "herd",
}: {
  pane: AgentView;
  active: boolean;
  onSelect: (paneId: string) => void;
  /** Marks this row as where the sheet should put focus (and scroll) on open. */
  autoFocus?: boolean;
  /**
   * Which timestamp to date the row by — must be the one its SECTION sorts on, or the age column
   * contradicts the order it is supposed to explain. See `ageBasisFor`.
   */
  ageBasis: AgeBasis;
  /**
   * "herd" (default) titles the row `project · tab`, because the list spans every space. "space" is
   * for a list already gathered under one space's heading — "Here" — where repeating the project on
   * every row says nothing and costs a third of the row's width, which is the width the only
   * discriminator needs. Same argument, same wording, as AgentCard's `scope`.
   */
  scope?: "herd" | "space";
}) {
  const isShell = pane.kind === "shell";
  const attention = isAttention(pane.status);
  // project · tab as separate spans so the TAB survives truncation — see paneParts. The agent's
  // identity stays in the icon, which is why the title line is free to say where the work is.
  const { project, tab, secondary } = paneParts(pane);
  const inSpace = scope === "space";
  // Under a space heading the tab IS the name. The fallbacks matter: `paneDisplayName` ends in the
  // literal word "shell" for an unlabelled bare shell, so a tabless shell in "Here" rendered as a row
  // saying only "shell" — announcing "shell shell 31h" and naming nothing. Ending on the project is
  // redundant with the heading but at least identifies the pane.
  const soleTitle = tab ?? pane.paneLabel ?? pane.sessionName ?? project;
  const stamp = ageStampOf(pane, ageBasis);

  return (
    <button
      type="button"
      onClick={() => onSelect(pane.paneId)}
      aria-current={active ? "page" : undefined}
      {...(autoFocus ? { "data-autofocus": "" } : {})}
      className={cn(
        // min-h-11 is the 44px touch floor. These rows navigate you off the pane you were reading,
        // so a mis-tap is expensive; they were 36px.
        "flex min-h-11 w-full min-w-0 items-center gap-2.5 rounded-lg py-1.5 pr-2.5 text-left transition-colors",
        // A 2px rail in the leading gutter is what actually says "you are here". The accent FILL
        // alone measured 1.31:1 (dark) / 1.17:1 (light) against the sheet — under the 3:1 WCAG 1.4.11
        // asks of a state indicator, and invisible on a phone outdoors. --primary is near-white in
        // dark and near-black in light, so the rail clears the bar in both without a second token.
        active
          ? "border-l-2 border-primary bg-accent pl-2 text-accent-foreground"
          : "border-l-2 border-transparent pl-2 hover:bg-muted/60 active:bg-muted",
        // The switcher is exactly where you jump TO the thing that needs you, so it must be able to
        // SHOW that — it renders every pane identically otherwise. Staying denser than the dashboard
        // is fine; being unable to mark a blocked pane is not. (isAttention, so the rule isn't
        // re-derived here.)
        //
        // The border is applied even to the ACTIVE row, so the two cues compose: the pane you're in
        // AND blocked keeps both its accent fill and its alarm edge. Only the fill is withheld,
        // because two backgrounds can't both win. At /40 that edge measured 1.94:1 — an alarm you
        // couldn't see; full strength is the point of an alarm.
        attention && "border border-l-2 border-status-blocked",
        !active && attention && "bg-status-blocked/5",
      )}
    >
      {isShell ? (
        // The glyph is decorative, so "this is a shell, not an agent" — the distinction the whole
        // app is built around — reached nobody using a screen reader. Under "Matches" and "Here",
        // where shells and agents interleave with no section heading to separate them, that left
        // two kinds of row announcing identically.
        <span className="relative shrink-0">
          <TerminalSquare className="size-5 text-muted-foreground" aria-hidden />
          <span className="sr-only">shell</span>
        </span>
      ) : (
        // The logo carries WHICH agent; the dot on its corner carries WHAT IT'S DOING. On a herd
        // that runs one agent everywhere, 24 identical logos discriminated nothing and the row's
        // most valuable column said nothing at all — and under "Here", which groups by space rather
        // than by status, the section heading no longer says it either.
        <span className="relative shrink-0">
          <AgentIcon agent={pane.agent} className="size-5" />
          <StatusDot
            status={pane.status}
            surface="bg-background"
            className="absolute -bottom-0.5 -right-0.5"
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1 text-sm">
          {inSpace ? (
            // No project: the section heading just said it. Wrapping rather than truncating because
            // this span is now the row's ONLY discriminator — but CLAMPED, for the same reason the
            // herd-scope one is: unbounded, a 400-character tab label rendered a 289px row, and five
            // of them buried "Needs you" under 1500px. HERE_CAP counts rows; only this bounds height.
            <span className="line-clamp-2 min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
              {soleTitle}
            </span>
          ) : (
            <>
              <span className="max-w-[45%] shrink truncate text-muted-foreground">{project}</span>
              {tab && (
                <>
                  <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                    ·
                  </span>
                  {/* line-clamp-2, not truncate: at 200% text zoom the tab clipped to three
                      characters ("mo… · to…"), which is loss of content under WCAG 1.4.4 — every row
                      became indistinguishable exactly when the user needed them most. Two lines is
                      bounded, so a normal-zoom list keeps its density. */}
                  <span className="line-clamp-2 min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
                    {tab}
                  </span>
                </>
              )}
            </>
          )}
        </div>
        {secondary && (
          <div className="truncate font-mono text-[11px] text-muted-foreground">{secondary}</div>
        )}
      </div>
      {/* The dashboard has carried an age since it was built; the switcher listing the same panes
          without one made "Recent" twenty rows in an order you had to take on trust. */}
      {stamp !== undefined && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {timeAgoShort(stamp)}
        </span>
      )}
      {/* Status LAST, matching how the dashboard announces the same pane. Read second it turned every
          row into "claude logo, done, …", and a blocked row into the fragment "needs you moonward_os
          code" sitting under a heading that had already said "Needs you". */}
      {!isShell && <span className="sr-only">{STATUS_LABEL[pane.status]}</span>}
    </button>
  );
}
