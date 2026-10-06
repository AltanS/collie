import { on, type Handle } from "remix/component";
import { SquareTerminal } from "lucide";

import { t } from "@web/lib/i18n";
import { paneName, panePlaceParts, soleTabName } from "@web/lib/pane-name";
import { statusLabel, type AgentView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { PaneMeta } from "../../chips/pane-meta";
import { LONG_PRESS_EVENT, longPress } from "../../lib/gestures";
import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";
import { UnseenMark } from "../../ui/unseen-mark";
import { AgentIcon } from "./agent-icon";

// Port of web/src/components/agent-card.tsx at the dashboard's settings: `density="row"`,
// `statusStyle="dot"`, `tint`. A 44px flat row: the status dot, the agent's tile, the name, the
// unseen square right after it (its slot reserved, so a mark arriving moves nothing), and the meta at
// the end of line 1 (host, session, cache, each chip owning its own hide rule); line 2 is the tab
// (scope `place`, under a workspace heading) or `space › tab` (scope `herd`). A blocked pane wears
// the alarm tint on the whole row.
//
// THE HOLD is the kit's `longPress` mixin (lib/gestures.ts): `data-holding` and the fill from 150 ms,
// `app:longpress` at 450 ms or on `contextmenu`, the click that ends the hold swallowed. The read a tap
// would wait for starts on `pointerdown` (`onPress`). The dot, the tile and the name carry `data-glide`
// parts, and the row is a `pane` glide origin keyed by `glideKey` (lib/glide.ts).
//
// NO TRANSITION ON THE ROW (REMIX3.md rule 7): rows are reorderable, so only colour and the press
// scale are animated, never position.
export interface AgentRowProps {
  agent: AgentView;
  id?: string;
  scope?: "herd" | "place";
  unseen?: boolean;
  glideKey?: string;
  onOpen: (agent: AgentView, row: HTMLElement) => void;
  onPress?: (agent: AgentView) => void;
  onHold?: (agent: AgentView) => void;
}

export function AgentRow(handle: Handle<AgentRowProps>) {
  return () => {
    const { agent, id, scope = "place", unseen = false, glideKey, onHold } = handle.props;
    const isShell = agent.kind === "shell";
    const blocked = agent.status === "blocked";
    const inPlace = scope === "place";
    const place = panePlaceParts(agent);
    const nameIsTab = soleTabName(agent) !== null && paneName(agent) === soleTabName(agent);
    const liveTitle = agent.terminalTitle && agent.terminalTitleStale !== true ? agent.terminalTitle : null;
    const detailLead = inPlace ? null : place.space;
    const detailTail = inPlace ? (nameIsTab ? liveTitle : (place.tab?.text ?? null)) : (place.tab?.text ?? null);
    const tailPositional = inPlace && nameIsTab ? false : (place.tab?.positional ?? false);
    const skipBlankSlot = inPlace && detailTail === null;
    return (
      <button
        id={id}
        type="button"
        data-testid="pane-row"
        data-pane-id={agent.paneId}
        data-glide-origin={glideKey === undefined ? undefined : "pane"}
        data-glide-key={glideKey}
        mix={[
          on("click", (event) => handle.props.onOpen(handle.props.agent, event.currentTarget)),
          on("pointerdown", () => handle.props.onPress?.(handle.props.agent)),
          longPress({ disabled: onHold === undefined }),
          on(LONG_PRESS_EVENT, () => handle.props.onHold?.(handle.props.agent)),
        ]}
        class={cn(
          "w-full text-left transition-colors hover:bg-muted/50 active:scale-[0.99]",
          onHold && "select-none [-webkit-touch-callout:none]",
        )}
      >
        <div class={cn("flex h-11 flex-row items-center gap-3 px-3.5 py-0", blocked && "bg-status-blocked/10")}>
          <div class="min-w-0 flex-1">
            <div data-slot="agent-row-title" class="flex min-w-0 items-center gap-2">
              {!isShell && (
                <span data-glide="dot" class="flex shrink-0 rounded-full">
                  <StatusDot status={agent.status} surface="bg-background" />
                </span>
              )}
              {isShell ? (
                <div data-glide="tile" class="flex size-4 shrink-0 items-center justify-center rounded-sm border bg-muted">
                  <Icon icon={SquareTerminal} class="size-2.5 text-muted-foreground" />
                </div>
              ) : (
                <AgentIcon agent={agent.agent} class="size-4" glide="tile" />
              )}
              <span data-glide="name" class="min-w-0 truncate self-baseline font-medium">
                {paneName(agent)}
              </span>
              <UnseenMark on={unseen} reserve class="ml-2" />
              <PaneMeta host={agent.host} session={agent.session} cache={agent.cache} class="ml-auto self-baseline" />
            </div>
            {!skipBlankSlot && (inPlace || detailLead !== null || detailTail !== null) && (
              <div data-slot="agent-row-detail" class="flex h-4 min-w-0 items-center gap-1 text-xs text-muted-foreground">
                {inPlace && tailPositional && detailTail !== null ? (
                  <span class="min-w-0 flex-1 truncate text-muted-foreground/70">{detailTail}</span>
                ) : (
                  <>
                    {detailLead !== null && <span class="min-w-0 shrink truncate">{detailLead}</span>}
                    {detailLead !== null && detailTail !== null && (
                      <span class="shrink-0 text-muted-foreground/60" aria-hidden="true">
                        ›
                      </span>
                    )}
                    {detailTail !== null && (
                      <span class={cn("min-w-0 flex-1 truncate", tailPositional && "text-muted-foreground/70")}>{detailTail}</span>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          {isShell ? (
            <span class="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("status.shellBadge")}
            </span>
          ) : (
            <span class="sr-only">{statusLabel(agent.status)}</span>
          )}
        </div>
      </button>
    );
  };
}
