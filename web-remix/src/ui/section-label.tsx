import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/section-label.tsx: the small uppercase tag that names a row.
export type SectionLabelPlacement = "inline" | "above";

const PLACEMENT = {
  inline: "shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
  above: "mb-1 block text-[10px] uppercase leading-none tracking-wide text-muted-foreground",
} satisfies Record<SectionLabelPlacement, string>;

export interface SectionLabelProps {
  children?: RemixNode;
  class?: string;
  placement?: SectionLabelPlacement;
  id?: string;
}

export function SectionLabel(handle: Handle<SectionLabelProps>) {
  return () => {
    const { children, placement = "inline", id } = handle.props;
    return (
      <span id={id} class={cn(PLACEMENT[placement], handle.props.class)}>
        {children}
      </span>
    );
  };
}
