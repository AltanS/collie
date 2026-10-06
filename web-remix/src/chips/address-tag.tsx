import type { Handle, RemixNode } from "remix/component";

import { HOST_SLOT_COUNT, HOST_TEXT_CLASSES } from "@web/lib/hosts";
import { cn } from "@web/lib/utils";

// Port of web/src/components/ui/address-tag.tsx: the small bordered pill a machine or a session name
// wears. Only the GLYPH takes the host tint; the border, the fill and the name stay the same classes
// for every machine. `alert` (dashed, blocked ink) and `waiting` (dashed, working ink) are the two
// degraded readings, and a state outranks identity.
export interface AddressTagProps {
  label: string;
  glyph?: RemixNode;
  prefix?: string;
  name: string;
  size?: "sm" | "md";
  tone?: "quiet" | "waiting" | "alert";
  slot?: number | null;
  class?: string;
}

function glyphTint(slot: number | null | undefined): string | undefined {
  if (slot === null || slot === undefined || slot < 0 || slot >= HOST_SLOT_COUNT) return undefined;
  return HOST_TEXT_CLASSES[slot];
}

export function AddressTag(handle: Handle<AddressTagProps>) {
  return () => {
    const { label, glyph, prefix, name, size = "sm", tone = "quiet", slot } = handle.props;
    return (
      <span
        aria-label={label}
        data-slot="address-tag"
        class={cn(
          "inline-flex max-w-[8rem] shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-medium",
          size === "md" ? "text-[11px]" : "text-[10px]",
          tone === "alert"
            ? "border-dashed border-status-blocked/50 bg-status-blocked/10 text-status-blocked"
            : tone === "waiting"
              ? "border-dashed border-status-working/50 bg-status-working/10 text-status-working"
              : "border-border bg-muted/60 text-muted-foreground",
          handle.props.class,
        )}
      >
        {glyph !== undefined ? <span class={tone === "quiet" ? glyphTint(slot) : undefined}>{glyph}</span> : null}
        {prefix !== undefined ? (
          <span class="shrink-0 text-muted-foreground/70" aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        <span class="truncate" aria-hidden="true">
          {name}
        </span>
      </span>
    );
  };
}
