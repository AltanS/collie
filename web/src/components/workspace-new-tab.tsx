import { useHostWriteBlock } from "@/components/crew-provider";
import { AddButton } from "@/components/ui/add-button";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { useMuxCapability } from "@/lib/mux-capability";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";

/**
 * The heading "+"'s tap floor: a 28px face, a 44px hit, centred on the circle.
 *
 * The face draws a 1px dashed border, and the `::before` resolves its insets against the padding
 * box, 1px inside the drawn edge (`ui/add-button.tsx` § reach). So `-9px` is 26 + 18 = 44px across
 * and down, and the hit reaches 8px past the circle on every side:
 *
 *  - up, 8px into the 20px gap above the heading (the list's `gap-5`, agent-list.tsx);
 *  - down, 8px into the 8px gap between the heading and its rows (the section's `gap-2`), so the hit
 *    box ends on the first row's top edge and never enters it;
 *  - right, 8px into the 16px page gutter; left, over the heading's own counts, which take no tap.
 *
 * That holds only while the heading row is at least as tall as the face, which is why every strong
 * heading reserves `min-h-7` whether or not its "+" is drawn. Change either gap, the face size or the
 * border, and re-measure: `e2e/heading-new-tab.spec.ts` probes both edges with `elementFromPoint`.
 */
export const HEADING_ADD_REACH = "relative before:absolute before:-inset-[9px] before:content-['']";

interface WorkspaceNewTabProps {
  workspaceId: string;
  /** The workspace's name, for the accessible name: "New tab in moonward". */
  label: string;
  /**
   * The heading's own address, its group's machine and session (`paneScope` of its first pane). The
   * capability is asked of it, and the create and the step into the new pane are sent to it.
   */
  at: Scope;
  /**
   * The machine as the group's rows name it (`AgentView.host`), for the crew's write gate, which the
   * pane sheet asks the same way. Undefined on a solo install, where nothing is refused.
   */
  host: string | undefined;
  /** A create for this workspace, on this machine and session, is in flight. */
  busy: boolean;
  onNewTab: (workspaceId: string, at: Scope) => void;
}

// A NEW TAB FROM THE WORKSPACE'S HEADING (M40/03, issue 290). One per heading, so each heading asks
// its OWN machine whether it can open a tab: a crew member runs its own multiplexer.
//
// HIDDEN when that machine declares no `createTab`, with no note, as on the tab strip: nobody
// arrives at the dashboard needing to know why a multiplexer will not open a tab.
//
// DRAWN, and refusing on the tap, when the write cannot land now. A read-only or unpaired device
// gets the hook's own floating status (hooks/use-spaces.ts); a machine that is not taking writes
// gets its own reason (CREW_PROTOCOL.md §10.3), and nothing is sent. The "+" does not vanish on
// either state, because the workspace is still listed, and a control that comes and goes with a
// state moves what is around it.
export function WorkspaceNewTab({ workspaceId, label, at, host, busy, onNewTab }: WorkspaceNewTabProps) {
  useLocale();
  const createTab = useMuxCapability("createTab", at);
  const hostBlock = useHostWriteBlock(host);
  if (!createTab.capable) return null;
  return (
    <AddButton
      size="sm"
      reach={HEADING_ADD_REACH}
      // 8px from the counts in all: the trailing slot's own 4px gap and this 4px.
      className="ml-1"
      label={t("home.group.newTab", { name: label })}
      busy={busy}
      onClick={() => {
        if (hostBlock !== undefined) {
          setStatus(hostBlock, "error");
          return;
        }
        onNewTab(workspaceId, at);
      }}
    />
  );
}
