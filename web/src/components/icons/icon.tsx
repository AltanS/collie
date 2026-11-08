import type { Ref, SVGProps } from "react";

import type { IconKey } from "./keys";
import { LUCIDE } from "./lucide";

// THE ONE ICON COMPONENT. Every glyph the app draws is `<Icon name="<key>" />`, named by what it means
// (`keys.ts`), never by its shape. A table that used to hold a lucide component holds a key.
//
// THE RENDERED CONTRACT, which tests and stylesheets may rely on and nothing else:
//   - one direct `<svg>`, so `[&>svg]` and `has-[>svg]` selectors keep working;
//   - the class `icon`, where index.css hangs the stroke width (`svg.icon`);
//   - `data-icon="<key>"`, which is how a test finds a glyph (never a `lucide-*` class);
//   - the size, colour, rotation and animation come from the caller's classes, and `aria-*` passes
//     through, with `aria-hidden` added when no label is given (lucide's own rule).

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "children" | "ref"> {
  /** What the glyph means. An unknown key does not compile. */
  name: IconKey;
  ref?: Ref<SVGSVGElement>;
}

export function Icon({ name, className, ...rest }: IconProps) {
  const Glyph = LUCIDE[name];
  return <Glyph {...rest} className={className === undefined ? "icon" : `icon ${className}`} data-icon={name} />;
}
