// Port of web/src/components/ui/one-of.tsx: one box, several alternatives, exactly one shown, and
// the box is as big as the BIGGEST of them, always (DESIGN.md §2). Every alternative is rendered in
// ONE grid cell and the losers are held at opacity 0, so the layout engine sizes the cell from the
// real glyphs of the active locale and a change of `active` is a repaint, never a resize.
//
// A loser is `inert` and `aria-hidden`: it may hold a focusable control, and leaving the tree without
// leaving the tab order is the worse bug. Every layer is `min-w-0` so a caller's `truncate` inside
// truncates against the space the box really has (web/'s file header says why at length).
import type { Handle, RemixNode } from "remix/component";

import { cn } from "@web/lib/utils";

export interface OneOfOption {
  key: string;
  node: RemixNode;
}

export interface OneOfProps {
  /** Which option is on top; `null` shows none, and the box keeps its reserved size. */
  active: string | null;
  /** Every alternative this slot can ever show. Keys are the `active` vocabulary. */
  options: readonly OneOfOption[];
  /** The box: give it its display, alignment and flex behaviour. */
  class?: string;
  /** On EVERY layer, winner and loser alike: a transition belongs here. */
  layerClass?: string;
}

export function OneOf(handle: Handle<OneOfProps>) {
  return () => {
    const { active, options, layerClass } = handle.props;
    return (
      <div class={cn("grid", handle.props.class)}>
        {options.map((option) => {
          const front = option.key === active;
          return (
            <div
              key={option.key}
              data-active={front ? "" : undefined}
              inert={!front}
              aria-hidden={front ? undefined : "true"}
              class={cn("min-w-0 [grid-area:1/1]", layerClass, front ? "opacity-100" : "pointer-events-none opacity-0")}
            >
              {option.node}
            </div>
          );
        })}
      </div>
    );
  };
}
