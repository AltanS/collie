import { useEffect, useState } from "react";
import { Bot, ChevronLeft, FolderPlus, GitBranchPlus } from "lucide-react";

import { ActionRow } from "@/components/action-sheet-rows";
import { useHostWriteBlock } from "@/components/crew-provider";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { Launcher } from "@/lib/types";

interface NewSheetProps {
  open: boolean;
  onClose: () => void;
  /** This scope's launcher rows (`useLaunchers`). No rows, no "Agent" row. */
  launchers: readonly Launcher[];
  /** The dashboard's machine and session: a crew member that refuses writes refuses a launch. */
  scope: Scope;
  /** Whether this multiplexer can open a space, the condition the Spaces header's FolderPlus uses. */
  canSpace: boolean;
  /** Whether "New agent on a branch" has a repo to branch from, the condition its sheet tab uses. */
  canBranch: boolean;
  /** Run a launcher row, the same call the Launch strip makes. The sheet is already closed. */
  onLaunch: (command: string) => void;
  /** Open the new-space sheet on its plain side. The sheet is already closed. */
  onSpace: () => void;
  /** Open the new-space sheet on its Worktree side. The sheet is already closed. */
  onBranch: () => void;
}

// THE DASHBOARD'S ONE CREATE MENU (DESIGN.md §1, card 1.3, 2026-10-08), opened by the floating New
// button. Three rows, each a door to a flow that already exists: Agent runs a launcher, Space opens
// the new-space sheet, Agent on a branch opens it on its Worktree side. A row whose flow cannot work
// here is HIDDEN, as the Spaces header's FolderPlus and the sheet's Worktree tab hide themselves, and
// the button hides when all three are. The sheet owns no create of its own, so every refusal (read
// only, not paired, a saved copy, a busy create) is the caller's, from `useSpaceActions`.
//
// "Agent" is a second level in the same sheet rather than a second sheet: a Back row returns to the
// three rows. Close-then-act on every leaf, so the flow a row leads to arrives alone, the way the
// pane sheet's rows do.
export function NewSheet({ open, onClose, launchers, scope, canSpace, canBranch, onLaunch, onSpace, onBranch }: NewSheetProps) {
  useLocale();
  const [view, setView] = useState<"root" | "agent">("root");
  const hostBlock = useHostWriteBlock(scope.host);

  // Every opening starts at the three rows, whatever level the last one closed on.
  useEffect(() => {
    if (open) setView("root");
  }, [open]);

  const icon = "size-4 shrink-0 text-muted-foreground";

  return (
    <BottomSheet open={open} onClose={onClose} title={view === "agent" ? t("home.new.agent") : t("home.new.label")}>
      {view === "root" ? (
        <div className="flex flex-col gap-1">
          {launchers.length > 0 && (
            <ActionRow icon={<Bot className={icon} />} label={t("home.new.agent")} onClick={() => setView("agent")} />
          )}
          {canSpace && (
            <ActionRow
              icon={<FolderPlus className={icon} />}
              label={t("home.new.space")}
              onClick={() => {
                onClose();
                onSpace();
              }}
            />
          )}
          {canBranch && (
            <ActionRow
              icon={<GitBranchPlus className={icon} />}
              label={t("home.new.branch")}
              onClick={() => {
                onClose();
                onBranch();
              }}
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setView("root")}
            className="flex min-h-11 items-center gap-1 self-start rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors active:bg-muted"
          >
            <ChevronLeft className="size-3.5" />
            {t("actionSheet.back")}
          </button>
          {launchers.map((launcher) => (
            <ActionRow
              key={launcher.command}
              icon={<Bot className={icon} />}
              label={launcher.label}
              // The command is operator-authored text going into a text node, never markup.
              hint={launcher.command}
              onClick={() => {
                onClose();
                // A crew member that refuses writes says why, and nothing is sent (CREW_PROTOCOL.md
                // §10.3). Said after the close, so the floating status is not under the sheet.
                if (hostBlock !== undefined) {
                  setStatus(hostBlock, "error");
                  return;
                }
                onLaunch(launcher.command);
              }}
            />
          ))}
        </div>
      )}
    </BottomSheet>
  );
}
