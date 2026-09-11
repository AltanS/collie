import { Loader2, MessageSquareText, RefreshCw, TerminalSquare, TriangleAlert } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { MarkdownText } from "@/components/markdown-text";
import { JournalImage, ToolPart } from "@/components/transcript-view";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import type { Scope } from "@/lib/scope";
import type { TranscriptEntry, TranscriptPart } from "@/lib/types";
import { getLocaleSnapshot, t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import type { ConversationState } from "@/hooks/use-conversation";
import { canRenderInline, InlineTypedBlocks, type TypedBlocksProps } from "@/components/typed-blocks";

// The Conversation reading surface: the pane's persisted transcript as a Collie-native Variant B
// message thread — user turns as right-aligned bubbles, the agent's turns plain on the left, tool
// calls folded under a tap. Rewritten from the validated prototype (`.scratch/.../prototype/
// evidence.md`) against Collie's own components, typography, colours and spacing — NOT promoted
// from the prototype's markup.
//
// TWO HONESTY RULES this surface holds:
//  1. Working state is a distinct BUBBLE at the tail — never synthetic transcript text, never a
//     promised partial turn. The journal has no completion marker, so the bubble only ever says
//     "the agent is working", nothing about what it is producing.
//  2. A dialog without displayable inline context shows a Terminal-required card. Its in-app
//     Terminal switch never calls focusPane and never writes.

function clockTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const locale = getLocaleSnapshot().locale;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(d);
}

function EntryParts({ entry, scope }: { entry: TranscriptEntry; scope?: Scope }) {
  return (
    <>
      {entry.parts.map((part: TranscriptPart, i) =>
        part.kind === "tool" ? (
          <ToolPart key={i} part={part} query="" scope={scope} />
        ) : part.kind === "image" ? (
          <div key={i} className="my-1.5">
            <JournalImage ref_={part.url} alt={t("transcript.attachmentAlt")} scope={scope} />
          </div>
        ) : (
          <MarkdownText
            key={i}
            text={part.text}
            query=""
            className={part.kind === "thinking" ? "italic text-muted-foreground" : undefined}
          />
        ),
      )}
    </>
  );
}

function Entry({ entry, agent, scope }: { entry: TranscriptEntry; agent?: string; scope?: Scope }) {
  const time = clockTime(entry.ts);
  if (entry.role === "summary" || entry.role === "note") {
    // Neither of these is speech — muted, dashed, set apart, as in the history route.
    return (
      <li data-conversation-entry={entry.uuid} className="max-w-[85%] self-start">
        <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm">
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {entry.role === "summary" ? t("transcript.summaryLabel") : t("transcript.systemLabel")}
            {time && ` · ${time}`}
          </p>
          <EntryParts entry={entry} scope={scope} />
        </div>
      </li>
    );
  }
  const isUser = entry.role === "user";
  if (isUser) {
    // Variant B: the user's turn is a right-aligned bubble — clearly theirs, clearly apart.
    return (
      <li data-conversation-entry={entry.uuid} className="flex max-w-[85%] flex-col items-end self-end">
        <div className="rounded-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          <EntryParts entry={entry} scope={scope} />
        </div>
        {time && <span className="mt-0.5 text-[10px] text-muted-foreground">{time}</span>}
      </li>
    );
  }
  // The agent's turn: plain on the left, under the agent's own mark — the reading surface, not a
  // quoted card, so long runs of tool calls and prose stay scannable.
  return (
    <li data-conversation-entry={entry.uuid} className="max-w-full self-start">
      <div className="mb-0.5 flex items-center gap-1.5">
        <AgentIcon agent={agent ?? "claude"} className="size-3.5" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {agent ?? t("transcript.agentFallback")}
        </span>
        {time && <span className="text-[11px] text-muted-foreground">{time}</span>}
      </div>
      <div className="space-y-1.5 text-sm">
        <EntryParts entry={entry} scope={scope} />
      </div>
    </li>
  );
}

/** The card standing in for an unavailable transcript. `unavailable` copy is shared with History. */
function StateCard({ state }: { state: Exclude<ConversationState, "ok" | "loading"> }) {
  const copy =
    state === "no-session"
      ? t("history.unavailable.noSession")
      : state === "no-log"
        ? t("history.unavailable.noLog")
        : state === "disabled"
          ? t("history.unavailable.disabled")
          : t("history.unavailable.error");
  return (
    <div data-slot="conversation-state" data-state={state}>
      <Notice
        tone={state === "error" ? "danger" : "neutral"}
        variant="box"
        announce="status"
        icon={state === "error" ? <TriangleAlert /> : undefined}
      >
        {copy}
      </Notice>
    </div>
  );
}

export interface ConversationViewProps {
  entries: TranscriptEntry[];
  state: ConversationState;
  /** The pane's agent is actively working — the distinct working bubble, never synthetic text. */
  working: boolean;
  /** The current screen cannot be represented inline and needs the Terminal fallback. */
  dialogPresent: boolean;
  /** The pane's agent name, for the per-turn brand icon. */
  agent?: string;
  scope?: Scope;
  /** The pane's typed blocks (raw included). A supported non-raw tail block renders inline. */
  blocks: TypedBlocksProps["blocks"];
  /** The SAME guarded handlers the Terminal mirror's controls use — no rederivation or guard is
   *  duplicated here; prompt binding, fresh pane reads and guarded key submission stay upstream. */
  onPromptAction: TypedBlocksProps["onPromptAction"];
  onWizardAction: TypedBlocksProps["onWizardAction"];
  onPreviewAction: TypedBlocksProps["onPreviewAction"];
  onMultiSelectAction: TypedBlocksProps["onMultiSelectAction"];
  onMenuAction: TypedBlocksProps["onMenuAction"];
  /** Disable the inline controls (read-only / gone pane) — the same flag Terminal's blocks get. */
  promptDisabled: TypedBlocksProps["promptDisabled"];
  onRefresh: () => void;
  /** One-tap in-app Terminal fallback. Never calls focusPane; swaps the reading surface only. */
  onOpenTerminal: () => void;
}

/**
 * The Conversation mode row and the NON-SCROLLING feedback above the thread: the toolbar (refresh,
 * one-tap Terminal), the Terminal-required dialog card, and the unavailable-transcript state card.
 *
 * Everything here must stay reachable INDEPENDENT of transcript position (review finding F3): this
 * component renders OUTSIDE the transcript scroller, so tail-follow can never carry the only
 * Terminal action offscreen. The state card likewise renders whenever the transcript is currently
 * unavailable — alongside cached entries, not only on an empty thread (review finding F4).
 */
export function ConversationView({
  state,
  dialogPresent,
  onRefresh,
  onOpenTerminal,
}: Pick<ConversationViewProps, "state" | "dialogPresent" | "onRefresh" | "onOpenTerminal">) {
  useLocale();
  const unavailable = state !== "ok" && state !== "loading";
  return (
    <div data-slot="conversation-view" className="flex flex-col px-4 pt-2">
      {/* The mode row: the conversation's own reading controls. One tap to Terminal; the explicit
          refresh. Kept OUT of the pane header on purpose — that row states a two-action budget the
          ⋮ already spent, and this belongs to the surface it controls. */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <MessageSquareText className="size-3.5" />
          {t("chat.conversation.title")}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            aria-label={t("chat.conversation.refreshAria")}
            className="size-11 text-muted-foreground"
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button
            variant="outline"
            onClick={onOpenTerminal}
            aria-label={t("chat.conversation.openTerminalAria")}
            data-slot="conversation-terminal-fallback"
            className="min-h-11 gap-1 px-2 text-xs text-muted-foreground"
          >
            <TerminalSquare className="size-3.5" />
            {t("chat.conversation.openTerminal")}
          </Button>
        </div>
      </div>

      {/* Terminal-required card. Rendered OUTSIDE the transcript scroller (this whole component
          is), so tail-follow cannot scroll it — or the toolbar's Terminal button — offscreen.
          FAIL CLOSED: only screens with NO supported typed tail block land here (unknown, stale,
          malformed, password-like, composer-not-ready). A supported prompt renders inline in the
          thread instead and never shows this card. */}
      <Collapse open={dialogPresent}>
        {dialogPresent && (
          <div data-slot="conversation-terminal-required" className="pt-2">
            <Notice tone="caution" variant="box" announce="status" icon={<TriangleAlert />}>
              <p>{t("chat.conversation.requiresTerminal")}</p>
              <p className="mt-1">{t("chat.conversation.requiresTerminalBody")}</p>
              <Button
                variant="outline"
                onClick={onOpenTerminal}
                aria-label={t("chat.conversation.openTerminalAria")}
                data-slot="conversation-terminal-required-action"
                className="mt-2 min-h-11 self-start gap-1.5 px-2.5 text-xs"
              >
                <TerminalSquare className="size-3.5" />
                {t("chat.conversation.openTerminal")}
              </Button>
            </Notice>
          </div>
        )}
      </Collapse>

      {/* The unavailable-transcript card, whenever the transcript is CURRENTLY unavailable —
          alongside any still-cached entries, not only on an empty thread. A loaded conversation
          that turns disabled/no-log/no-session/errored must keep its distinct feedback (review
          finding F4), not silently hold stale content. */}
      <Collapse open={unavailable}>
        {unavailable && <div className="pt-2"><StateCard state={state} /></div>}
      </Collapse>
    </div>
  );
}

/** The scrollable Variant B thread itself: entries, the empty state, the inline prompt, and the
 *  working bubble. */
export function ConversationThread({
  entries,
  state,
  working,
  agent,
  scope,
  blocks,
  onPromptAction,
  onWizardAction,
  onPreviewAction,
  onMultiSelectAction,
  onMenuAction,
  promptDisabled,
}: Pick<
  ConversationViewProps,
  | "entries"
  | "state"
  | "working"
  | "agent"
  | "scope"
  | "blocks"
  | "onPromptAction"
  | "onWizardAction"
  | "onPreviewAction"
  | "onMultiSelectAction"
  | "onMenuAction"
  | "promptDisabled"
>) {
  useLocale();
  // A supported typed tail block renders INLINE at the thread's tail, through the same TypedBlocks
  // seam the Terminal mirror uses and the same injected handlers — the guards (fresh pane rereads,
  // dialog rederivation, prompt binding, guarded key submission) stay in AgentChat untouched. This
  // is not a re-implementation of any grammar. InlineTypedBlocks supplies the raw context that
  // Terminal normally renders beside these controls. Missing context withholds the controls and
  // the Terminal-required card above the thread supplies the fallback.
  const inlinePrompts = canRenderInline(blocks);
  return state === "loading" && entries.length === 0 ? (
    <div className="flex justify-center py-10 text-muted-foreground">
      <Loader2 className="size-5 animate-spin motion-reduce:animate-none" aria-label={t("chat.conversation.loading")} />
    </div>
  ) : (
    <ol data-slot="conversation-thread" className="flex flex-col gap-3 pb-2">
      {entries.length === 0 && state === "ok" && (
        <li className="self-center py-6 text-sm text-muted-foreground">
          {t("chat.conversation.empty")}
        </li>
      )}
      {entries.map((entry) => (
        <Entry key={entry.uuid} entry={entry} agent={agent} scope={scope} />
      ))}
      {/* The inline prompt: the last message in the thread is the agent asking. Rendered inside
          the scroller so it reads as part of the conversation, not as chrome above it. */}
      {inlinePrompts && (
        <li data-slot="conversation-inline-prompts" className="min-w-0 max-w-full self-start">
          <InlineTypedBlocks
            blocks={blocks}
            onPromptAction={onPromptAction}
            onWizardAction={onWizardAction}
            onPreviewAction={onPreviewAction}
            onMultiSelectAction={onMultiSelectAction}
            onMenuAction={onMenuAction}
            promptDisabled={promptDisabled}
          />
        </li>
      )}
      {/* The working bubble: distinct, terminal-colour-free, and the ONLY representation of
          live work on this surface. It renders whenever the pane reports the agent working —
          alongside or instead of transcript content — EXCEPT while an inline prompt is on
          screen: a prompt is a question waiting for an answer, and "Working…" next to tappable
          answers would claim both states at once (the working state and the action state are
          the same screen's two readings; the question wins). */}
      {!inlinePrompts && (
        <li className="max-w-[85%] self-start">
          <Collapse open={working}>
            {working && (
              <div data-slot="conversation-working">
                <Notice tone="neutral" variant="box" announce="status" icon={<AgentIcon agent={agent ?? "claude"} />}>
                  <span className="flex items-center gap-1.5">
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                    {t("chat.conversation.working")}
                  </span>
                </Notice>
              </div>
            )}
          </Collapse>
        </li>
      )}
    </ol>
  );
}