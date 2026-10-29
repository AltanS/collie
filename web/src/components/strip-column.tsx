import { useMemo, useRef, type ReactNode } from "react";
import { EyeOff, Keyboard, ListEnd, ListTodo, Monitor, Settings2, Slash, Terminal, TerminalSquare, Zap } from "lucide-react";

import { ActionsRow, type GeneralAction } from "@/components/actions-row";
import { AgentIcon } from "@/components/agent-icon";
import { HostChip } from "@/components/host-chip";
import { ModelTag } from "@/components/model-tag";
import { RawMirror } from "@/components/raw-mirror";
import { SessionStream } from "@/components/session-stream";
import { StatusDot } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { BranchLabel } from "@/components/ui/branch-label";
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
import { useMuxCapability } from "@/lib/mux-capability";
import { useOperatorCommands } from "@/lib/operator-config";
import { paneGitHead } from "@/lib/git-head";
import { paneName } from "@/lib/pane-name";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { isUnseen } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { statusLabel } from "@/lib/types";
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
    <>
      {preset !== null && (
        <Button
          variant="outline"
          size="lg"
          data-slot="column-width"
          // A stated width, so 1/2, 4/5 and Full are one box and a cycle moves nothing (DESIGN.md §2).
          className="w-14 shrink-0 px-0 text-xs tabular-nums"
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
        className="size-11 shrink-0 px-0 text-muted-foreground"
        aria-label={t("wide.removeFromView")}
        // Says what the button does NOT do: the pane stays alive and stays in the sidebar.
        title={t("wide.removeFromView.hint")}
        disabled={!removable}
        onClick={own(onRemove)}
      >
        <EyeOff className="size-5" />
      </Button>
    </>
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
    <div data-slot="column-header" className="flex min-h-15 shrink-0 items-center gap-1 border-b border-band-rule bg-band-ground py-1 pl-4 pr-2">
      <span className="relative inline-flex shrink-0">
        {pane.kind === "shell" ? (
          <TerminalSquare className="size-8 text-muted-foreground" aria-hidden />
        ) : (
          <AgentIcon agent={pane.agent} className="size-8" />
        )}
        <StatusDot status={pane.status} backed surface="bg-band-ground" label={statusLabel(pane.status)} className="absolute -bottom-1 -right-1" />
      </span>
      {/* The name is the column's way in for a keyboard: Enter on it gives the column the focus. */}
      <button type="button" onClick={own(onFocus)} className="min-h-11 min-w-0 flex-1 pl-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium text-muted-foreground">{paneName(pane)}</span>
          <UnseenMark on={isUnseen(pane)} reserve />
        </div>
        {/* No space name: the space header above the strip is the one bar that names it. What is the
            column's own stays: its branch, its machine, its state. */}
        <div data-slot="column-header-line" className="flex min-w-0 items-baseline gap-2 text-[11px] leading-4 text-muted-foreground">
          {head !== null && <BranchLabel head={head} className="min-w-0 shrink truncate" />}
          <span className="shrink-0">{statusLabel(pane.status)}</span>
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
  const sessionLog = useMuxCapability("agentSessionRef", scope);
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

  const pill = (id: string): (() => void) => () => onIntent({ kind: "action", id });
  const general: GeneralAction[] = [
    { id: "keys", icon: Keyboard, label: t("composer.controls.keys"), onSelect: pill("keys") },
    ...(gridless
      ? []
      : [{ id: "screen", icon: Monitor, label: t("composer.controls.screenAria"), word: t("composer.controls.screen"), onSelect: pill("screen") }]),
    { id: "type", icon: Terminal, label: t("composer.controls.typeAria"), word: t("composer.controls.type"), onSelect: pill("type") },
    { id: "quick", icon: Zap, label: t("composer.controls.quick"), onSelect: pill("quick") },
    ...(isShell ? [{ id: "sent", icon: ListEnd, label: t("sent.button"), onSelect: pill("sent") }] : []),
    ...(commands.length > 0 ? [{ id: "agent", icon: Slash, label: t("composer.controls.agent"), onSelect: pill("agent") }] : []),
    ...(todos.length > 0
      ? [
          {
            id: "todos",
            icon: ListTodo,
            label: t("composer.controls.tasks", { done: todos.filter((item) => item.status === "completed").length, total: todos.length }),
            onSelect: pill("todos"),
          },
        ]
      : []),
    { id: "display", icon: Settings2, label: t("composer.controls.displayAria"), word: t("composer.controls.display"), onSelect: pill("display") },
  ];

  return (
    <>
      <div data-slot="column-body" className="relative min-h-0 min-w-0 flex-1 border-t border-rule">
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
          <ChatMessageList ref={listRef} clearBand={0} dep={screenText} className="h-full px-3 pb-3 pt-0">
            {lines.length > 0 ? (
              <RawMirror lines={lines} wrap={prefs.wrap} className="rounded-none px-0" />
            ) : (
              <div className="py-16 text-center text-sm text-muted-foreground">{t("chat.output.empty")}</div>
            )}
          </ChatMessageList>
        )}
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
        />
      </div>
      )}
    </>
  );
}

/** The class a column's frame takes: reserved on every column, drawn on the focused one (§2). */
export function columnFrame(focused: boolean, framed: boolean): string {
  return cn("border-2", focused && framed ? "border-pane-active" : "border-transparent");
}
