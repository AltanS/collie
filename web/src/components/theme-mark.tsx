import { MARKS, type MarkProps } from "@/components/marks";
import { useActiveTheme } from "@/lib/theme/store";

/**
 * The header mark of the active theme. It renders the registry entry for the theme's `mark` (the dog
 * when the theme names none) and adds no element and no attribute of its own, so a call site's box,
 * its `data-slot` and its tap target stay the call site's.
 */
export function ThemeMark(props: MarkProps) {
  const { mark } = useActiveTheme();
  const Mark = MARKS[mark];
  return <Mark {...props} />;
}
