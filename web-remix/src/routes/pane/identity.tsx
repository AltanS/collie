// The pane header's identity block, claimed as a custom centre slot (shell/header-model.ts): the
// shell's own pane centre draws its meta as a plain string, and this line carries buttons (the cache
// reading opens the cache sheet), so the pane draws the block itself. The geometry is the shell's
// PaneIdentity and web's agent-chat.tsx header, kept to the pixel so the glide pairs still match:
// min-h-11; line 1 is a 20px row with the 16px agent tile, its 8px status dot badged on the corner,
// and the name; line 2 is 12px, the workspace on the left and PaneMeta (host, session, cache) on the
// right. Two 30px overlay buttons cover the two lines: the name opens the pane settings sheet, the
// workspace opens that space's overview.
import { on, type Handle } from "remix/component";
import { SquareTerminal } from "lucide";

import { t } from "@web/lib/i18n";
import { statusLabel, type AgentStatus, type PaneCache } from "@web/lib/types";

import { PaneMeta } from "../../chips/pane-meta";
import { useLocale } from "../../lib/i18n-store";
import { AgentIcon } from "../home/agent-icon";
import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";

export interface PaneIdentityProps {
  name: string;
  workspace: string;
  /** Undefined for a bare shell: the tile is the terminal glyph and no dot is badged on it. */
  agent: string | undefined;
  status: AgentStatus | undefined;
  host: string | undefined;
  session: string | undefined;
  cache: PaneCache | undefined;
  /** The pane is gone: one line, no buttons. */
  gone: boolean;
  onName: () => void;
  onWorkspace: () => void;
  onCache: () => void;
}

export function PaneIdentity(handle: Handle<PaneIdentityProps>) {
  useLocale(handle);
  return () => {
    const { name, workspace, agent, status, host, session, cache, gone } = handle.props;
    if (gone) {
      return (
        <div data-slot="pane-identity" class="flex min-h-11 min-w-0 flex-1 items-center">
          <h1 data-testid="pane-title" class="min-w-0 truncate text-base leading-5 font-semibold">
            {t("chat.header.agentGone")}
          </h1>
        </div>
      );
    }
    const shell = agent === undefined;
    const stateWord = shell ? t("status.shellBadge") : status ? statusLabel(status) : "";
    return (
      <div data-slot="pane-identity" data-glide-destination="pane" class="relative flex min-h-11 min-w-0 flex-1 flex-col justify-center">
        <div class="pointer-events-none flex min-w-0 items-center gap-2 leading-5">
          <span data-glide="tile" class="relative flex shrink-0">
            {shell ? (
              <span class="flex size-4 items-center justify-center rounded-sm border bg-muted">
                <Icon icon={SquareTerminal} class="size-2.5 text-muted-foreground" />
                <span class="sr-only">{t("status.shellBadge")}</span>
              </span>
            ) : (
              <AgentIcon agent={agent} class="size-4" />
            )}
            {!shell && status ? (
              <span data-glide="dot" class="absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-background">
                <StatusDot status={status} label={statusLabel(status)} live class="size-2" />
              </span>
            ) : null}
          </span>
          <h1 data-testid="pane-title" data-glide="name" class="min-w-0 truncate text-base leading-5 font-semibold">
            {name}
          </h1>
        </div>
        <div class="mt-1 flex h-3 min-w-0 items-baseline gap-2">
          <span data-testid="pane-place" class="pointer-events-none min-w-0 truncate text-[11px] leading-3 text-muted-foreground">
            {workspace}
          </span>
          <PaneMeta host={host} session={session} cache={cache} onOpenCache={() => handle.props.onCache()} class="relative z-10 ml-auto" />
        </div>
        <button
          type="button"
          data-testid="pane-name-button"
          aria-label={t("chat.header.openPaneSettingsAria", { name })}
          class="absolute inset-x-0 -top-2 h-[30px] rounded-t-lg active:bg-muted/60"
          mix={on("click", () => handle.props.onName())}
        />
        <button
          type="button"
          data-testid="pane-workspace-button"
          aria-label={t("chat.header.openOverviewAria", {
            workspace,
            status: stateWord === "" ? "" : t("chat.header.statusAria", { label: stateWord }),
          })}
          class="absolute inset-x-0 -bottom-2 h-[30px] rounded-b-lg active:bg-muted/60"
          mix={on("click", () => handle.props.onWorkspace())}
        />
      </div>
    );
  };
}
