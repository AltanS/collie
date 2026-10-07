// Lucide icons without React: the `lucide` package ships each icon as plain SVG data (an IconNode,
// a list of [tag, attributes]). This draws one with lucide's own defaults, so an icon here is the
// same drawing, stroke and box as `lucide-react` draws it in web/. The defaults are one CSS rule on
// `svg.lucide` (app.css), not attributes on every icon: a server document carries some 30 icons, and
// the nine attributes were 165 bytes each (S3).
import { createElement, type Handle } from "remix/component";
import type { IconNode } from "lucide";

import { cn } from "@web/lib/utils";

export interface IconProps {
  icon: IconNode;
  class?: string;
  /** Icons are decoration unless a caller names one; then it is an image with that name. */
  label?: string;
  strokeWidth?: number;
}

export function Icon(handle: Handle<IconProps>) {
  return () => {
    const { icon, label, strokeWidth = 2 } = handle.props;
    const parts = icon.map(([tag, attrs]) => {
      const { key: _key, ...rest } = attrs;
      return createElement(tag, rest);
    });
    return (
      <svg
        viewBox="0 0 24 24"
        style={strokeWidth === 2 ? undefined : { strokeWidth }}
        role={label === undefined ? undefined : "img"}
        aria-label={label}
        aria-hidden={label === undefined ? "true" : undefined}
        class={cn("lucide", handle.props.class)}
      >
        {parts}
      </svg>
    );
  };
}
