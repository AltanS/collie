// The agent's newest reply, standing IN PLACE OF the mirror rows that could only hold its end. Port of
// web/src/hooks/use-latest-reply.ts (the read) and web/src/components/latest-reply.tsx (the card).
//
// WHY. An agent's TUI runs on the alternate screen, so the mirror is the viewport and a reply longer
// than the pane has lost its opening by the time it is read. The journal has it. web's
// `locateReply` (web/src/lib/latest-reply.ts, read-only) decides whether the journal's newest reply is
// the one on screen and whether its opening is gone; only `clipped` draws the card, and the card hides
// the mirror rows it covers, so the same words never print twice.
//
// WHEN IT READS. Not on the poll: a history read re-parses the agent's log bridge-side. The first read
// is at once; after that it waits for the mirror to hold still for SETTLE_MS, which a streaming reply
// never does. So about one read per finished message. A failed read costs only the card.
//
// The pane route owns one reader per pane (the route is keyed by pane, rule 3), feeds it the screen
// text from a `queueTask` after each render, and asks it for the reply in render.
import { on, type Handle } from "remix/component";
import { ChevronRight } from "lucide";

import { fetchHistory } from "@web/lib/api";
import { t } from "@web/lib/i18n";
import { newestReply } from "@web/lib/latest-reply";
import type { Scope } from "@web/lib/scope";
import type { TranscriptEntry } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { TranscriptView } from "../history/transcript";

/** Turns requested. The newest SPOKEN turn may sit behind a run of tool calls, so ask for a few. */
const TURNS = 8;
/** How long the mirror must hold still before its content counts as a finished message. */
export const SETTLE_MS = 1500;

export interface LatestReplyReader {
  /** Feed the screen as drawn. Call after the commit, never in render: it may start a timer or a read. */
  see(text: string, enabled: boolean): void;
  /** The newest reply read so far, or null; null whenever the reader is switched off. */
  reply(enabled: boolean): TranscriptEntry | null;
}

/** One reader for one pane. `wake` runs when a read lands; everything ends on `signal`. */
export function createLatestReply(paneId: string, scope: Scope | undefined, wake: () => void, signal: AbortSignal): LatestReplyReader {
  let reply: TranscriptEntry | null = null;
  let lastText: string | null = null;
  let readOnce = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | null = null;

  const stop = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    inflight?.abort();
    inflight = null;
  };
  signal.addEventListener("abort", stop, { once: true });

  const read = async (): Promise<void> => {
    inflight?.abort();
    const mine = new AbortController();
    inflight = mine;
    readOnce = true;
    try {
      const page = await fetchHistory(paneId, { limit: TURNS }, scope, mine.signal);
      if (mine.signal.aborted || signal.aborted) return;
      if (page.available) {
        reply = newestReply(page.entries);
        wake();
      }
    } catch {
      // A cancelled or failed read leaves the previous reply in place.
    } finally {
      if (inflight === mine) inflight = null;
    }
  };

  return {
    see(text, enabled) {
      if (signal.aborted) return;
      if (!enabled) {
        stop();
        lastText = null;
        return;
      }
      if (text === lastText) return;
      lastText = text;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (text === "") return;
      if (!readOnce) {
        void read();
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        void read();
      }, SETTLE_MS);
    },
    reply(enabled) {
      return enabled ? reply : null;
    },
  };
}

export interface LatestReplyCardProps {
  entry: TranscriptEntry;
  agent?: string;
  /** Expanded shows the message and the mirror rows it covers stay hidden; collapsed does the reverse. */
  open: boolean;
  onToggle: () => void;
  scope?: Scope;
}

/**
 * The card. A TRANSCRIPT surface, not a mirror one: Markdown in ordinary app theming through the
 * History view's renderer, never the mirror's colour space. Open state is the route's, because it
 * also decides which mirror rows show.
 */
export function LatestReplyCard(handle: Handle<LatestReplyCardProps>) {
  useLocale(handle);
  return () => {
    const { entry, agent, open, onToggle, scope } = handle.props;
    return (
      <div class="mb-2 rounded-lg border bg-muted/30" data-testid="latest-reply" data-open={open ? "" : undefined}>
        <button
          type="button"
          aria-expanded={open}
          class="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors active:bg-muted/60"
          mix={on("click", () => onToggle())}
        >
          <Icon icon={ChevronRight} class={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          <span class="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{t("chat.fullReply.title")}</span>
          <span class="ml-auto truncate text-[11px] text-muted-foreground">{open ? t("chat.fullReply.fromTranscript") : t("chat.fullReply.showingTerminal")}</span>
        </button>
        <Collapse open={open}>
          <div class="border-t px-2.5 py-2">
            <TranscriptView entries={[entry]} agent={agent} scope={scope} />
          </div>
        </Collapse>
      </div>
    );
  };
}
