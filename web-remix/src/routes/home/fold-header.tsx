import { on, type Handle, type RemixNode } from "remix/component";
import { ChevronRight } from "lucide";

import { cn } from "@web/lib/utils";

import { Icon } from "../../ui/icon";

// The foldable form of web/src/components/section-header.tsx, for the two dashboard sections that
// fold (Launch and Spaces). routes/home/section-header.tsx is the plain heading; this one wraps a
// disclosure button in the heading, as web/ does, and keeps the section's own control (`trailing`)
// as a SIBLING of the fold button, never inside it.
//
// `aria-controls` is wired only while the controlled body is open: the body leaves the DOM through
// Collapse once it has finished closing, and a dangling id is worse than none.
export interface FoldHeaderProps {
  label: string;
  /** Item count beside the label. */
  count?: number;
  open: boolean;
  onToggle: (open: boolean) => void;
  /** Id of the element this header folds. */
  controls?: string;
  trailing?: RemixNode;
  testId?: string;
  /** Delegated action attributes for an islands document (lib/acts.ts); nothing elsewhere. */
  acts?: Record<string, string>;
}

export function FoldHeader(handle: Handle<FoldHeaderProps>) {
  return () => {
    const { label, count, open, controls, trailing, testId } = handle.props;
    return (
      <div translate="no" class="flex items-center gap-2">
        <h2 class="flex min-w-0 flex-1">
          <button
            type="button"
            data-testid={testId}
            aria-expanded={open ? "true" : "false"}
            {...handle.props.acts}
            aria-controls={controls !== undefined && open ? controls : undefined}
            // min-h-9 keeps the row on the 36px touch floor even though the text is tiny.
            class={cn(
              "flex min-h-9 min-w-0 flex-1 items-center gap-1.5 rounded text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
            mix={on("click", () => handle.props.onToggle(!handle.props.open))}
          >
            <Icon icon={ChevronRight} class={cn("size-3.5 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
            <span class="truncate">{label}</span>
            {count !== undefined && <span class="opacity-60 tabular-nums">({count})</span>}
          </button>
        </h2>
        {trailing && <span class="flex shrink-0 items-center gap-1">{trailing}</span>}
      </div>
    );
  };
}
