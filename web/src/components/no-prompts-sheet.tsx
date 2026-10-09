import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionLabel } from "@/components/ui/section-label";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { visibleLine } from "@/lib/no-prompts";

/** What the confirm shows about the start it stands in front of. */
export interface NoPromptsAsk {
  /** The line the row types. Hidden characters in it are written as their codes. */
  command: string;
  /** The folder, as the page shows it. */
  folder: string;
  /** The machine's name, when it has one. */
  machine?: string;
}

/**
 * "Start without prompts?": the one question asked before a device first starts a launcher that
 * skips permission prompts (ADR 0094). It shows what will run, where, and on which machine, and says
 * once that the agent will not ask. Cancel does nothing; Start remembers the answer for this device,
 * this machine and this line (lib/no-prompts.ts) and goes on. It owns no state: the guard hook
 * (hooks/use-no-prompts-guard.tsx) decides when to open it and what Start does.
 */
export function NoPromptsSheet({
  ask,
  onStart,
  onCancel,
}: {
  /** The start waiting for an answer, or `null` while the sheet is closed. */
  ask: NoPromptsAsk | null;
  onStart: () => void;
  onCancel: () => void;
}) {
  useLocale();
  // Kept while the sheet closes, so the words do not blank out during the slide.
  const line = ask === null ? null : visibleLine(ask.command);
  return (
    <BottomSheet open={ask !== null} onClose={onCancel} title={t("noPrompts.confirm.title")}>
      {ask !== null && line !== null ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("noPrompts.confirm.body")}</p>
          <div>
            <SectionLabel placement="above">{t("noPrompts.confirm.command")}</SectionLabel>
            <p
              data-testid="no-prompts-command"
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
            <p className="break-all font-mono text-xs">{ask.folder}</p>
          </div>
          {ask.machine !== undefined ? (
            <div>
              <SectionLabel placement="above">{t("noPrompts.confirm.machine")}</SectionLabel>
              <p className="text-sm">{ask.machine}</p>
            </div>
          ) : null}
          <div className="flex gap-2 pt-1">
            <Button type="button" variant="outline" className="h-11 flex-1" onClick={onCancel}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" className="h-11 flex-1" onClick={onStart}>
              {t("newPage.start")}
            </Button>
          </div>
        </div>
      ) : null}
    </BottomSheet>
  );
}
