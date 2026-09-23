import { Loader2, Play, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agent-icon";
import { CacheChip } from "@/components/cache-chip";
import { SectionHeader } from "@/components/section-header";
import { StatusCounts, StatusSummaryLine } from "@/components/status-counts";
import { paneRowKey } from "@/lib/hosts";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import { paneName, panePlaceParts } from "@/lib/pane-name";
import { shortenHome } from "@/lib/shorten-home";
import { bucketOf, isAttention, worstTriage, type TriageKey } from "@/lib/triage";
import type { AgentView, Launcher, ServerSummary, TabView } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface ThreadSidebarProps {
  agents: AgentView[];
  /** Bare shell panes (no agent) — listed in a trailing "Shells" group so fresh spaces are reachable. */
  shellPanes?: AgentView[];
  /**
   * The open pane's full row identity ({@link paneRowKey}), never its bare id. `w1:p1` names a
   * different terminal on every machine in a crew, so on a widened switcher list two rows can
   * answer to the same id — comparing ids alone would mark BOTH as current. Pass `paneRowKey` of
   * the pane you're actually in (agent-chat.tsx already computes this for its own "elsewhere needs
   * you" check).
   */
  currentPaneKey: string;
  /**
   * Open a row. Takes the PANE, not its id — the same reason `agent-list.tsx`'s `onOpen` does: a
   * pane id is unique only within one machine, so an id alone cannot say which row was tapped.
   */
  onSelect: (pane: AgentView) => void;
  /** The raw tab list, for the multiplexer's own tab order inside a workspace (lib/pane-groups.ts). */
  tabs?: readonly TabView[];
  /** The snapshot's machine list, for the order machines run in: the lead first. */
  servers?: readonly ServerSummary[] | undefined;
  /** Whether the Shells section is expanded, and how to fold it. Omit to leave it always open. */
  shellsOpen?: boolean;
  onShellsOpenChange?: (open: boolean) => void;
  /**
   * The operator's own launcher rows (`launchers.toml`). A trailing "Launch" section renders only
   * when this is non-empty AND `onLaunch` is given, since the caller (agent-chat) withholds `onLaunch` on
   * a read-only device, which is what keeps a write this device cannot make from being offered here.
   */
  launchers?: readonly Launcher[];
  /** The bridge's own home dir, for shortening a pinned row's `cwd` with a leading `~`. */
  launchersHome?: string;
  /** Fired with the row's command. The caller owns the write (useSpaceActions().launch). */
  onLaunch?: (command: string) => void;
  /** Commands whose launch is still in flight; those rows are disabled and say so. */
  launching?: ReadonlySet<string>;
  /** The §10.3 refusal for this sheet's scope, when the host it would launch on refuses writes. */
  launchRefusal?: string;
  /** Whether the Launch section is expanded, and how to fold it. Omit to leave it always open. */
  launchOpen?: boolean;
  onLaunchOpenChange?: (open: boolean) => void;
  /** Override the list container padding (e.g. flush inside a bottom sheet). */
  className?: string;
}

// The pane switcher behind the swipe-up "Switch pane" sheet: every agent pane under the WORKSPACE it
// lives in, in the dashboard's own fixed order (lib/pane-groups.ts, `order: "fixed"`), then any bare
// shell panes under a trailing "Shells" group, with the open one highlighted. Switching is the ONLY
// action here — closing a pane lives in the pane pill's long-press sheet (with its own confirm), so a
// fat-thumbed switch can never destroy a pane.
//
// NOTHING HERE MOVES WHEN A PANE CHANGES STATE (ADR 0063). This sheet used to sort into the triage
// sections (Needs you, Ready, Working, Recent), so a row changed section, and therefore place, every
// time its agent took a turn: the row the thumb was reaching for was elsewhere by the time it landed,
// and on this sheet a wrong tap opens another terminal. Urgency is a MARK now, exactly as on the
// dashboard: the row's alarm edge, the lit heading, and one summary line on top that counts what
// needs you and jumps to the first of it.
//
// The two long tails still fold: 30-odd bare shells, and the Launch rows, using the dashboard's own
// header primitive and remembering it.
// A module-level empty list, not a `= []` default in the parameter list: a fresh array literal on
// every render is a new reference, which defeats memoisation downstream for no benefit here.
const NO_PANES: AgentView[] = [];
const NO_LAUNCHERS: readonly Launcher[] = [];

/** The buckets that mean "a human is required here" — the same two the dashboard's line counts. */
const URGENT: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

/** A DOM id for a pane row, so the summary line can scroll to it and focus it. */
function rowDomId(pane: AgentView): string {
  return `switch-row-${paneRowKey(pane).replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

export function ThreadSidebar({
  agents,
  shellPanes = NO_PANES,
  currentPaneKey,
  onSelect,
  tabs,
  servers,
  shellsOpen = true,
  onShellsOpenChange,
  launchers = NO_LAUNCHERS,
  launchersHome = "",
  onLaunch,
  launching,
  launchRefusal,
  launchOpen = true,
  onLaunchOpenChange,
  className,
}: ThreadSidebarProps) {
  useLocale();
  const showLaunch = launchers.length > 0 && onLaunch !== undefined;
  const noPanes = agents.length === 0 && shellPanes.length === 0;

  // An operator with no panes but a launchers.toml still has something to reach in here, so the
  // empty-panes text and the Launch section coexist rather than the text winning outright.
  if (noPanes && !showLaunch) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">
        {t("home.empty.noAgents")}
      </div>
    );
  }

  // The dashboard's grouping, so the switcher and the dashboard list the same panes in the same place.
  const groups = groupPanesByWorkspace(agents, [], { order: "fixed", tabs, servers });
  const urgent = agents.filter((a) => URGENT.has(bucketOf(a)));
  // The first urgent row in DISPLAY order, not in the order the list arrived in.
  const firstUrgent = groups.flatMap((g) => g.panes).find((a) => URGENT.has(bucketOf(a)));
  const jumpTo = (pane: AgentView) => {
    const row = document.getElementById(rowDomId(pane));
    row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    row?.focus({ preventScroll: true });
  };

  return (
    <div className={cn("flex flex-col gap-4 px-2 py-3", className)}>
      {noPanes && (
        <p className="px-2 py-2 text-sm text-muted-foreground">{t("home.empty.noAgents")}</p>
      )}

      {agents.length > 0 && (
        // ONE slot, always drawn while there are agents, so the groups below never shift when the
        // first pane needs you or the last one is answered. The dashboard's own line, over the urgent
        // panes alone: "Nothing needs you", or the counts with their words.
        <StatusSummaryLine
          panes={urgent}
          allClear={firstUrgent === undefined}
          onJump={firstUrgent === undefined ? undefined : () => jumpTo(firstUrgent)}
          className="px-2"
        />
      )}

      {groups.map((g) => (
        <Section
          key={g.key}
          id={`switch-ws-${g.key.replace(/[^A-Za-z0-9_-]/gu, "_")}`}
          label={g.label}
          tone="strong"
          dot={worstTriage(g.panes) === "needs" ? "bg-status-blocked" : undefined}
          trailing={<StatusCounts panes={g.panes} className="shrink-0 text-[11px] text-muted-foreground" />}
        >
          {g.panes.map((a) => (
            <PaneRow
              key={paneRowKey(a)}
              id={rowDomId(a)}
              pane={a}
              active={paneRowKey(a) === currentPaneKey}
              onSelect={onSelect}
            />
          ))}
        </Section>
      ))}

      {shellPanes.length > 0 && (
        <Section
          id="switch-shells"
          label={t("home.sidebar.shells")}
          count={shellPanes.length}
          dot="bg-status-unknown"
          {...(onShellsOpenChange ? { open: shellsOpen, onToggle: onShellsOpenChange } : {})}
        >
          {shellPanes.map((p) => (
            <PaneRow
              key={paneRowKey(p)}
              pane={p}
              active={paneRowKey(p) === currentPaneKey}
              onSelect={onSelect}
            />
          ))}
        </Section>
      )}

      {launchers.length > 0 && onLaunch && (
        <Section
          id="switch-launch"
          label="Launch"
          count={launchers.length}
          dot="bg-status-unknown"
          {...(onLaunchOpenChange ? { open: launchOpen, onToggle: onLaunchOpenChange } : {})}
        >
          {launchers.map((launcher) => (
            <LaunchRow
              key={launcher.command}
              launcher={launcher}
              home={launchersHome}
              busy={!!launching?.has(launcher.command)}
              refusal={launchRefusal}
              onLaunch={onLaunch}
            />
          ))}
        </Section>
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
  dot,
  tone,
  trailing,
  open,
  onToggle,
  children,
}: {
  id: string;
  label: string;
  count?: number;
  /** Status-palette bullet beside the header — the same colors the status badges use. A workspace
   *  heading carries one only while a pane inside needs you, as on the dashboard. */
  dot?: string | undefined;
  tone?: "muted" | "strong";
  trailing?: React.ReactNode;
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
        className="px-2"
        {...(count !== undefined ? { count } : {})}
        {...(dot !== undefined ? { dot } : {})}
        {...(tone !== undefined ? { tone } : {})}
        {...(trailing !== undefined ? { trailing } : {})}
        {...(foldable ? { open, onToggle, controls: id } : {})}
      />
      {(!foldable || open) && <div id={id}>{children}</div>}
    </section>
  );
}

function PaneRow({
  id,
  pane,
  active,
  onSelect,
}: {
  /** The row's DOM id, for the summary line's jump. Shell rows need none. */
  id?: string;
  pane: AgentView;
  active: boolean;
  onSelect: (pane: AgentView) => void;
}) {
  const isShell = pane.kind === "shell";
  // ONE NAME, ONE PLACE (lib/pane-name.ts), the same way round as every other row in the app: the
  // pane's name on line 1, where it sits underneath. This row used to be the other way up — the
  // place bold on line 1, the name muted below — which made the switcher the one list where you
  // could not find a pane by the name you had just read on the dashboard. The place's two halves
  // stay separate spans so the TAB survives truncation: eight rows of one project all begin with the
  // same nine characters, and the tab is the only one of the two that discriminates.
  const name = paneName(pane);
  const { space, tab } = panePlaceParts(pane);
  return (
    <button
      id={id}
      type="button"
      onClick={() => onSelect(pane)}
      aria-current={active ? "page" : undefined}
      className={cn(
        // The border is in the base string and transparent at rest, so an alarm edge only ever
        // changes the paint. Added by state it would pull the text 1px in and grow the row 2px,
        // which is the zig-zag every switcher row above and below it would then sit out of line
        // with. This is a gap list, not a divide-y one, so a four-sided edge is the right mark.
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
        // The switcher is exactly where you jump TO the thing that needs you, so it must be able to
        // SHOW that — it renders every pane identically otherwise. Staying denser than the dashboard
        // is fine; being unable to mark a blocked pane is not. (isAttention, so the rule isn't
        // re-derived here.)
        //
        // The border is applied even to the ACTIVE row, so the two cues compose: the pane you're in
        // AND blocked keeps both its accent fill and its alarm edge. Only the fill is withheld,
        // because two backgrounds can't both win.
        isAttention(pane.status) && "border-status-blocked/40",
        !active && isAttention(pane.status) && "bg-status-blocked/5",
      )}
    >
      {isShell ? (
        <TerminalSquare className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        // Status is conveyed by the row's alarm edge and the heading's dot; the row leads with the logo.
        <AgentIcon agent={pane.agent} className="size-5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1">
          <span className="min-w-0 truncate text-sm font-medium">{name}</span>
          {/* The cache reading trails the name, same corner as the dashboard row (agent-card.tsx,
              via PaneMeta), but without PaneMeta's host and session chips: this sheet asked for the
              cache reading alone, and a crew-wide switcher row is a separate call. `row`, not
              `button` — the whole row is already a `<button>`, and a button cannot nest inside one. */}
          <CacheChip cache={pane.cache} variant="row" className="ml-auto shrink-0" />
        </div>
        <div className="flex min-w-0 items-baseline gap-1 text-[11px] text-muted-foreground">
          <span className="max-w-[45%] shrink truncate">{space}</span>
          {tab && (
            <>
              {/* The place's own separator (PLACE_SEP), because a space CONTAINS a tab. */}
              <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                ›
              </span>
              {/* A positional tab (`tabTitle`'s `tab 2`) reads a shade lighter, the same ink every
                  other surface gives it — it is the tab's position, never a name someone chose. */}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  tab.positional && "text-muted-foreground/70",
                )}
              >
                {tab.text}
              </span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

// A launcher row, styled like PaneRow so it sits in the same list rather than reading as a second
// kind of control bolted onto the bottom. Same shape as the deleted LaunchSheet's rows: a Play icon
// that swaps for a spinner while the row is busy, the label, and the command underneath in mono.
// A sheet row is a full screen width, so showing the command costs nothing and tells you what you're
// about to run before you tap it.
function LaunchRow({
  launcher,
  home,
  busy,
  refusal,
  onLaunch,
}: {
  launcher: Launcher;
  home: string;
  busy: boolean;
  /** The §10.3 write refusal for this scope, or undefined when the row may be tapped. */
  refusal: string | undefined;
  onLaunch: (command: string) => void;
}) {
  // Pinned → the folder, shortened under home; absent → "here" (opens beside this pane, wherever it
  // is), which is the one thing the switcher can say that the dashboard's "here" cannot — there,
  // home is already implied and this suffix is withheld instead (launch-strip.tsx).
  const suffix = launcher.cwd !== undefined ? shortenHome(launcher.cwd, home) : t("chat.switcher.launch.here");
  const disabled = busy || refusal !== undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={refusal}
      title={refusal}
      onClick={() => onLaunch(launcher.command)}
      // min-h-11 (44px) keeps the touch floor even though the two-line label is shorter than that.
      className="flex w-full min-h-11 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <Play className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{launcher.label}</span>
          <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">{suffix}</span>
        </span>
        {/* The command is operator-authored text going into a text node, never markup. */}
        <span className="truncate font-mono text-xs text-muted-foreground">{launcher.command}</span>
      </span>
    </button>
  );
}
