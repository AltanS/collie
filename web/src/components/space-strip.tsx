import { ChevronLeft, Plus } from "lucide-react";

import { Chip } from "@/components/ui/chip";
import { SectionLabel } from "@/components/ui/section-label";
import { worstTriage } from "@/lib/triage";
import { useMuxCapability, useMuxHasSpaces } from "@/lib/mux-capability";
import type { AgentView, WorkspaceView } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface SpaceStripProps {
  workspaces: WorkspaceView[];
  agents: AgentView[];
  /** Selected workspace id, or null for the "All" triage view. */
  selected: string | null;
  onSelect: (workspaceId: string | null) => void;
  onNewSpace: () => void;
  /** When set (the drill-in view), lead with an explicit "‹ Back" button to the dashboard instead
   *  of the "All" chip — so the way back is obvious, not reliant on the header wordmark. */
  onBack?: () => void;
}

// A horizontal strip of spaces (Herdr workspaces) above the home list. In the drill-in (`onBack`
// set), it leads with a Back button to the dashboard, then the sibling spaces for quick switching;
// otherwise it leads with the "All" triage chip. A trailing + creates a new space. The space focused
// in the desktop TUI gets a subtle ring; a space with a blocked agent gets a dot.
export function SpaceStrip({
  workspaces,
  agents,
  selected,
  onSelect,
  onNewSpace,
  onBack,
}: SpaceStripProps) {
  const newSpace = useMuxCapability("createSpace");
  // Whether the multiplexer underneath can hold more than one space AT ALL (bridge/mux/
  // capabilities.ts `spaces`). Not "how many are there right now": one space out of many is a herd
  // the operator is about to add to, while one space out of one is a level their multiplexer does
  // not have — and a row of switches with exactly one switch on it says the wrong thing about which.
  const hasSpaces = useMuxHasSpaces();
  useLocale();
  // On a one-space multiplexer the tab strip is the top level and this row has nothing to offer —
  // except the way back, which is navigation rather than a space and must not disappear with them.
  // With no back button there is nothing left to render at all.
  if (!hasSpaces && onBack === undefined) return null;
  // shrink-0: this strip is a child of the space route's `flex-1 flex-col` scroller, so without it
  // the strip flex-shrinks to 16px while its 32px chips overflow — the tab row below then paints
  // straight over the chips.
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-background py-1 pl-1.5 pr-3 text-sm font-medium text-foreground transition-colors hover:bg-muted active:scale-95"
        >
          <ChevronLeft className="size-4" />
          {t("space.strip.back")}
        </button>
      ) : (
        <>
          <SectionLabel>{t("space.strip.title")}</SectionLabel>
          <Chip label={t("space.strip.all")} active={selected === null} onClick={() => onSelect(null)} />
        </>
      )}
      {hasSpaces &&
        workspaces.map((w) => (
          <Chip
            key={w.workspaceId}
            label={w.label}
            active={selected === w.workspaceId}
            ring={w.focused}
            // Same dot language as the tab strip directly below it, and as the herd list.
            status={worstTriage(agents.filter((a) => a.workspaceId === w.workspaceId))}
            onClick={() => onSelect(w.workspaceId)}
          />
        ))}
      {/* Hidden when the multiplexer cannot open a space (M10/06). No explanation HERE: this strip
          is a one-line row of chips with no room for a sentence, and the dashboard's Spaces section
          — the other place this "+" appears — carries the adapter's reason in full. Saying it twice
          in two shapes is how one wording rule turns into two. */}
      {newSpace.capable && (
        <button
          type="button"
          onClick={onNewSpace}
          aria-label={t("space.overview.new.aria")}
          className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95"
        >
          <Plus className="size-4" />
        </button>
      )}
    </div>
  );
}
