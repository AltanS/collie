import { ActionRow } from "@/components/action-sheet-rows";
import { Icon } from "@/components/icons/icon";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { paneName } from "@/lib/pane-name";
import { paneRole, type TreeRelatives } from "@/lib/pane-tree";
import { shortcutTarget } from "@/lib/shortcuts/target";
import type { AgentView } from "@/lib/types";

// MOVING THROUGH THE TREE FROM AN OPEN PANE (lib/pane-tree.ts `treeRelatives`): up to the pane that started
// this one, down to the panes it started, and across to its siblings, in the order the tree order draws them.
// Two ways in, one move: the header's tree button opens `TreeNavSheet`, and on a keyboard the four shortcut
// actions `tree_parent`, `tree_first_child`, `tree_previous` and `tree_next` (lib/shortcuts/actions.ts) move at
// once and are rows of Actions. The move itself is the caller's: sideways, like the switcher (ADR 0067).

/** Whether a pane has any relative to move to, which is when the header offers the tree button. */
export function hasRelatives(r: TreeRelatives): boolean {
  return r.parent !== null || r.previous !== null || r.next !== null || r.children.length > 0;
}

/** A row's hint: the role its starter gave the pane, when it has one. */
function role(pane: AgentView): string | undefined {
  return paneRole(pane) ?? undefined;
}

/** The sheet the header's tree button opens: the parent, the siblings either side, and the children. */
export function TreeNavSheet({
  open,
  onClose,
  relatives,
  onMove,
}: {
  open: boolean;
  onClose: () => void;
  relatives: TreeRelatives;
  onMove: (pane: AgentView) => void;
}) {
  useLocale();
  const { parent, previous, next, children } = relatives;
  return (
    <BottomSheet open={open} onClose={onClose} title={t("treeNav.title")}>
      <div className="flex flex-col gap-1 pb-2">
        {parent !== null && (
          <ActionRow
            icon={<Icon name="folder-up" className="size-5 shrink-0 text-muted-foreground" />}
            label={t("treeNav.parent", { name: paneName(parent) })}
            hint={role(parent)}
            target={shortcutTarget("tree_parent")}
            onClick={() => onMove(parent)}
          />
        )}
        {previous !== null && (
          <ActionRow
            icon={<Icon name="space-prev" className="size-5 shrink-0 text-muted-foreground" />}
            label={t("treeNav.previous", { name: paneName(previous) })}
            hint={role(previous)}
            target={shortcutTarget("tree_previous")}
            onClick={() => onMove(previous)}
          />
        )}
        {next !== null && (
          <ActionRow
            icon={<Icon name="space-next" className="size-5 shrink-0 text-muted-foreground" />}
            label={t("treeNav.next", { name: paneName(next) })}
            hint={role(next)}
            target={shortcutTarget("tree_next")}
            onClick={() => onMove(next)}
          />
        )}
        {children.length > 0 && (
          <>
            <p className="px-3 pt-2 text-xs font-medium text-muted-foreground">{t("treeNav.children")}</p>
            {children.map((child, i) => (
              <ActionRow
                key={`${child.host ?? ""}/${child.paneId}`}
                icon={<Icon name="tree-child" className="size-5 shrink-0 text-muted-foreground" />}
                label={paneName(child)}
                hint={role(child)}
                {...(i === 0 ? { target: shortcutTarget("tree_first_child") } : {})}
                onClick={() => onMove(child)}
              />
            ))}
          </>
        )}
      </div>
    </BottomSheet>
  );
}
