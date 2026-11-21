import { useMemo, useRef, type ReactNode } from "react";
import { Icon } from "@/components/icons/icon";

import { ActionsRow, type GeneralAction } from "@/components/actions-row";
import { HostChip } from "@/components/host-chip";
import { MODEL_TAG_ROOM, ModelTag, modelTagShows } from "@/components/model-tag";
import { RawMirror } from "@/components/raw-mirror";
import { SessionStream } from "@/components/session-stream";
import { Button } from "@/components/ui/button";
import { ChatMessageList, TailRoomContext, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BranchLabel } from "@/components/ui/branch-label";
import { PaneGlyph } from "@/components/ui/pane-glyph";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { useChatWindow } from "@/hooks/use-chat-window";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { handOf, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { usePaneScreen } from "@/hooks/use-pane-screen";
import { commandsFor } from "@/lib/agent-commands";
import { parseAnsi } from "@/lib/ansi";
import type { BeltIntent } from "@/lib/belt-intent";
import { splitLines } from "@/lib/blocks";
import { stopFor } from "@/lib/harness-bar";
import { t } from "@/lib/i18n";
import { paneSessionLog, useMuxCapability } from "@/lib/mux-capability";
import { useOperatorCommands } from "@/lib/operator-config";
import { paneGitHead } from "@/lib/git-head";
import { CrossfadeText } from "@/components/ui/crossfade-text";
import { paneRowKey } from "@/lib/hosts";
import { paneName } from "@/lib/pane-name";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { isUnseen, shownStatus } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { statusLabel } from "@/lib/types";
import { shortcutTarget } from "@/lib/shortcuts/target";
import { cn } from "@/lib/utils";
import type { Preset } from "@/lib/wide-layout";

// The parts of a large screen's column that are not the focused pane's own screen (ADR 0120): the
// column's controls, the header of a column without focus, and its body, a live READ-ONLY view of
// the pane with the pane's own belt under it and no reply box.
//
// ONLY THE FOCUSED COLUMN MOUNTS THE PANE SCREEN (AgentChat): one composer, so keys and text can never
// go to the wrong pane, and AgentChat's page-level effects (the poll intent, its key listeners, the
// sheet pull, its sheets) stay single. Nothing here starts one of those. The body below rides the
// existing poll through `useChatWindow` and `usePaneScreen`, both with `seen: false`, so only the
// focused pane counts as opened.

/** The words a width preset is shown as. */
const PRESET_KEY = {
  half: "wide.width.half",
  fourfifths: "wide.width.fourfifths",
  full: "wide.width.full",
} as const satisfies Record<Preset, string>;

export function presetWord(p: Preset): string {
  return t(PRESET_KEY[p]);
}

/** A tap on a column's own control does its own act and does not also move the focus. */
function own(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
}

/** A column's own two controls: its width (wide mode only) and Remove from view. */
export function ColumnControls({
  preset,
  onCycle,
  onRemove,
  removable,
}: {
  /** The width shown, or null when there is no width to choose (the button is then absent). */
  preset: Preset | null;
  onCycle: () => void;
  onRemove: () => void;
  /** False for the last column, which cannot leave. */
  removable: boolean;
}) {
  useLocale();
  return (
    // ONE GROUP BEHIND A HAIRLINE (strip-head round, 2026-11-21): the width and Remove from view, and in the focused
    // column the pane menu before them, read as the column's controls, apart from its name; the bar's own
    // controls carry the same hairline (wide-layout.tsx).
    <div data-slot="column-controls" className="flex shrink-0 items-center self-center border-l border-border pl-1">
      {preset !== null && (
        <Button
          variant="ghost"
          size="lg"
          data-slot="column-width"
          // A stated width, so 1/2, 4/5 and Full are one box and a cycle moves nothing (DESIGN.md §2). A WORD, not
          // a box: the bordered box was the heaviest thing in the header (2026-11-21), so it keeps the box's ink and
          // weight and loses only the border, with the ghost button's hover. Not the muted ink: on a column's paper in
          // a generated mid-grey theme that fell under 4.5:1 (e2e/themes, R5), where the full ink holds.
          className="w-14 shrink-0 px-0 text-xs font-medium tabular-nums text-foreground"
          aria-label={t("wide.width.aria", { width: presetWord(preset) })}
          onClick={own(onCycle)}
        >
          {presetWord(preset)}
        </Button>
      )}
      <Button
        variant="ghost"
        size="lg"
        data-slot="column-remove"
        {...shortcutTarget("remove_from_view")}
        className="size-11 shrink-0 px-0 text-muted-foreground"
        aria-label={t("wide.removeFromView")}
        // Says what the button does NOT do: the pane stays alive and stays in the sidebar.
        title={t("wide.removeFromView.hint")}
        disabled={!removable}
        onClick={own(onRemove)}
      >
        <Icon name="remove-from-view" className="size-5" />
      </Button>
    </div>
  );
}

/**
 * The header of a column WITHOUT focus. Same floor as the one header (`min-h-15`) so every column's
 * body starts on one line, and the name in muted ink: the focused column draws the pane's own header,
 * in normal ink. Colour only between the two, so nothing moves (DESIGN.md §2).
 */
export function ColumnHeader({ pane, controls, onFocus }: { pane: AgentView; controls: ReactNode; onFocus: () => void }) {
  useLocale();
  const head = paneGitHead(pane);
  return (
    // 54px and the firm edge, like the focused column's docked header (app-header.tsx): the space bar's page band
    // takes the other 6px, so every column's body starts where it did.
    <div data-slot="column-header" className="flex min-h-13.5 shrink-0 items-center gap-1 border-b border-edge-firm bg-band-ground py-1 pl-4 pr-2">
      <PaneGlyph pane={pane} className="size-8" markOn="bg-band-ground" named />
      {/* The name is the column's way in for a keyboard: Enter on it gives the column the focus. */}
      <button type="button" onClick={own(onFocus)} className="min-h-11 min-w-0 flex-1 pl-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-muted-foreground"><CrossfadeText text={paneName(pane)} identity={paneRowKey(pane)} />
          </span>
          <UnseenMark on={isUnseen(pane)} reserve />
        </div>
        {/* No space name: the space header above the strip is the one bar that names it. What is the
            column's own stays: its branch, its machine, its state. */}
        <div data-slot="column-header-line" className="flex min-w-0 items-baseline gap-2 text-xs leading-4 text-muted-foreground">
          {head !== null && <BranchLabel head={head} className="min-w-0 shrink truncate" />}
          <span className="shrink-0">{statusLabel(shownStatus(pane))}</span>
          <HostChip host={pane.host} variant="glyph" className="ml-auto self-center" />
        </div>
      </button>
      {controls}
    </div>
  );
}

/**
 * The body of a column without focus: the pane's live Chat when the pane draws Chat on this device,
 * else its screen, read only; the model tag on its corner; and the pane's belt, with no reply box. A
 * belt tap hands an intent to `onIntent`, which moves the focus here and lets this pane's own
 * composer run it (lib/belt-intent.ts). Stop arms and confirms here, in the column, as it does on the
 * phone; only the confirmed Stop travels.
 */
export function PaneColumnBody({
  pane,
  scope,
  onIntent,
  belt = true,
}: {
  pane: AgentView;
  scope: Scope;
  onIntent: (intent: BeltIntent) => void;
  /** False on a tabletop fold, where only the focused pane's belt stands, under the fold. */
  belt?: boolean;
}) {
  useLocale();
  const dash = useDashPrefs();
  const { prefs } = useDisplayPrefs();
  const operatorCommands = useOperatorCommands();
  const sessionLog = paneSessionLog(useMuxCapability("agentSessionRef", scope), pane.hasSession);
  const gridless = !useMuxCapability("paneGrid", scope).capable;
  const isShell = pane.kind === "shell";
  // The body the device would draw for this pane, by the pane view's own first test: Chat where the
  // pane has a session to read and the device chose Chat (or the pane has no screen at all).
  const chat = !isShell && sessionLog.capable && pane.hasSession === true && (gridless || dash.prefs.paneView === "chat");
  const feed = useChatWindow({ paneId: pane.paneId, scope, instance: pane.instance, enabled: chat, seen: false });
  const screenText = usePaneScreen(pane.paneId, scope, !chat && !gridless);
  const lines = useMemo(() => (screenText === null ? [] : splitLines(parseAnsi(screenText))), [screenText]);
  const listRef = useRef<ChatMessageListHandle>(null);
  const address = paneScopeKey(scope, pane.paneId);
  const commands = commandsFor(pane.agent, operatorCommands);
  const todos = pane.todos ?? [];
  const subagents = pane.subagents ?? [];
  const jobs = pane.jobs ?? [];
  const runningJobs = jobs.filter((job) => job.endedAt === undefined).length;
  // The pinned messages the machine counts for this pane (M90). A column holds no list: the tap focuses the pane and
  // its composer opens the sheet (lib/belt-intent.ts).
  const pinCount = isShell ? 0 : (pane.pins ?? 0);

  const pill = (id: string): (() => void) => () => onIntent({ kind: "action", id });
  const general: GeneralAction[] = [
    { id: "keys", icon: "keys-drawer", label: t("composer.controls.keys"), onSelect: pill("keys") },
    ...(gridless
      ? []
      : [{ id: "screen", icon: "screen", label: t("composer.controls.screenAria"), word: t("composer.controls.screen"), onSelect: pill("screen") } satisfies GeneralAction]),
    { id: "type", icon: "type-into-terminal", label: t("composer.controls.typeAria"), word: t("composer.controls.type"), onSelect: pill("type") },
    { id: "quick", icon: "quick-actions", label: t("composer.controls.quick"), onSelect: pill("quick") },
    ...(isShell ? [{ id: "sent", icon: "sent-history", label: t("sent.button"), onSelect: pill("sent") } satisfies GeneralAction] : []),
    ...(commands.length > 0 ? [{ id: "agent", icon: "agent-commands", label: t("composer.controls.agent"), onSelect: pill("agent") } satisfies GeneralAction] : []),
    ...(todos.length > 0
      ? [
          {
            id: "todos",
            icon: "todos",
            label: t("composer.controls.tasks", { done: todos.filter((item) => item.status === "completed").length, total: todos.length }),
            onSelect: pill("todos"),
          } satisfies GeneralAction,
        ]
      : []),
    { id: "display", icon: "display-settings", label: t("composer.controls.displayAria"), word: t("composer.controls.display"), onSelect: pill("display") },
  ];

  return (
    <>
      {/* `border-transparent`: the header above closes this seam with its own rule (DESIGN.md §4, "A boundary
          is drawn once"); the 1px stays so the body starts where it did. */}
      <div data-slot="column-body" className="relative min-h-0 min-w-0 flex-1 border-t border-transparent">
        <TailRoomContext.Provider value={modelTagShows({ model: pane.model, usage: pane.usage }) ? MODEL_TAG_ROOM : 0}>
        {chat ? (
          <SessionStream
            feed={feed}
            address={address}
            working={pane.status === "working"}
            agent={pane.agent}
            durable={gridless}
            showToolCalls={dash.prefs.showToolCalls}
            showCompactions={dash.prefs.showCompactions}
            fontSize={prefs.chatFontSize}
            listRef={listRef}
            savedCopy={null}
          />
        ) : (
          <ChatMessageList ref={listRef} clearBand={0} dep={screenText} className="h-full px-3 pb-[max(0.75rem,var(--tail-room,0px))] pt-0">
            {lines.length > 0 ? (
              <RawMirror lines={lines} wrap={prefs.wrap} className="rounded-none px-0" />
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">{t("chat.output.empty")}</div>
            )}
          </ChatMessageList>
        )}
        </TailRoomContext.Provider>
        <ModelTag model={pane.model} effort={pane.effort} usage={pane.usage} />
      </div>
      {belt && (
      <div data-slot="chrome-block" className="relative shrink-0 border-t border-rule bg-chrome px-3">
        <ActionsRow
          general={general}
          agent={pane.agent}
          mine={operatorCommands}
          onRun={(text) => {
            onIntent({ kind: "run", text });
            return Promise.resolve(false);
          }}
          stop={
            stopFor(pane)
              ? {
                  onStop: () => {
                    onIntent({ kind: "stop" });
                    return Promise.resolve();
                  },
                  paneId: pane.paneId,
                  running: pane.surface?.turn === "running",
                }
              : undefined
          }
          hand={handOf(prefs)}
          changes={pane.cwd ? { onClick: () => onIntent({ kind: "changes" }), label: t("chat.changes.label") } : undefined}
          agents={
            subagents.length > 0
              ? {
                  count: subagents.length,
                  label: t("composer.controls.agents", { count: subagents.length }),
                  expanded: false,
                  onClick: () => onIntent({ kind: "agents" }),
                }
              : undefined
          }
          jobs={
            jobs.length > 0
              ? {
                  count: runningJobs,
                  label: t("belt.jobs.label", { count: runningJobs }),
                  expanded: false,
                  onClick: () => onIntent({ kind: "jobs" }),
                }
              : undefined
          }
          pins={
            pinCount > 0
              ? {
                  count: pinCount,
                  label: t("pins.belt.label", { count: pinCount }),
                  expanded: false,
                  onClick: () => onIntent({ kind: "pins" }),
                }
              : undefined
          }
        />
      </div>
      )}
    </>
  );
}

/**
 * THE FOCUSED COLUMN IS THE PAPER (DESIGN.md §4, "The large screen's three planes"). The whole column
 * stands on `--surface-paper`, the lightest surface on the screen, and a column without focus on the page.
 * Each plane re-points the grounds its children already read, so the pane's own header (`bg-band-ground`),
 * its bottom block (`bg-chrome`) and the status marks backed with those grounds follow the plane, and the
 * phone, which never draws a column frame, keeps its own. On the paper the inert fill (`--muted`) is the
 * page: a run of tool steps, a code block and the reply box are set into the paper in the page's tone. On
 * the page, in dark, it is the paper (light keeps the theme's own), so those fills lean toward the focused column and never outshine it: in dark
 * the paper is only a small lift over the page (index.css), and a theme's own `--muted` stood above it on a
 * black page (Nightwatch), so a column without focus drew a Belt and a reply box lighter than the focus.
 *
 * Inside both planes: the Belt takes ONE tint, `--muted` at 20% over its ground, which sits between the
 * ground and the reply box (`--muted` at 40%), both short of the other plane, so never lighter than the paper; its brand wash is a
 * phone look and is dropped here. The reading area's top rule is not drawn: the header above already
 * closes that seam (§4, "A boundary is drawn once"), 4px higher.
 */
export const PAPER_PLANE =
  "bg-surface-paper [--band-ground:var(--surface-paper)] [--chrome:var(--surface-paper)] [--muted:var(--background)] [--accent:var(--state-on-paper)] [--state-hover:var(--state-hover-paper)] [--state-on:var(--state-on-paper)] [--state-open:var(--state-open-paper)]";
export const PAGE_PLANE =
  "bg-background [--band-ground:var(--background)] [--chrome:var(--background)] dark:[--muted:var(--surface-paper)] [--accent:var(--state-on-page)] [--state-hover:var(--state-hover-page)] [--state-on:var(--state-on-page)] [--state-open:var(--state-open-page)]";
const IN_EITHER_PLANE =
  "[&_[data-slot=composer-actions]]:bg-muted/20 [&_[data-slot=belt-track]]:bg-transparent [&_[data-slot=pane-reading]]:border-t-transparent";

/**
 * THE FOCUS FRAME: a 1px hairline in `--pane-active`, on the paper (ADR 0174). Since the pane-frame round of
 * 2026-11-21 that token is a derived colour: Collie's relation is the "on" ink (`--control-on-foreground`) mixed
 * into the page in OKLab, 70% in light and 60% in dark (index.css), and `deriveTokens` (lib/theme/derive.ts) holds
 * it at 3:1 or more against the three grounds it touches, the recess or the page beside it and the paper inside
 * it, in every theme. A theme that sets its own `pane-active` has it mixed the same way. The old 2px frame of the ink
 * mixed 65% into the page was a grey ring a pixel from the keyboard focus ring (`--ring`, also 2px grey), so it
 * read as a click's leftover focus; the coloured hairline does not. It carries the focus where the paper cannot:
 * the Terminal view, whose mirror stays dark, and a theme whose page is black.
 */
export const FOCUS_FRAME = "border-pane-active";

/**
 * The class a column's frame takes: the plane, and the 1px frame, reserved on every column and drawn on the
 * focused one, with one column in the strip too, so a focus change recolours and moves nothing (§2). `border-[1px]`
 * and not `border`: the bare width follows a theme's `border` word (2px under `strong`, Nightwatch), and the
 * hairline is 1px in every theme (`border-px` is no width to tailwind-merge, which dropped it beside the colour).
 */
export function columnFrame(focused: boolean): string {
  return cn("border-[1px]", IN_EITHER_PLANE, focused ? cn(PAPER_PLANE, FOCUS_FRAME) : cn(PAGE_PLANE, "border-transparent"));
}
