import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

import { SectionLabel } from "./section-label";

// Port of web/src/components/ui/labelled-strip.tsx: the strip constants (the 44px tap floor bought
// as hit area, the edge-to-edge scroller) and the labelled strip itself. The React original hides
// the label under a context (`CompactStripLabels`); here that is the `compact` prop.

export const STRIP_TAP_TARGET =
  "relative before:absolute before:inset-x-0 before:-inset-y-[7px] before:content-['']";

export const STRIP_TAP_TARGET_SQUARE = `${STRIP_TAP_TARGET} before:-inset-x-[7px]`;

export const STRIP_SCROLLER =
  "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export interface LabelledStripProps {
  label: string;
  class?: string;
  scrollerClass?: string;
  /** Hide the label visually; it stays in the tree as the nav's accessible name. */
  compact?: boolean;
  children?: RemixNode;
}

export function LabelledStrip(handle: Handle<LabelledStripProps>) {
  const id = `strip-${handle.id}`;
  return () => {
    const { label, compact = false, children } = handle.props;
    return (
      <nav aria-labelledby={id} class={cn("shrink-0 px-4", !compact && "pt-1.5", handle.props.class)}>
        <SectionLabel id={id} placement="above" class={compact ? "sr-only" : "mb-0"}>
          {label}
        </SectionLabel>
        <div
          class={cn(
            "-mx-4 flex items-center gap-2 overflow-x-auto px-4 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            handle.props.scrollerClass,
          )}
        >
          {children}
        </div>
      </nav>
    );
  };
}
