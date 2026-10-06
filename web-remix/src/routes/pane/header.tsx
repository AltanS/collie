// The pane screen's header: up one level (ADR 0067), the pane's name and its workspace, and the
// harness capsule. Every name comes from the snapshot payload: the pane's own name through web's
// `paneName`, the workspace label as the multiplexer reported it, and the harness string as Herdr
// reported it. No list of harnesses or multiplexers is consulted to draw any of them.
import { on, type Handle } from "remix/component";
import { ArrowLeft } from "lucide";

import { t } from "@web/lib/i18n";
import { paneName } from "@web/lib/pane-name";
import { statusLabel, type AgentView } from "@web/lib/types";

import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";

export interface PaneHeaderProps {
  paneId: string;
  pane: AgentView | undefined;
  gone: boolean;
  /** Where up lands, for the arrow's name: a space or the dashboard. */
  upPath: string;
  onUp: () => void;
}

export function PaneHeader(handle: Handle<PaneHeaderProps>) {
  return () => {
    const { paneId, pane, gone, upPath } = handle.props;
    const shell = pane?.kind === "shell";
    const name = gone ? t("chat.header.agentGone") : pane ? paneName(pane) : paneId;
    return (
      <header data-slot="pane-header" class="flex min-h-14 shrink-0 items-center gap-1 border-b border-rule px-1 pr-3">
        <button
          type="button"
          data-testid="pane-back"
          aria-label={upPath.startsWith("/space/") ? t("changes.backAria.workspace") : t("changes.backAria.dashboard")}
          class="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground active:bg-muted"
          mix={on("click", () => handle.props.onUp())}
        >
          <Icon icon={ArrowLeft} class="size-5" />
        </button>
        <div class="flex min-w-0 flex-1 flex-col">
          <h1 data-testid="pane-title" class="truncate text-sm leading-tight font-semibold">
            {name}
          </h1>
          {pane && (
            <p data-testid="pane-place" class="truncate text-xs leading-tight text-muted-foreground">
              {pane.workspaceLabel}
            </p>
          )}
        </div>
        {pane && !shell && pane.agent !== "" && (
          <span
            data-testid="harness-capsule"
            class="flex max-w-[40%] shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium"
          >
            <StatusDot status={pane.status} live label={statusLabel(pane.status)} class="size-2" />
            <span class="truncate">{pane.agent}</span>
          </span>
        )}
        {pane && shell && (
          <span class="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
            {t("status.shellBadge")}
          </span>
        )}
      </header>
    );
  };
}
