import { on, ref, type Handle } from "remix/component";
import { ChevronLeft } from "lucide";

import { t } from "@web/lib/i18n";
import { worstTriage } from "@web/lib/triage";
import type { AgentView, WorkspaceView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { capability } from "../../chips/capability";
import { creating, SPACE_CREATE_KEY } from "../../chips/space-actions";
import { config } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { Chip } from "../../ui/chip";
import { Icon } from "../../ui/icon";
import { STRIP_TAP_TARGET, STRIP_TAP_TARGET_SQUARE } from "../../ui/labelled-strip";
import { SectionLabel } from "../../ui/section-label";
import { revealer, StripAdd } from "./strip-parts";

// Port of web/src/components/space-strip.tsx in its drill-in shape (`onBack` set): the spaces of this
// machine as chips under the name "Spaces", led by a Back button to the dashboard instead of "All".
// The space focused in the desktop TUI gets a ring, a space with something that needs you a dot, and
// the trailing "+" starts a new space. The strip reads its own stores (`config` for the multiplexer's
// facts, `creating` for the in-flight mark), so a poll never reaches it through a parent.
//
// The nav is drawn here and not with `LabelledStrip` because the active chip must be revealed in the
// strip's own scroller, and the kit's strip hands out no ref to it. Its classes are that component's.
export interface SpaceStripProps {
  workspaces: readonly WorkspaceView[];
  agents: readonly AgentView[];
  /** The addressed host: panes of another machine's identically-numbered space do not colour a chip (#209). */
  host: string | undefined;
  /** The open space's id. */
  selected: string;
  onSelect: (workspaceId: string) => void;
  onNewSpace: () => void;
  onBack: () => void;
}

export function SpaceStrip(handle: Handle<SpaceStripProps>) {
  useLocale(handle);
  const readConfig = useStore(handle, config);
  const readCreating = useStore(handle, creating);
  const reveal = revealer(handle);
  const labelId = `space-strip-${handle.id}`;

  return () => {
    const { workspaces, agents, host, selected } = handle.props;
    // Whether the multiplexer can hold more than one space AT ALL (not how many exist now): a row of
    // switches with one switch on it says the wrong thing. Absent config reads as many (fail open).
    const hasSpaces = readConfig().data?.mux?.spaces !== "one";
    const canCreate = capability("createSpace").capable;
    const busy = readCreating().has(SPACE_CREATE_KEY);
    reveal.after(selected);
    // The label is drawn in every state: dropping it would make this strip a different height from
    // one state to the next (D §2).
    return (
      <nav aria-labelledby={labelId} data-testid="space-strip" class="shrink-0 border-b border-rule px-4 pt-1.5">
        <SectionLabel id={labelId} placement="above" class="mb-0">
          {t("space.strip.title")}
        </SectionLabel>
        <div
          mix={ref((node) => reveal.bind(node))}
          class="-mx-4 flex items-center gap-2 overflow-x-auto px-4 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            data-testid="space-back"
            mix={on("click", () => handle.props.onBack())}
            // A chip's height (py-1.5) and a chip's tap floor: the way back answers like the way sideways.
            class={cn(
              STRIP_TAP_TARGET,
              "flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-background py-1.5 pr-3 pl-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-95",
            )}
          >
            <Icon icon={ChevronLeft} class="size-4" />
            {t("space.strip.back")}
          </button>
          {hasSpaces &&
            workspaces.map((w) => (
              <Chip
                key={w.workspaceId}
                label={w.label}
                active={selected === w.workspaceId}
                ring={w.focused}
                // Host-qualified, with the rule `ambientPanes` uses: an untagged agent matches any host.
                status={worstTriage(agents.filter((a) => a.workspaceId === w.workspaceId && (a.host === undefined || a.host === host)))}
                onClick={() => handle.props.onSelect(w.workspaceId)}
              />
            ))}
          {canCreate && (
            <StripAdd
              testId="space-new"
              size="md"
              reach={STRIP_TAP_TARGET_SQUARE}
              label={t("space.overview.new.aria")}
              busy={busy}
              onClick={() => handle.props.onNewSpace()}
            />
          )}
        </div>
      </nav>
    );
  };
}
