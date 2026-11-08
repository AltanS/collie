import { Icon } from "@/components/icons/icon";

import { cn } from "@/lib/utils";
import { AgentIcon } from "@/components/agent-icon";
import { StatusDot } from "@/components/status-badge";
import { shownStatus } from "@/lib/triage";
import { statusLabel, type AgentView } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";

/**
 * A PANE'S GLYPH: the agent's logo, or the terminal square for a bare shell, at one size.
 *
 * With `markOn`, the pane's status mark sits on the glyph's bottom-right corner, the badge that the
 * closed rail, a strip column's header and the sidebar's rows draw. `markOn` is the colour the glyph
 * sits on (a `bg-*` class). The mark is `backed` with it, so the logo never shows through the
 * empty half of the working mark or around the triangle (`StatusDot`'s `backed`). The mark is
 * absolute, so the glyph's box is the same with or without it.
 *
 * `named` gives the mark the status word as its accessible name. Pass it where nothing else on the
 * control says the status. The rail does not: its button's own label already holds the word.
 *
 * Without `markOn` the glyph renders alone, with no wrapper.
 */
export function PaneGlyph({
  pane,
  className = "size-7",
  markOn,
  named = false,
}: {
  pane: AgentView;
  /** The glyph's size, a `size-*` class. */
  className?: string;
  /** The surface under the glyph. Given, the status mark is drawn on the glyph's corner. */
  markOn?: string;
  /** Name the mark with the status word, for a control that says the status nowhere else. */
  named?: boolean;
}) {
  useLocale();
  const glyph =
    pane.kind === "shell" ? (
      <Icon name="shell-pane" className={cn(className, "text-muted-foreground")} aria-hidden />
    ) : (
      <AgentIcon agent={pane.agent} className={className} />
    );
  if (markOn === undefined) return glyph;
  const status = shownStatus(pane);
  return (
    <span className="relative inline-flex shrink-0">
      {glyph}
      <StatusDot
        status={status}
        backed
        surface={markOn}
        {...(named ? { label: statusLabel(status) } : {})}
        className="absolute -bottom-1 -right-1"
      />
    </span>
  );
}
