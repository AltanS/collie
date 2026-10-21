import { useCallback, useEffect, useMemo, useState, type MutableRefObject, type ReactNode } from "react";
import { Bot, Check, ChevronRight } from "lucide-react";

import {
  ItemView,
  agentLabel,
  SubagentSheetCtx,
  type SubagentSheetHandle,
  type SubagentTarget,
} from "@/components/chat-cards";
import { MarkdownText } from "@/components/markdown-text";
import { StatusDot } from "@/components/status-badge";
import { BottomSheet, TALL_SHEET_CLEARANCE } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { fetchSubagentTranscript, isApiErrorStatus } from "@/lib/api";
import { itemsOf, type ChatItem, type ChatToolStatus } from "@/lib/chat-items";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const SUBAGENT_POLL_MS = 2_000;

type LoadState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; entries: TranscriptEntry[] };

interface ParsedSubagentView {
  readonly prompt: string | null;
  readonly steps: ChatItem[];
  readonly report: string | null;
}

function splitSubagentEntries(
  entries: readonly TranscriptEntry[],
  status: ChatToolStatus | undefined,
  fallbackReport?: string,
): ParsedSubagentView {
  let prompt: string | null = null;
  let startIdx = 0;
  const first = entries[0];
  if (first !== undefined && first.role === "user") {
    const text = first.parts
      .flatMap((p) => (p.kind === "text" && p.text.trim() !== "" ? [p.text.trim()] : []))
      .join("\n\n");
    if (text !== "") {
      prompt = text;
      startIdx = 1;
    }
  }

  const allItems = entries.slice(startIdx).flatMap((entry) => itemsOf(entry, false));
  const stepCandidates = allItems.filter(
    (item) => item.kind === "tool" || item.kind === "thinking" || item.kind === "reply",
  );
  const finished = status !== "running";
  const tailItem = stepCandidates.at(-1);
  const trailingReply =
    finished && tailItem?.kind === "reply" && tailItem.text.trim() !== "" ? tailItem : null;
  const steps = trailingReply !== null ? stepCandidates.slice(0, -1) : stepCandidates;
  const fallback = fallbackReport !== undefined && fallbackReport.trim() !== "" ? fallbackReport.trim() : null;
  return {
    prompt,
    steps,
    report: finished ? (trailingReply?.text.trim() ?? fallback) : null,
  };
}

export function SubagentSheet({
  paneId,
  scope,
  dismissRef,
  children,
}: {
  paneId: string;
  scope?: Scope;
  dismissRef?: MutableRefObject<(() => boolean) | null>;
  children: ReactNode;
}) {
  useLocale();
  const [target, setTarget] = useState<SubagentTarget | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [promptOpen, setPromptOpen] = useState(false);

  const host = scope?.host;
  const session = scope?.session;
  const paneAddress = `${host ?? ""}\0${session ?? ""}\0${paneId}`;
  const [openedAtAddress, setOpenedAtAddress] = useState(paneAddress);
  // A pane on a crew member: the route is not forwardable, so the lead answers 501 (bridge/server.ts,
  // `PANE_SUBAGENT_ROUTE`). Remembered per pane address, so the sheet stops polling and asks no more
  // for that pane; it shows the report folded onto the card instead.
  const [unfederatedAt, setUnfederatedAt] = useState<string | null>(null);
  const unfederated = unfederatedAt === paneAddress;

  if (target !== null && openedAtAddress !== paneAddress) {
    setTarget(null);
    setOpenedAtAddress(paneAddress);
  }

  const open = useCallback(
    (next: SubagentTarget) => {
      setOpenedAtAddress(paneAddress);
      setTarget(next);
      setPromptOpen(false);
      setLoadState(next.agentId === undefined || unfederated ? { kind: "unavailable" } : { kind: "loading" });
    },
    [paneAddress, unfederated],
  );

  const sync = useCallback(
    (next: SubagentTarget) => {
      setTarget((prev) => {
        if (prev === null || prev.cardKey !== next.cardKey) return prev;
        if (
          prev.agentId === next.agentId &&
          prev.status === next.status &&
          prev.output === next.output &&
          prev.summary === next.summary
        ) {
          return prev;
        }
        if (prev.agentId === undefined && next.agentId !== undefined && !unfederated) {
          setLoadState({ kind: "loading" });
        }
        return next;
      });
    },
    [unfederated],
  );

  const close = useCallback(() => {
    setTarget(null);
  }, []);

  useEffect(() => {
    if (dismissRef === undefined) return;
    dismissRef.current = () => {
      if (target === null) return false;
      setTarget(null);
      return true;
    };
    return () => {
      dismissRef.current = null;
    };
  }, [dismissRef, target]);

  const view = useMemo<ParsedSubagentView>(() => {
    if (loadState.kind === "ready") {
      return splitSubagentEntries(loadState.entries, target?.status, target?.output);
    }
    const finished = target?.status !== "running";
    return {
      prompt: null,
      steps: [],
      report:
        finished && target?.output !== undefined && target.output.trim() !== ""
          ? target.output.trim()
          : null,
    };
  }, [loadState, target?.status, target?.output]);

  const agentId = target?.agentId;
  const running = target?.status === "running";

  useEffect(() => {
    if (agentId === undefined || unfederated) return;
    let cancelled = false;
    const ac = new AbortController();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };

    const load = async () => {
      try {
        const res = await fetchSubagentTranscript(paneId, agentId, scope, ac.signal);
        if (cancelled) return;
        if (res.available) {
          setLoadState({ kind: "ready", entries: res.entries });
        } else {
          setLoadState({ kind: "unavailable" });
        }
      } catch (error) {
        if (cancelled) return;
        if (isApiErrorStatus(error, 501)) {
          stop();
          setUnfederatedAt(paneAddress);
        }
        setLoadState({ kind: "unavailable" });
      }
    };

    void load();
    if (running) timer = setInterval(() => void load(), SUBAGENT_POLL_MS);
    return () => {
      cancelled = true;
      ac.abort();
      stop();
    };
  }, [paneId, agentId, running, host, session, scope, unfederated, paneAddress]);

  const handle = useMemo<SubagentSheetHandle>(
    () => ({
      activeCardKey: target?.cardKey ?? null,
      open,
      sync,
    }),
    [target?.cardKey, open, sync],
  );

  const titleNode = target && (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Bot className="size-3.5 shrink-0" />
        <span className="truncate">{agentLabel(target.agent)}</span>
        {running && (
          <StatusDot status="working" live label={t("chat.card.status.running")} className="size-2" />
        )}
      </span>
      <span className="font-content truncate text-sm font-semibold text-foreground">{target.summary}</span>
    </span>
  );

  return (
    <SubagentSheetCtx.Provider value={handle}>
      {children}
      <BottomSheet
        open={target !== null}
        onClose={close}
        title={titleNode}
        className={cn("max-h-[82dvh]", TALL_SHEET_CLEARANCE)}
      >
        <div className="flex flex-col gap-2.5 px-3 py-3">
          {loadState.kind === "loading" && (
            <p className="py-6 text-center text-xs text-muted-foreground">{t("files.loading")}</p>
          )}

          {view.prompt !== null && (
            <div className="overflow-hidden rounded-md border border-status-working/25 bg-status-working/8">
              <button
                type="button"
                aria-expanded={promptOpen}
                onClick={() => setPromptOpen((v) => !v)}
                className="flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs transition-colors active:bg-status-working/15"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-status-working transition-transform",
                    promptOpen && "rotate-90",
                  )}
                />
                <span className="shrink-0 font-semibold text-status-working">{t("chat.subagent.prompt")}</span>
                {!promptOpen && (
                  <span className="font-content min-w-0 flex-1 truncate text-muted-foreground">
                    {view.prompt.split("\n")[0]}
                  </span>
                )}
              </button>
              {promptOpen && (
                <p className="font-content border-t border-status-working/20 px-3 py-2.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
                  {view.prompt}
                </p>
              )}
            </div>
          )}

          {view.steps.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {view.steps.map((item) => (
                <ItemView key={item.id} item={item} />
              ))}
            </div>
          )}

          {view.report !== null && (
            <div
              className={cn(
                "rounded-md border border-border bg-card px-3 py-2.5",
                target?.status === "failed" && "border-status-blocked/35",
              )}
            >
              <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                {target?.status === "failed" ? (
                  <span className="text-status-blocked">{t("chat.card.status.failed")}</span>
                ) : (
                  <>
                    <Check className="size-3.5 text-status-done" />
                    <span>{t("chat.subagent.report")}</span>
                  </>
                )}
              </div>
              <MarkdownText text={view.report} />
            </div>
          )}
        </div>
      </BottomSheet>
    </SubagentSheetCtx.Provider>
  );
}
