import { Archive, Loader2 } from "lucide-react";
import { useId } from "react";

import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { groupConversations, type ConversationItem, type ConversationState } from "@/lib/conversation-list";
import { timeAgoShort } from "@/lib/format";
import { t, tn } from "@/lib/i18n";
import { statusLabel, statusLabelPast, type AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE DURABLE HOME: a durable program's conversations as the dashboard's whole body, the way a messaging
// app lists its chats.
//
// One list, no filter chips (durable-simple, 2026-10-13). The rows order themselves: what waits on you,
// then the other open conversations, then, under a "Closed" label, the closed ones. The rows are flat rows
// in one `ui/list-group.tsx`, the dashboard's own row treatment: a stated 44px (a 20px line over a 16px
// line), the state mark leading line 1 the way `agent-card.tsx` leads with its dot. Line 2 is the question
// that waits on you, when one does, else the program's subtitle.
//
// Presentational: the route owns the reads and the taps, so the playground draws every state of this file
// from plain props.

/** The status the shared mark draws for an open conversation's state. */
const MARK = {
  working: "working",
  waiting: "blocked",
  idle: "idle",
} satisfies Record<Exclude<ConversationState, "closed">, AgentStatus>;

/** The shared status mark an open conversation draws, or null for a closed one, which draws its own. */
function markOf(state: ConversationState): AgentStatus | null {
  return state === "closed" ? null : MARK[state];
}

/** The state in words, for the screen reader: the mark is a shape and a colour. */
function stateWords(state: ConversationState, stale: boolean): string {
  const mark = markOf(state);
  if (mark === null) return t("conversations.state.closed");
  return stale ? statusLabelPast(mark) : statusLabel(mark);
}

export function ConversationRow({
  item,
  onOpen,
  onPress,
  glideKey,
  stale = false,
  now,
}: {
  item: ConversationItem;
  /** The tap, handed the row's own button (the glide's origin for a live pane). */
  onOpen: (row: HTMLButtonElement) => void;
  /** The finger landed: the moment to start a live pane's read. */
  onPress?: () => void;
  glideKey?: string;
  /** Drawn from the saved copy: dimmed as one piece, and the state said in the past tense. */
  stale?: boolean;
  /** The clock the time reads against. The playground pins it; the app reads it per render. */
  now?: number;
}) {
  useLocale();
  const id = useId();
  const mark = markOf(item.state);
  const closed = mark === null;
  const title = item.title === "" ? t("conversations.untitled") : item.title;
  const when = item.at === null ? "" : timeAgoShort(item.at, now);
  return (
    <button
      type="button"
      data-slot="conversation-row"
      data-state={item.state}
      onClick={(e) => onOpen(e.currentTarget)}
      onPointerDown={onPress}
      data-glide-origin={glideKey === undefined ? undefined : "pane"}
      data-glide-key={glideKey}
      // The name is the two lines as read: the title with its state, count and time, then the line under it.
      aria-labelledby={`${id}-title ${id}-line`}
      className="w-full text-left transition-colors hover:bg-muted/50 active:bg-muted"
    >
      <div
        className={cn(
          // The row states its height, a 20px line over a 16px one in 44px, so nothing that arrives or
          // leaves on it (a count, a second line, a question) moves the list (DESIGN.md §2).
          "flex h-11 flex-row items-center gap-3 px-3.5 transition-opacity",
          // The blocked tint, the one cue the dashboard row keeps for a pane that waits on a person.
          item.state === "waiting" && "bg-status-blocked/5",
          stale && "opacity-50",
        )}
      >
        <div className="min-w-0 flex-1">
          <div id={`${id}-title`} data-slot="conversation-title" className="flex h-5 min-w-0 items-center gap-2">
            {mark === null ? (
              <span aria-hidden className="flex size-3 shrink-0 items-center justify-center text-muted-foreground">
                <Archive className="size-3" />
              </span>
            ) : (
              <StatusDot status={mark} glide="dot" className="-mx-px" />
            )}
            <span data-glide="name" className={cn("min-w-0 truncate font-medium", closed && "text-muted-foreground")}>
              {title}
            </span>
            {item.asks > 0 && (
              <Badge
                variant="secondary"
                data-slot="conversation-asks"
                className="h-4 min-w-4 px-1 py-0 text-[11px] leading-none tabular-nums"
              >
                <span aria-hidden>{item.asks}</span>
                <span className="sr-only">{tn("home.conversations.asks", item.asks)}</span>
              </Badge>
            )}
            <span className="sr-only">{stateWords(item.state, stale)}</span>
            <span data-slot="conversation-time" className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
              {when}
            </span>
          </div>
          <div
            id={`${id}-line`}
            data-slot="conversation-line"
            className={cn(
              "h-4 min-w-0 truncate text-xs leading-4",
              // A question that waits on you reads in the ink of the title: it is the thing to act on.
              item.asking ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {item.line ?? ""}
          </div>
        </div>
      </div>
    </button>
  );
}

/** What sits under the rows: a Load more, or a line on why the closed ones are missing. */
export type ConversationListFoot =
  | { kind: "none" }
  | { kind: "more"; busy: boolean; onMore: () => void }
  | { kind: "note"; text: string };

const NO_FOOT: ConversationListFoot = { kind: "none" };

function Rows({
  items,
  onOpen,
  onPress,
  glideKeyOf,
  stale,
  now,
}: {
  items: readonly ConversationItem[];
  onOpen: (item: ConversationItem, row: HTMLButtonElement) => void;
  onPress?: (item: ConversationItem) => void;
  glideKeyOf?: (item: ConversationItem) => string | undefined;
  stale: boolean;
  now?: number;
}) {
  return (
    <ListGroup as="ul">
      {items.map((item) => (
        <li key={item.key}>
          <ConversationRow
            item={item}
            onOpen={(row) => onOpen(item, row)}
            onPress={onPress === undefined ? undefined : () => onPress(item)}
            glideKey={glideKeyOf?.(item)}
            stale={stale && item.pane !== undefined}
            now={now}
          />
        </li>
      ))}
    </ListGroup>
  );
}

export function ConversationList({
  items,
  workspaces,
  onOpen,
  onPress,
  glideKeyOf,
  foot = NO_FOOT,
  stale = false,
  now,
}: {
  /** Every row, merged and in order (`mergeConversations`). */
  items: readonly ConversationItem[];
  /** The machine's workspaces, for the group headings. One workspace draws no heading. */
  workspaces: readonly { workspaceId: string; label: string }[];
  onOpen: (item: ConversationItem, row: HTMLButtonElement) => void;
  onPress?: (item: ConversationItem) => void;
  glideKeyOf?: (item: ConversationItem) => string | undefined;
  foot?: ConversationListFoot;
  stale?: boolean;
  now?: number;
}) {
  useLocale();
  const open = items.filter((item) => item.state !== "closed");
  const closed = items.filter((item) => item.state === "closed");
  const groups = groupConversations(open, workspaces);
  const rows = { onOpen, onPress, glideKeyOf, stale, now };
  return (
    <div data-slot="conversation-list" className="flex flex-col gap-4 px-4 py-4">
      {items.length === 0 ? (
        <p data-slot="conversation-empty" className="py-12 text-center text-sm text-muted-foreground">
          {t("conversations.empty")}
        </p>
      ) : (
        <>
          {open.length > 0 &&
            groups.map((group) => (
              <section key={group.key} aria-label={group.label ?? undefined} className="flex flex-col">
                {group.label !== null && <SectionLabel placement="above">{group.label}</SectionLabel>}
                <Rows items={group.items} {...rows} />
              </section>
            ))}
          {closed.length > 0 && (
            <section data-slot="conversation-closed" aria-label={t("conversations.state.closed")} className="flex flex-col">
              <SectionLabel placement="above">{t("conversations.state.closed")}</SectionLabel>
              <Rows items={closed} {...rows} />
            </section>
          )}
        </>
      )}
      {foot.kind === "more" && (
        <Button variant="ghost" className="h-11 self-center" onClick={foot.onMore} disabled={foot.busy}>
          {foot.busy && <Loader2 className="animate-spin" />}
          {foot.busy ? t("conversations.loading") : t("conversations.loadMore")}
        </Button>
      )}
      {foot.kind === "note" && (
        <p data-slot="conversation-note" className="text-center text-xs leading-relaxed text-muted-foreground">
          {foot.text}
        </p>
      )}
    </div>
  );
}
