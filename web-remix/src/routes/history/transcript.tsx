// Renders an agent transcript (web/src/components/transcript-view.tsx): the conversation history a pane's
// terminal structurally cannot hold. A DIFFERENT representation from the mirror, on purpose: role-tagged
// turns, timestamps, and tool calls folded together with the output they produced.
//
// XSS boundary, as the mirror's: every string from the log reaches the DOM as a TEXT NODE, never as
// markup. Prose is parsed as Markdown by web's pure parser into an AST which the renderer maps to
// elements (`chat/markdown.tsx`), so no HTML string is ever constructed.
//
// A turn is keyed by its uuid. The window the reader sees changes only when they scroll or search, and the
// route re-renders only then; a poll never reaches this view (History is fetch-all and not polled).
import { on, type Handle } from "remix/component";
import { ChevronRight, Info, TriangleAlert, User, Wrench, type IconNode } from "lucide";

import { getLocaleSnapshot, t, tn } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import { splitHighlight } from "@web/lib/transcript-search";
import type { TranscriptEntry, TranscriptPart } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { MarkdownText } from "../../chat/markdown";
import { useLocale } from "../../lib/i18n-store";
import { dashPrefs } from "../../lib/prefs";
import { useStore } from "../../lib/store";
import { Icon } from "../../ui/icon";
import { AgentIcon } from "../home/agent-icon";
import { imageSrc } from "./image-src";

/** Times only: the date lives on the day divider, and a phone row has no width to spare. */
function clockTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getLocaleSnapshot().locale, { hour: "2-digit", minute: "2-digit" }).format(d);
}

function dayKey(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat(getLocaleSnapshot().locale, { dateStyle: "medium" }).format(d);
}

/** Plain text with find hits marked: for strings that are NOT Markdown (shell commands, output). */
function Highlight(handle: Handle<{ text: string; query: string }>) {
  return () => {
    const { text, query } = handle.props;
    if (query.trim() === "") return text;
    const pieces = splitHighlight(text, query);
    if (pieces.length === 1 && !pieces[0]?.hit) return text;
    return (
      <>
        {pieces.map((piece, i) =>
          piece.hit ? (
            <mark key={String(i)} class="rounded-sm bg-amber-300/70 text-inherit dark:bg-amber-500/40">
              {piece.text}
            </mark>
          ) : (
            <span key={String(i)}>{piece.text}</span>
          ),
        )}
      </>
    );
  };
}

/**
 * One image out of the journal. It is an ANCHOR to the bytes, not a bare `<img>`: that makes it keyboard
 * reachable and long-pressable, and the only way to see a screenshot at full size on a phone. `imageSrc`
 * decides whether the reference is loadable AT ALL; one it refuses renders nothing.
 */
function JournalImage(handle: Handle<{ reference: string; alt: string; scope?: Scope }>) {
  return () => {
    const { reference, alt, scope } = handle.props;
    const src = imageSrc(reference, scope);
    if (src === null) return null;
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" class="inline-block cursor-zoom-in">
        <img src={src} alt={alt} class="max-h-96 w-auto max-w-full rounded border object-contain shadow-xs" loading="lazy" />
      </a>
    );
  };
}

type ToolPartData = Extract<TranscriptPart, { kind: "tool" }>;

/**
 * A tool call: its one-line summary always, its output behind a tap. Collapsed by default because a
 * thread is mostly tool traffic and expanding it all would bury the prose the reader opened it for.
 */
function ToolPart(handle: Handle<{ part: ToolPartData; query: string; scope?: Scope }>) {
  let open = false;
  return () => {
    const { part, query, scope } = handle.props;
    const result = part.result;
    const isError = result?.isError === true;
    return (
      <div class="rounded-md border bg-muted/40">
        <button
          type="button"
          disabled={!result}
          aria-expanded={result ? (open ? "true" : "false") : undefined}
          class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left disabled:opacity-100"
          mix={on("click", () => {
            open = !open;
            void handle.update();
          })}
        >
          <Icon icon={isError ? TriangleAlert : Wrench} class={cn("size-3.5 shrink-0", isError ? "text-destructive" : "text-muted-foreground")} />
          <span class="shrink-0 font-mono text-xs font-semibold">{part.name}</span>
          {part.summary ? (
            <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
              {/* A shell command, NOT prose: markdown-parsing it would eat globs and backticks. */}
              <Highlight text={part.summary} query={query} />
            </span>
          ) : null}
          {result ? <Icon icon={ChevronRight} class={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} /> : null}
        </button>
        {open && result ? (
          <div class="border-t">
            {result.imageUrl ? (
              <div class="border-b bg-background/50 p-2">
                <JournalImage reference={result.imageUrl} alt={t("transcript.toolImageAlt")} scope={scope} />
              </div>
            ) : null}
            {result.text ? (
              <pre class="overflow-x-auto px-2 py-1.5 font-mono text-[11px] leading-snug [font-variant-ligatures:none] whitespace-pre-wrap">
                {result.text}
                {result.truncated ? <span class="text-muted-foreground">{`\n${t("transcript.outputTruncated")}`}</span> : null}
              </pre>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };
}

function Part(handle: Handle<{ part: TranscriptPart; query: string; scope?: Scope }>) {
  return () => {
    const { part, query, scope } = handle.props;
    // Tool output is COMMAND output, not prose: it stays verbatim in a monospace block.
    if (part.kind === "tool") return <ToolPart part={part} query={query} scope={scope} />;
    if (part.kind === "image") {
      return (
        <div class="my-1.5">
          <JournalImage reference={part.url} alt={t("transcript.attachmentAlt")} scope={scope} />
        </div>
      );
    }
    return (
      <div>
        <MarkdownText text={part.text} class={part.kind === "thinking" ? "italic text-muted-foreground" : undefined} />
        {part.truncated ? <div class="text-xs text-muted-foreground">{t("transcript.truncated")}</div> : null}
      </div>
    );
  };
}

interface TurnProps {
  entry: TranscriptEntry;
  agent?: string;
  /** False for a turn continuing the same speaker's run. */
  showHeader: boolean;
  query: string;
  /** Whether a compaction's recap is drawn, or only the one-line marker where it happened. */
  drawCompactions: boolean;
  scope?: Scope;
}

function Turn(handle: Handle<TurnProps>) {
  return () => {
    const { entry, agent, showHeader, query, scope, drawCompactions } = handle.props;
    const time = clockTime(entry.ts);

    // The recap is the agent's own history of itself, thousands of characters long. Unless the reader
    // asked for it, the page keeps the place it happened and none of the text.
    if (entry.role === "summary" && !drawCompactions) {
      return (
        <p class="py-1 text-center text-xs text-muted-foreground">
          {t("transcript.summaryLabel")}
          {time ? ` · ${time}` : ""}
        </p>
      );
    }

    // Neither of these is speech, so both render dashed and muted: set apart from the conversation.
    if (entry.role === "summary" || entry.role === "note") {
      return (
        <div class="rounded-lg border border-dashed bg-muted/30 px-3 py-2">
          <div class="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            <Icon icon={Info satisfies IconNode} class="size-3" />
            {entry.role === "summary" ? t("transcript.summaryLabel") : t("transcript.systemLabel")}
            {time ? ` · ${time}` : ""}
          </div>
          {entry.parts.map((part, i) => (
            <Part key={String(i)} part={part} query={query} scope={scope} />
          ))}
        </div>
      );
    }

    const isUser = entry.role === "user";
    // The reader's own turn wears the brand's orange, so it is findable by colour in a column of grey.
    return (
      <div class={isUser ? "rounded-lg border border-status-working/25 bg-status-working/8 px-3 py-2" : "px-1"}>
        {showHeader ? (
          <div class="mb-1 flex items-center gap-1.5">
            {isUser ? <Icon icon={User} class="size-3.5 text-status-working" /> : <AgentIcon agent={agent ?? "claude"} class="size-4" />}
            <span class={cn("text-[11px] font-semibold tracking-wide uppercase", isUser ? "text-status-working" : "text-muted-foreground")}>
              {isUser ? t("transcript.youLabel") : (agent ?? t("transcript.agentFallback"))}
            </span>
            {time ? <span class="text-[11px] text-muted-foreground">{time}</span> : null}
          </div>
        ) : null}
        <div class="space-y-1.5">
          {entry.parts.map((part, i) => (
            <Part key={String(i)} part={part} query={query} scope={scope} />
          ))}
        </div>
      </div>
    );
  };
}

/**
 * A turn with its tool parts taken out, plus how many were taken. The parts are DROPPED rather than
 * hidden with CSS, so nothing off-screen is built.
 */
export function withoutTools(entry: TranscriptEntry): { entry: TranscriptEntry; hidden: number } {
  const parts = entry.parts.filter((p) => p.kind !== "tool");
  const hidden = entry.parts.length - parts.length;
  return hidden === 0 ? { entry, hidden } : { entry: { ...entry, parts }, hidden };
}

/**
 * One muted line standing in for the steps a turn took, with a tap that brings them back. A silent gap
 * would be worse than the wall it replaced: a reader who cannot see that the agent ran anything cannot
 * tell a quiet turn from a busy one. The line is per TURN, not per call.
 */
function HiddenTools(handle: Handle<{ count: number; onShow: () => void }>) {
  return () => (
    <button
      type="button"
      data-testid="hidden-tools"
      // 44px tap floor (DESIGN.md §6), drawn as a row so it reads as a gap in the transcript.
      class="flex min-h-11 w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors active:bg-muted/60"
      mix={on("click", () => handle.props.onShow())}
    >
      <Icon icon={Wrench} class="size-3.5 shrink-0" />
      {tn("transcript.tools.hidden", handle.props.count)}
    </button>
  );
}

interface TurnBodyProps extends TurnProps {
  drawTools: boolean;
  onShowTools: () => void;
}

function TurnBody(handle: Handle<TurnBodyProps>) {
  return () => {
    const { entry, agent, showHeader, query, scope, drawTools, drawCompactions, onShowTools } = handle.props;
    if (drawTools) {
      return <Turn entry={entry} agent={agent} showHeader={showHeader} query={query} scope={scope} drawCompactions={drawCompactions} />;
    }
    const { entry: trimmed, hidden } = withoutTools(entry);
    // A turn that was NOTHING but tool calls has no header worth keeping either.
    if (trimmed.parts.length === 0) return hidden === 0 ? null : <HiddenTools count={hidden} onShow={onShowTools} />;
    return (
      <>
        <Turn entry={trimmed} agent={agent} showHeader={showHeader} query={query} scope={scope} drawCompactions={drawCompactions} />
        {hidden > 0 ? <HiddenTools count={hidden} onShow={onShowTools} /> : null}
      </>
    );
  };
}

export interface TranscriptViewProps {
  entries: readonly TranscriptEntry[];
  /** The pane's agent name, for the per-turn brand icon. */
  agent?: string;
  /** Active find query, highlighted throughout. */
  query?: string;
  /** The turn a find or jump landed on; ringed so the reader can see where they were sent. */
  focusedUuid?: string;
  scope?: Scope;
}

export function TranscriptView(handle: Handle<TranscriptViewProps>) {
  useLocale(handle);
  const readPrefs = useStore(handle, dashPrefs);
  // Turns whose steps the reader asked to see again, by uuid. Per view and never persisted: the setting is
  // the standing answer, this is "show me this one".
  const shown = new Set<string>();
  return () => {
    const { entries, agent, query = "", focusedUuid, scope } = handle.props;
    const prefs = readPrefs();
    // A FIND ALWAYS WINS: tool output is where a command lives, so a search that matched inside one and
    // then drew nothing would be a silent wrong answer. While a query is on screen every part is drawn.
    const drawTools = prefs.showToolCalls || query !== "";
    const drawCompactions = prefs.showCompactions || query !== "";
    // Consecutive turns from the same speaker are GROUPED: only the first of a run carries the role and
    // time header. A day divider always restarts a run.
    let lastDay = "";
    let lastRole = "";
    return (
      <div class="space-y-3" data-testid="transcript">
        {entries.map((entry) => {
          const day = dayKey(entry.ts);
          const newDay = day !== "" && day !== lastDay;
          if (newDay) lastDay = day;
          const showHeader = newDay || entry.role !== lastRole;
          lastRole = entry.role;
          return (
            <div
              key={entry.uuid}
              data-turn={entry.uuid}
              data-role={entry.role}
              // The jump target's mark is a border present in every turn and transparent until the turn is
              // the one jumped to, so nothing reflows when it lands.
              class={cn("rounded-lg border border-transparent", showHeader ? "space-y-3 pt-1" : "space-y-3", entry.uuid === focusedUuid && "border-primary/60")}
            >
              {newDay ? (
                <div class="flex items-center gap-2 pt-1">
                  <div class="h-px flex-1 bg-border" />
                  <span class="text-[11px] font-medium text-muted-foreground">{day}</span>
                  <div class="h-px flex-1 bg-border" />
                </div>
              ) : null}
              <TurnBody
                entry={entry}
                agent={agent}
                showHeader={showHeader}
                query={query}
                scope={scope}
                drawTools={drawTools || shown.has(entry.uuid)}
                drawCompactions={drawCompactions}
                onShowTools={() => {
                  shown.add(entry.uuid);
                  void handle.update();
                }}
              />
            </div>
          );
        })}
      </div>
    );
  };
}
