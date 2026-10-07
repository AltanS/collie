import { on, type Handle } from "remix/component";
import { Info, SquareTerminal } from "lucide";

import { t } from "@web/lib/i18n";
import { paneCwdLine, paneName, panePlaceParts, soleTabName } from "@web/lib/pane-name";
import { statusLabel, type AgentView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { PaneMeta } from "../../chips/pane-meta";
import { holdAct } from "../../lib/acts";
import { LONG_PRESS_EVENT, longPress } from "../../lib/gestures";
import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";
import { UnseenMark } from "../../ui/unseen-mark";
import { AgentIcon } from "./agent-icon";
import { StatusBadge } from "./status-badge";

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
// THE SPACE SCREEN'S CARD (`density="card"`, `statusStyle="badge"`, `scope="tab"`): the same body in a
// bordered, shadowed card with the status spelled out as a pill at the end and, on line 2, the working
// directory in mono (web/ draws the space screen's rows this way; the dashboard's grouped list is
// where the flat, dot-led form belongs). A card row has no stated height, and carries the bridge's hint.
//
// NO TRANSITION ON THE ROW (REMIX3.md rule 7): rows are reorderable, so only colour and the press
// scale are animated, never position.
export interface AgentRowProps {
  agent: AgentView;
  id?: string;
  scope?: "herd" | "place" | "tab";
  /** "row" (default) is the flat 44 px row; "card" is the bordered, shadowed treatment. */
  density?: "row" | "card";
  /** "dot" (default) leads line 1 with the status dot; "badge" ends the row with the status pill. */
  statusStyle?: "dot" | "badge";
  unseen?: boolean;
  glideKey?: string;
  onOpen: (agent: AgentView, row: HTMLElement) => void;
  onPress?: (agent: AgentView) => void;
  onHold?: (agent: AgentView) => void;
  /**
   * In an islands document (S3): the row is a link to its pane, drawn by the bridge and never
   * hydrated. A tap with no JS is a document load; with JS the `gestures` island prefetches it on
   * `pointerdown`, glides, and long-presses it (islands/gestures.tsx). `rowKey` keys it for the
   * runtime's diff (ADR 0063: machine plus pane, never the place). `document`: the pane's page is not an
   * islands page (it shows Chat, ssr/islands-eligible.ts), so the link is a plain document load: no
   * prefetch, no glide, `data-rmx-document`.
   */
  link?: { href: string; rowKey: string; document?: boolean };
}

export function AgentRow(handle: Handle<AgentRowProps>) {
  return () => {
    const { agent, id, scope = "place", density = "row", statusStyle = "dot", unseen = false, glideKey, onHold } = handle.props;
    const flat = density === "row";
    const cornerDot = statusStyle === "dot";
    const inTab = scope === "tab";
    const isShell = agent.kind === "shell";
    const blocked = agent.status === "blocked";
    const inPlace = scope === "place";
    const place = panePlaceParts(agent);
    const nameIsTab = soleTabName(agent) !== null && paneName(agent) === soleTabName(agent);
    const liveTitle = agent.terminalTitle && agent.terminalTitleStale !== true ? agent.terminalTitle : null;
    const detailLead = inPlace || inTab ? null : place.space;
    const detailTail = inTab ? paneCwdLine(agent) : inPlace ? (nameIsTab ? liveTitle : (place.tab?.text ?? null)) : (place.tab?.text ?? null);
    const tailPositional = inTab || (inPlace && nameIsTab) ? false : (place.tab?.positional ?? false);
    const skipBlankSlot = inPlace && detailTail === null;
    const classes = cn(
      "w-full text-left active:scale-[0.99]",
      flat ? "transition-colors hover:bg-muted/50" : "transition-transform",
      (onHold || handle.props.link) && "select-none [-webkit-touch-callout:none]",
    );
    const link = handle.props.link;
    const body = (
        <div
          class={cn(
            "flex flex-row items-center gap-3 px-3.5",
            flat ? "h-11 py-0" : "rounded-xl border bg-card py-3 text-card-foreground shadow-sm",
            blocked && (flat ? "bg-status-blocked/10" : "border-status-blocked/40 bg-status-blocked/5"),
          )}
        >
          <div class="min-w-0 flex-1">
            <div data-slot="agent-row-title" class="flex min-w-0 items-center gap-2">
              {!isShell && cornerDot && (
                <span data-glide="dot" class="flex shrink-0 rounded-full">
                  <StatusDot status={agent.status} surface={flat ? "bg-background" : "bg-card"} />
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
              <div
                data-slot="agent-row-detail"
                class={cn("flex min-w-0 gap-1 text-xs text-muted-foreground", flat ? "h-4 items-center" : "items-baseline")}
              >
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
                      <span class={cn("min-w-0 flex-1 truncate", inTab && "font-mono", tailPositional && "text-muted-foreground/70")}>
                        {detailTail}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
            {!flat && agent.hint && (
              <p class="mt-1 flex items-start gap-1.5 overflow-hidden text-xs leading-snug text-muted-foreground">
                <Icon icon={Info} class="mt-px size-3.5 shrink-0" />
                <span class="min-w-0 truncate" title={agent.hint}>
                  {agent.hint}
                </span>
              </p>
            )}
          </div>
          {isShell ? (
            <span class="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("status.shellBadge")}
            </span>
          ) : cornerDot ? (
            <span class="sr-only">{statusLabel(agent.status)}</span>
          ) : (
            <StatusBadge status={agent.status} />
          )}
        </div>
    );
    if (link !== undefined) {
      return (
        <a
          id={id}
          href={link.href}
          data-testid="pane-row"
          data-pane-id={agent.paneId}
          data-rmx-key={link.rowKey}
          data-rmx-reset-scroll="false"
          data-rmx-document={link.document === true ? "" : undefined}
          data-prefetch={link.document === true ? undefined : ""}
          data-glide-origin={glideKey === undefined || link.document === true ? undefined : "pane"}
          data-glide-key={link.document === true ? undefined : glideKey}
          {...holdAct("pane-actions", { pane: agent.paneId, host: agent.host, session: agent.session })}
          class={cn("block", classes)}
        >
          {body}
        </a>
      );
    }
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
        class={classes}
      >
        {body}
      </button>
    );
  };
}
