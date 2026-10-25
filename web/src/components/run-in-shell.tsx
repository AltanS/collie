import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { RunLineContext } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import type { StartAsk, StartOutcome } from "@/hooks/use-spaces";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { saveDraft } from "@/lib/drafts";
import { t } from "@/lib/i18n";
import { panePath } from "@/lib/nav";
import { visibleLine } from "@/lib/no-prompts";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import { mintRequestId } from "@/lib/worktree-name";

/** The pane a run starts beside: its folder is the run's, and its tab gets the new pane (or its space the new tab). */
export interface RunBeside {
  paneId: string;
  workspaceId: string;
  tabId: string;
  cwd: string;
}

interface RunAsk {
  line: string;
  /** Minted when the sheet opens and kept by Try again, so a retry never starts a second shell. */
  requestId: string;
  unknown: boolean;
}

/**
 * Lets a one-line command in the agent's reply run in a shell in the pane's folder, where a password
 * prompt is answered with Type. Nothing runs on the tap alone: the line is the agent's words.
 *
 * A shell already open in that space and folder is reused: the line goes into its reply box and the
 * tap steps into it, so the operator sees what that shell is doing before Send. Collie cannot tell a
 * shell at its prompt from one running a program, so it never types into one unseen. With no such
 * shell, a sheet asks first, showing the line with any hidden character written as its code as the
 * no-prompts confirm does, and Run starts it in a new pane in the agent's own tab, or in a new tab
 * beside it where the machine cannot split a pane.
 *
 * The sheet is portalled to <body> for the reason `ImageSheet` gives: the chat body is a transformed
 * ancestor that would otherwise contain its `fixed` layer.
 */
export function RunInShellProvider({
  beside,
  reuse,
  folder,
  scope,
  start,
  children,
}: {
  /** Absent: this pane offers no run (a shell, or a pane not on screen yet). */
  beside: RunBeside | undefined;
  /** The pane id of the shell to reuse, when one is open in the same space and folder. */
  reuse: string | undefined;
  /** The folder as the sheet shows it, home shortened. */
  folder: string;
  scope: Scope | undefined;
  start: (ask: StartAsk, at?: Scope) => Promise<StartOutcome>;
  children: ReactNode;
}) {
  useLocale();
  const [ask, setAsk] = useState<RunAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNav();
  const offer = useCallback(
    (line: string) => {
      if (reuse === undefined) return setAsk({ line, requestId: mintRequestId(), unknown: false });
      saveDraft(scope, reuse, line);
      nav.open(panePath(reuse, scope));
    },
    [reuse, scope, nav],
  );
  const close = () => {
    if (!busy) setAsk(null);
  };
  const run = async () => {
    if (ask === null || beside === undefined || busy) return;
    setBusy(true);
    const outcome = await start(
      {
        what: { kind: "run", line: ask.line },
        cwd: beside.cwd,
        requestId: ask.requestId,
        beside: { paneId: beside.paneId, workspaceId: beside.workspaceId, tabId: beside.tabId },
        split: true,
      },
      scope,
    );
    setBusy(false);
    if (outcome.kind === "unknown") return setAsk({ ...ask, unknown: true });
    setAsk(null);
    if (outcome.kind === "refused" && outcome.message !== "") setStatus(outcome.message, "error");
  };
  const line = ask === null ? null : visibleLine(ask.line);
  return (
    <RunLineContext.Provider value={beside === undefined ? null : offer}>
      {children}
      {createPortal(
        <BottomSheet open={ask !== null} onClose={close} title={t("runInShell.title")}>
          {ask !== null && line !== null ? (
            <div className="flex flex-col gap-3">
              <div>
                <SectionLabel placement="above">{t("noPrompts.confirm.command")}</SectionLabel>
                <p
                  data-testid="run-in-shell-command"
                  className="break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs"
                >
                  {line.text}
                </p>
              </div>
              {line.nonAscii ? (
                <Notice tone="caution" variant="box" announce="none">
                  {t("launcherAdd.nonAscii")}
                </Notice>
              ) : null}
              <div>
                <SectionLabel placement="above">{t("newPage.where")}</SectionLabel>
                <p className="break-all font-mono text-xs">{folder}</p>
              </div>
              {ask.unknown ? (
                <Notice tone="caution" variant="box" announce="status">
                  {t("newPage.unknown")}
                </Notice>
              ) : null}
              <div className="flex gap-2 pt-1">
                <Button type="button" variant="outline" className="h-11 flex-1" disabled={busy} onClick={close}>
                  {t("dialog.cancel")}
                </Button>
                <Button type="button" className="h-11 flex-1" disabled={busy} onClick={() => void run()}>
                  {ask.unknown ? t("newPage.retry") : t("runInShell.run")}
                </Button>
              </div>
            </div>
          ) : null}
        </BottomSheet>,
        document.body,
      )}
    </RunLineContext.Provider>
  );
}
