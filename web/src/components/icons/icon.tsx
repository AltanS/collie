import { Icon as DrawGlyph } from "lucide-react";
import type { Ref, SVGProps } from "react";

import type { GlyphSetId } from "@/lib/glyph-sets";
import { useGlyphSetId } from "@/lib/glyphs";

import { useGlyphSetData } from "./glyphs";
import type { IconKey } from "./keys";
import { LUCIDE } from "./lucide";

// THE ONE ICON COMPONENT. Every glyph the app draws is `<Icon name="<key>" />`, named by what it means
// (`keys.ts`), never by its shape. A table that used to hold a lucide component holds a key.
//
// THE RENDERED CONTRACT, which tests and stylesheets may rely on and nothing else:
//   - one direct `<svg>`, so `[&>svg]` and `has-[>svg]` selectors keep working;
//   - the class `icon`, where index.css hangs the stroke width (`svg.icon`);
//   - `data-icon="<key>"`, which is how a test finds a glyph (never a `lucide-*` class);
//   - `data-glyphs="<set>"` when a set other than lucide draws it;
//   - the size, colour, rotation and animation come from the caller's classes, and `aria-*` passes
//     through, with `aria-hidden` added when no label is given (lucide's own rule).
//
// WHICH SET (ADR 0137). The worn theme's `glyphs` (`lib/glyphs.ts`, a tried theme first), or the
// `set` prop where a caller must show one set whatever is worn (the theme preview). Lucide draws while
// a set's chunk loads, when it cannot load, and for a key the family has no glyph for. Every set is
// drawn by lucide-react's own `Icon`, so the 24px default box and the attribute rules never differ.

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name" | "children" | "ref"> {
  /** What the glyph means. An unknown key does not compile. */
  name: IconKey;
  /** Draw this set whatever the worn theme says. Absent follows the theme. */
  set?: GlyphSetId;
  ref?: Ref<SVGSVGElement>;
}

export function Icon({ name, set, className, ...rest }: IconProps) {
  const worn = useGlyphSetId();
  const data = useGlyphSetData(set ?? worn);
  const classes = className === undefined ? "icon" : `icon ${className}`;
  const node = data?.glyphs[name];
  if (data === null || node === undefined) {
    const Glyph = LUCIDE[name];
    return <Glyph {...rest} className={classes} data-icon={name} />;
  }
  return <DrawGlyph iconNode={node} {...data.root} {...rest} className={classes} data-icon={name} data-glyphs={data.id} />;
}
