import { Icon } from "@/components/icons/icon";
import { TREE_DEPTH_MAX } from "@/lib/pane-tree";
import { cn } from "@/lib/utils";

/**
 * The indent of a child row, one step per level up to {@link TREE_DEPTH_MAX}. Fixed classes, because
 * Tailwind builds only the class names it can see in the source.
 */
const WIDTH = ["", "w-4", "w-8", "w-12", "w-16"] as const;

/**
 * THE INDENT OF A ROW IN THE TREE ORDER (lib/pane-tree.ts): a child row is pushed right by its depth
 * and its indent ends in the branch mark, so the eye follows a starter down to the panes it started.
 * Nothing at depth 0. Decorative: the order and the role word say the same to a screen reader.
 */
export function TreeIndent({ depth, className }: { depth: number; className?: string }) {
  if (depth <= 0) return null;
  return (
    <span
      aria-hidden
      data-slot="tree-indent"
      className={cn("flex shrink-0 items-center justify-end", WIDTH[Math.min(depth, TREE_DEPTH_MAX)], className)}
    >
      <Icon name="tree-child" className="size-3.5 text-muted-foreground" />
    </span>
  );
}
