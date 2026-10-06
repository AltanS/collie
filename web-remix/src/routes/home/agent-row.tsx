import { on, type Handle } from "remix/component";
import { SquareTerminal } from "lucide";

import { t } from "@web/lib/i18n";
import { hostName, isMultiHost, primarySession } from "@web/lib/hosts";
import { paneName, panePlaceParts, soleTabName } from "@web/lib/pane-name";
import { statusLabel, type AgentView, type ServerSummary, type SessionSummary } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { longPress } from "../../lib/long-press";
import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";
import { UnseenMark } from "../../ui/unseen-mark";
import { AgentIcon } from "./agent-icon";

// Port of web/src/components/agent-card.tsx at the dashboard's settings: `density="row"`,
// `statusStyle="dot"`, `tint`. A 44px flat row: the status dot, the agent's tile, the name, the
// unseen square right after it (its slot reserved), and the address meta at the end of line 1; line 2
// is the tab (scope `place`, under a workspace heading) or `space › tab` (scope `herd`).
//
// The meta is the host and the session, each only when it says something (more than one machine; a
// session other than the primary). Not ported yet: the cache chip and the glide into the pane header.
export interface AgentRowProps {
  agent: AgentView;
  id?: string;
  scope?: "herd" | "place";
  unseen?: boolean;
  servers?: readonly ServerSummary[] | undefined;
  sessions?: readonly SessionSummary[] | undefined;
  onOpen: (agent: AgentView) => void;
  onHold?: (agent: AgentView) => void;
}

export function AgentRow(handle: Handle<AgentRowProps>) {
  const hold = longPress(() => handle.props.onHold?.(handle.props.agent));
  return () => {
    const { agent, id, scope = "place", unseen = false, servers, sessions, onHold } = handle.props;
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
    const host = agent.host !== undefined && isMultiHost(servers) ? (hostName(servers, agent.host) ?? agent.host) : null;
    const session = agent.session !== undefined && agent.session !== primarySession(sessions) ? agent.session : null;
    return (
      <button
        id={id}
        type="button"
        data-testid="pane-row"
        data-pane-id={agent.paneId}
        mix={[on("click", () => handle.props.onOpen(handle.props.agent)), ...(onHold ? hold : [])]}
        class={cn(
          "w-full text-left transition-transform active:scale-[0.99] transition-colors hover:bg-muted/50",
          onHold && "select-none [-webkit-touch-callout:none]",
        )}
      >
        <div class={cn("flex h-11 flex-row items-center gap-3 px-3.5 py-0", blocked && "bg-status-blocked/10")}>
          <div class="min-w-0 flex-1">
            <div data-slot="agent-row-title" class="flex min-w-0 items-center gap-2">
              {!isShell && <StatusDot status={agent.status} surface="bg-background" />}
              {isShell ? (
                <div class="flex size-4 shrink-0 items-center justify-center rounded-sm border bg-muted">
                  <Icon icon={SquareTerminal} class="size-2.5 text-muted-foreground" />
                </div>
              ) : (
                <AgentIcon agent={agent.agent} class="size-4" />
              )}
              <span class="min-w-0 truncate self-baseline font-medium">{paneName(agent)}</span>
              <UnseenMark on={unseen} reserve class="ml-2" />
              <span data-slot="pane-meta" class="ml-auto flex h-3 shrink-0 items-baseline gap-1.5 self-baseline">
                {host !== null && <span class="max-w-[8rem] shrink-0 truncate font-mono text-[11px]/3 text-muted-foreground">{host}</span>}
                {session !== null && <span class="max-w-[8rem] shrink-0 truncate font-mono text-[11px]/3 text-muted-foreground">{session}</span>}
              </span>
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
            <span class="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground transition-opacity">
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
