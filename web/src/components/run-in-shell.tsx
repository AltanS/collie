import { useCallback, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { RunLineContext } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import type { StartAsk, StartOutcome } from "@/hooks/use-spaces";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { visibleLine } from "@/lib/no-prompts";
import type { Scope } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import { mintRequestId } from "@/lib/worktree-name";

/** The pane a run starts beside: its folder is the run's, and its space gets the new tab. */
export interface RunBeside {
  paneId: string;
  workspaceId: string;
  cwd: string;
}

interface RunAsk {
  line: string;
  /** Minted when the sheet opens and kept by Try again, so a retry never starts a second shell. */
  requestId: string;
  unknown: boolean;
}

/**
 * Lets a one-line command in the agent's reply run in a new shell tab beside the pane, in the pane's
 * folder, and steps into it, where a password prompt is answered with Type. It always asks first: the
 * line is the agent's words, and a tap runs it in a real shell. The sheet shows it with any hidden
 * character written as its code, as the no-prompts confirm does.
 *
 * The sheet is portalled to <body> for the reason `ImageSheet` gives: the chat body is a transformed
 * ancestor that would otherwise contain its `fixed` layer.
 */
export function RunInShellProvider({
  beside,
  folder,
  scope,
  start,
  children,
}: {
  /** Absent: this pane offers no run (a shell, or a pane not on screen yet). */
  beside: RunBeside | undefined;
  /** The folder as the sheet shows it, home shortened. */
  folder: string;
  scope: Scope | undefined;
  start: (ask: StartAsk, at?: Scope) => Promise<StartOutcome>;
  children: ReactNode;
}) {
  useLocale();
  const [ask, setAsk] = useState<RunAsk | null>(null);
  const [busy, setBusy] = useState(false);
  const offer = useCallback((line: string) => setAsk({ line, requestId: mintRequestId(), unknown: false }), []);
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
        beside: { paneId: beside.paneId, workspaceId: beside.workspaceId },
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
