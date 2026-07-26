import { useState } from "react";
import { ChevronRight, Info, TriangleAlert, User, Wrench } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { MarkdownText } from "@/components/markdown-text";
import { splitHighlight } from "@/lib/transcript-search";
import type { TranscriptEntry, TranscriptPart } from "@/lib/types";

// Renders an agent transcript — the conversation history a Claude pane's terminal structurally
// cannot hold (it runs on the alternate screen, which keeps no scrollback ring; see
// bridge/transcript.ts). This is a DIFFERENT representation from the terminal mirror, deliberately:
// the mirror is a faithful 51-row snapshot of a TUI, while this is the thread itself — role-tagged
// turns, timestamps, and tool calls folded together with the output they produced.
//
// XSS boundary, same rule as the mirror: every string from the log reaches the DOM as a React TEXT
// NODE, never as markup. Prose IS parsed as Markdown (lib/markdown.ts) — but that parser emits an
// AST which the renderer maps to React elements, so no HTML string is ever constructed. Do not
// "improve" this by swapping in a markdown→HTML library without re-deriving that boundary.

/** Times only — the date lives on the day divider, and a phone row has no width to spare. */
function clockTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayKey(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** Plain text with find hits marked — for strings that are NOT Markdown (shell commands, output). */
function Highlight({ text, query }: { text: string; query: string }) {
  if (query.trim() === "") return <>{text}</>;
  const pieces = splitHighlight(text, query);
  if (pieces.length === 1 && !pieces[0]!.hit) return <>{text}</>;
  return (
    <>
      {pieces.map((piece, i) =>
        piece.hit ? (
          <mark key={i} className="rounded-sm bg-amber-300/70 text-inherit dark:bg-amber-500/40">
            {piece.text}
          </mark>
        ) : (
          <span key={i}>{piece.text}</span>
        ),
      )}
    </>
  );
}

/**
 * A tool call: its one-line summary always, its output behind a tap. Collapsed by default because a
 * thread is mostly tool traffic (705 of 914 turns in a real session) and expanding it all would bury
 * the prose you opened the history to read.
 */
function ToolPart({ part, query }: { part: Extract<TranscriptPart, { kind: "tool" }>; query: string }) {
  const [open, setOpen] = useState(false);
  const result = part.result;
  const isError = result?.isError === true;

  return (
    <div className="rounded-md border bg-muted/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!result}
        aria-expanded={result ? open : undefined}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left disabled:opacity-100"
      >
        {isError ? (
          <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 font-mono text-xs font-semibold">{part.name}</span>
        {part.summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {/* A shell command, NOT prose — markdown-parsing it would eat globs and backticks. */}
            <Highlight text={part.summary} query={query} />
          </span>
        )}
        {result && (
          <ChevronRight
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && result && (
        <pre className="overflow-x-auto border-t px-2 py-1.5 font-mono text-[11px] leading-snug whitespace-pre-wrap">
          {result.text}
          {result.truncated && <span className="text-muted-foreground">{"\n… output truncated"}</span>}
        </pre>
      )}
    </div>
  );
}

function Part({ part, query }: { part: TranscriptPart; query: string }) {
  // Tool output is COMMAND output, not prose — it stays verbatim in a monospace block (see ToolPart).
  if (part.kind === "tool") return <ToolPart part={part} query={query} />;
  // Prose is Markdown, so it renders formatted. MarkdownText emits React elements only — never
  // markup — so this keeps the same XSS boundary the raw text node had.
  return (
    <div>
      <MarkdownText
        text={part.text}
        query={query}
        className={part.kind === "thinking" ? "italic text-muted-foreground" : undefined}
      />
      {part.truncated && <div className="text-xs text-muted-foreground">… truncated</div>}
    </div>
  );
}

function Turn({
  entry,
  agent,
  showHeader,
  query,
}: {
  entry: TranscriptEntry;
  agent?: string;
  /** False for a turn continuing the same speaker's run — see the grouping note in TranscriptView. */
  showHeader: boolean;
  query: string;
}) {
  const time = clockTime(entry.ts);

  // Neither of these is speech, so both render dashed-and-muted — visibly set apart from the
  // conversation rather than attributed to the user or the agent.
  if (entry.role === "summary" || entry.role === "note") {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <Info className="size-3" />
          {entry.role === "summary" ? "Context compacted" : "System"}
          {time && ` · ${time}`}
        </div>
        {entry.parts.map((part, i) => (
          <Part key={i} part={part} query={query} />
        ))}
      </div>
    );
  }

  const isUser = entry.role === "user";
  return (
    <div className={isUser ? "rounded-lg border bg-muted/50 px-3 py-2" : "px-1"}>
      {showHeader && (
        <div className="mb-1 flex items-center gap-1.5">
          {isUser ? (
            <User className="size-3.5 text-muted-foreground" />
          ) : (
            <AgentIcon agent={agent ?? "claude"} className="size-4" />
          )}
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {isUser ? "You" : (agent ?? "agent")}
          </span>
          {time && <span className="text-[11px] text-muted-foreground">{time}</span>}
        </div>
      )}
      <div className="space-y-1.5">
        {entry.parts.map((part, i) => (
          <Part key={i} part={part} query={query} />
        ))}
      </div>
    </div>
  );
}

export function TranscriptView({
  entries,
  agent,
  query = "",
  focusedUuid,
}: {
  entries: TranscriptEntry[];
  /** The pane's agent name, for the per-turn brand icon. */
  agent?: string;
  /** Active find query — highlighted throughout. */
  query?: string;
  /** The turn a find/jump landed on; ringed so you can see where you were sent. */
  focusedUuid?: string;
}) {
  // Consecutive turns from the same speaker are GROUPED — only the first of a run carries the
  // role/time header. A real thread is overwhelmingly long runs of assistant turns (892 of 914 in a
  // measured session), so repeating "CLAUDE 06:43 PM" above every tool call would roughly double the
  // scroll length with nothing new in it. A day divider always restarts a run.
  let lastDay = "";
  let lastRole = "";
  return (
    <div className="space-y-3">
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
            className={`${showHeader ? "space-y-3 pt-1" : "space-y-3"} ${
              entry.uuid === focusedUuid
                ? "rounded-lg ring-2 ring-primary/60 ring-offset-2 ring-offset-background"
                : ""
            }`}
          >
            {newDay && (
              <div className="flex items-center gap-2 pt-1">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[11px] font-medium text-muted-foreground">{day}</span>
                <div className="h-px flex-1 bg-border" />
              </div>
            )}
            <Turn entry={entry} agent={agent} showHeader={showHeader} query={query} />
          </div>
        );
      })}
    </div>
  );
}
