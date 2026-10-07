import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/section-header.tsx, the non-folding form the dashboard uses: a
// heading with an optional dot and count, in the muted or the strong voice, and a trailing slot.
export interface SectionHeaderProps {
  label: string;
  count?: number;
  dot?: string;
  accent?: boolean;
  trailing?: RemixNode;
  id?: string;
  tone?: "muted" | "strong";
  /** The label is one of the UI's own words (Pinned, Needs you), not a name: the translator skips it. */
  ui?: boolean;
  class?: string;
}

export function SectionHeader(handle: Handle<SectionHeaderProps>) {
  return () => {
    const { label, count, dot, accent, trailing, id, tone = "muted" } = handle.props;
    const color = accent ? "text-status-blocked" : tone === "strong" ? "text-foreground" : "text-muted-foreground";
    const type = tone === "strong" && !accent ? "text-[13px] font-semibold tracking-normal" : "text-xs font-semibold uppercase tracking-wide";
    return (
      <div translate={handle.props.ui === true ? "no" : undefined} class={cn("flex items-center gap-2", handle.props.class)}>
        <h2 id={id} class="flex min-w-0 flex-1">
          <span class={cn("flex min-w-0 flex-1 items-center gap-1.5", type, color)}>
            {dot && <span class={cn("size-2 shrink-0 rounded-full", dot)} aria-hidden="true" />}
            <span class="truncate">{label}</span>
            {count !== undefined && <span class="opacity-60 tabular-nums">({count})</span>}
          </span>
        </h2>
        {trailing && <span class="flex shrink-0 items-center gap-1">{trailing}</span>}
      </div>
    );
  };
}
