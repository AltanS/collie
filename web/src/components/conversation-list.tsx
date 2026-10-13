import { Archive, Loader2 } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { Progress } from "@/components/ui/progress";
import { SectionLabel } from "@/components/ui/section-label";
import { Segmented, type SegmentedOption } from "@/components/ui/segmented";
import { useLocale } from "@/hooks/use-locale";
import {
  CONVERSATION_FILTERS,
  groupConversations,
  passesFilter,
  type ConversationFilter,
  type ConversationItem,
  type ConversationState,
} from "@/lib/conversation-list";
import { timeAgoShort } from "@/lib/format";
import { t, tn, type MessageKey } from "@/lib/i18n";
import { statusLabel, statusLabelPast, type AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

// THE DURABLE HOME (M53 spec 12): a durable program's conversations as the dashboard's whole body.
//
// The filter chips are `ui/segmented.tsx`: four labelled segments, exactly one on, each reserving its
// border so a switch moves nothing (DESIGN.md §2), and a count on "Needs you" floated on its corner.
// The rows are flat rows in one `ui/list-group.tsx`, the dashboard's own row treatment: a stated 44px
// (a 20px line over a 16px line), the state mark leading line 1 the way `agent-card.tsx` leads with
// its dot, and the hairline progress along the bottom edge, inside the row, adding no height.
//
// Presentational: the route owns the reads, the filter and the taps, so the playground draws every state
// of this file from plain props.

const FILTER_LABEL = {
  all: "home.conversations.filter.all",
  open: "home.conversations.filter.open",
  needsYou: "home.conversations.filter.needsYou",
  closed: "home.conversations.filter.closed",
} satisfies Record<ConversationFilter, MessageKey>;

const EMPTY = {
  all: "conversations.empty",
  open: "home.conversations.empty.open",
  needsYou: "home.conversations.empty.needsYou",
  closed: "home.conversations.empty.closed",
} satisfies Record<ConversationFilter, MessageKey>;

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
      className="w-full text-left transition-colors hover:bg-muted/50 active:bg-muted"
    >
      <div
        className={cn(
          // The row states its height, a 20px line over a 16px one in 44px, so nothing that arrives or
          // leaves on it (a count, a subtitle, a bar) moves the list (DESIGN.md §2).
          "relative flex h-11 flex-row items-center gap-3 px-3.5 transition-opacity",
          // The blocked tint, the one cue the dashboard row keeps for a pane that waits on a person.
          item.state === "waiting" && "bg-status-blocked/5",
          stale && "opacity-50",
        )}
      >
        <div className="min-w-0 flex-1">
          <div data-slot="conversation-title" className="flex h-5 min-w-0 items-center gap-2">
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
          {(item.subtitle !== null || item.items !== null) && (
            <div data-slot="conversation-detail" className="flex h-4 min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{item.subtitle ?? ""}</span>
              {item.items !== null && (
                <span className="shrink-0 tabular-nums">{tn("conversations.items", item.items)}</span>
              )}
            </div>
          )}
        </div>
        {item.progress !== null && (
          <Progress
            value={item.progress.value}
            label={t("chat.progress.aria")}
            size="hairline"
            className="pointer-events-none absolute inset-x-3.5 bottom-0 w-auto"
          />
        )}
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

export function ConversationList({
  items,
  workspaces,
  filter,
  onFilterChange,
  onOpen,
  onPress,
  glideKeyOf,
  foot = NO_FOOT,
  stale = false,
  now,
}: {
  /** Every row, merged and in order (`mergeConversations`). The filter is applied here. */
  items: readonly ConversationItem[];
  /** The machine's workspaces, for the group headings. One workspace draws no heading. */
  workspaces: readonly { workspaceId: string; label: string }[];
  filter: ConversationFilter;
  onFilterChange: (filter: ConversationFilter) => void;
  onOpen: (item: ConversationItem, row: HTMLButtonElement) => void;
  onPress?: (item: ConversationItem) => void;
  glideKeyOf?: (item: ConversationItem) => string | undefined;
  foot?: ConversationListFoot;
  stale?: boolean;
  now?: number;
}) {
  useLocale();
  const waiting = items.filter((item) => item.state === "waiting").length;
  // "Needs you" carries the count of conversations that wait on a person, on its corner.
  const options = CONVERSATION_FILTERS.map((value): SegmentedOption<ConversationFilter> => {
    const option: SegmentedOption<ConversationFilter> = { value, label: t(FILTER_LABEL[value]) };
    if (value === "needsYou") {
      option.badge = waiting;
      option.badgeLabel = tn("home.conversations.needsYouCount", waiting);
    }
    return option;
  });
  const shown = items.filter((item) => passesFilter(item, filter));
  const groups = groupConversations(shown, workspaces);
  return (
    <div data-slot="conversation-list" className="flex flex-col gap-3 px-4 py-4">
      <Segmented
        options={options}
        value={filter}
        onChange={onFilterChange}
        label={t("home.conversations.filter")}
        // The dashboard tab's own count fill (`ui/tab-bar.tsx`): a count of panes that wait on you.
        badgeClassName="bg-status-blocked text-background"
      />
      {shown.length === 0 ? (
        <p data-slot="conversation-empty" className="py-12 text-center text-sm text-muted-foreground">
          {t(EMPTY[filter])}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.key} aria-label={group.label ?? undefined} className="flex flex-col">
            {group.label !== null && <SectionLabel placement="above">{group.label}</SectionLabel>}
            <ListGroup as="ul">
              {group.items.map((item) => (
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
          </section>
        ))
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
