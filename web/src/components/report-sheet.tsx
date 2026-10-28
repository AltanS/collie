// The Report a problem sheet (ADR 0123). One sheet, four doors: the card after failed sends, the pane
// menu's "Report a problem", Settings, System, and the unread-dialog card (amendment 2026-10-28). It
// shows every word the issue will hold before anything leaves, and it leaves only by the person's
// taps: Open on GitHub (a plain link into their own browser and their own GitHub login, where GitHub's
// form is the last check) or Copy report. Collie holds no GitHub token, the phone never calls GitHub,
// and the sheet stores nothing.
//
// Top to bottom: one optional line, two switches that are off each time the sheet opens ("Include what
// I typed", shown only when a listed send kept a line; "Include the screen", shown only when the pane
// has a screen), the preview, a note on what the link left out to fit, the public warning, then the
// buttons. The preview is the exact text the link carries (`fitLink`); Copy report copies the whole
// report, nothing cut.
//
// From the unread-dialog card, "Include the screen" starts ON: a reader bug needs the screen, and the
// preview shows the masked rows before anything leaves, so the person still reads them and can switch
// them off. That door also adds the phone's own facts (`readClientFacts`) to the setup block.

import { ExternalLink, Search } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { BottomSheet, TALL_SHEET_CLEARANCE } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { getReportContext, getSendReceipts } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { BUILD } from "@/lib/build";
import { canCopyText, copyText } from "@/lib/clipboard";
import { t, tn } from "@/lib/i18n";
import { probeStandalone } from "@/lib/nav-entry";
import { fitLink, hasTyped, reportFields, reportText, searchLink, type ClientFacts, type ReportContext, type ReportInput } from "@/lib/report/body";
import { closeReport, readEpisodes, useReportTarget, type DialogTrouble, type Episode, type ReportTarget } from "@/lib/report/store";
import { getServerBuild } from "@/lib/server-build";
import { setStatus } from "@/lib/status";
import type { SendReceiptRow } from "@/lib/surface/send";
import { cn } from "@/lib/utils";

/** The one mounted sheet, opened through `openReport` (lib/report/store.ts). */
export function ReportSheetHost() {
  const target = useReportTarget();
  return <ReportSheet target={target} onClose={closeReport} />;
}

/** The sends a report lists: the streak's own when the card named them and the bridge still has them, else the pane's recent ones. */
export function reportedSends(rows: readonly SendReceiptRow[], requestIds: readonly string[] | undefined): SendReceiptRow[] {
  if (requestIds === undefined || requestIds.length === 0) return [...rows];
  const named = rows.filter((row) => requestIds.includes(row.requestId));
  return named.length > 0 ? named : [...rows];
}

/** What the phone knows about itself, for a report from the unread-dialog card. Read once per open. */
export function readClientFacts(): ClientFacts {
  return {
    appBuild: BUILD.id,
    serverBuild: getServerBuild() ?? null,
    userAgent: navigator.userAgent,
    viewport: `${String(window.innerWidth)}x${String(window.innerHeight)}`,
    standalone: probeStandalone(),
  };
}

/** Loads what the sheet needs for a target, then draws the view. */
export function ReportSheet({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const [context, setContext] = useState<ReportContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [rows, setRows] = useState<readonly SendReceiptRow[] | null>(null);
  const [episodes, setEpisodes] = useState<readonly Episode[]>([]);
  const paneId = target?.paneId;
  const scope = target?.scope;

  useEffect(() => {
    if (target === null) return;
    let live = true;
    setContext(null);
    setContextError(null);
    setRows(null);
    setEpisodes(target.paneId === undefined ? readEpisodes() : []);
    void (async () => {
      try {
        const got = await getReportContext(target.paneId ?? null, false, target.scope);
        if (live) setContext(got);
      } catch (error) {
        if (live) setContextError(describeThrownError(error));
      }
    })();
    void (async () => {
      if (target.paneId === undefined) {
        if (live) setRows([]);
        return;
      }
      try {
        const got = await getSendReceipts(target.paneId, target.scope);
        if (live) setRows(reportedSends(got, target.requestIds));
      } catch {
        // No list from this bridge (an older build, the protocol off): the report names the setup only.
        if (live) setRows([]);
      }
    })();
    return () => {
      live = false;
    };
  }, [target]);

  const loadScreen = async (): Promise<string> => {
    if (paneId === undefined) return "";
    const got = await getReportContext(paneId, true, scope);
    return got.screen ?? "";
  };

  return (
    <BottomSheet open={target !== null} onClose={onClose} title={t("report.sheet.title")} className={TALL_SHEET_CLEARANCE}>
      {target !== null && (
        <ReportSheetView
          // A new target starts a new report: the line and both switches go back to how they start.
          key={`${target.kind ?? "send"}|${target.paneId ?? ""}|${(target.requestIds ?? []).join(",")}`}
          context={context}
          contextError={contextError}
          rows={rows}
          episodes={episodes}
          fromSettings={target.paneId === undefined}
          loadScreen={loadScreen}
          dialog={target.kind === "unread-dialog" ? target.dialog : undefined}
        />
      )}
    </BottomSheet>
  );
}

interface ReportSheetViewProps {
  context: ReportContext | null;
  contextError: string | null;
  /** The sends to list, newest first; null while they load. */
  rows: readonly SendReceiptRow[] | null;
  episodes: readonly Episode[];
  fromSettings: boolean;
  /** The pane's masked screen, read when "Include the screen" turns on. */
  loadScreen: () => Promise<string>;
  /** From the unread-dialog card: what its reader said. The screen switch then starts on. */
  dialog?: DialogTrouble | undefined;
}

const SWITCH_ROW = "flex items-center justify-between gap-4 py-1";

/** The sheet's body with every input handed in, so a test or a playground card needs no fetch. */
export function ReportSheetView({ context, contextError, rows, episodes, fromSettings, loadScreen, dialog }: ReportSheetViewProps) {
  useLocale();
  const [note, setNote] = useState("");
  const [includeTyped, setIncludeTyped] = useState(false);
  const [includeScreen, setIncludeScreen] = useState(dialog !== undefined);
  // Read once per open: the facts of the moment the person tapped Report a problem.
  const [client] = useState(() => (dialog === undefined ? undefined : readClientFacts()));
  const [screen, setScreen] = useState<string | null>(null);
  const [screenState, setScreenState] = useState<"idle" | "loading" | "failed">("idle");
  const [screenError, setScreenError] = useState("");

  const sends = rows ?? [];
  const input: ReportInput = {
    context,
    sends,
    episodes,
    note,
    includeTyped: includeTyped && hasTyped(sends),
    screen: includeScreen ? screen : null,
    app: BUILD.version,
    dialog,
    client,
  };
  // Cheap enough per render: ten sends and forty rows at most.
  const full = reportFields(input);
  const link = fitLink(full);
  const preview = reportText(link.fields);

  async function turnScreen(on: boolean): Promise<void> {
    setIncludeScreen(on);
    if (!on || screen !== null) return;
    setScreenState("loading");
    try {
      setScreen(await loadScreen());
      setScreenState("idle");
    } catch (error) {
      setScreenError(describeThrownError(error));
      setScreenState("failed");
      setIncludeScreen(false);
    }
  }

  // From the unread-dialog card the switch starts on, so the screen loads as soon as the bridge says
  // the pane has one. Runs once: a later tap on the switch goes through `turnScreen` itself.
  const screenable = context?.screenable === true;
  const startsOn = dialog !== undefined;
  useEffect(() => {
    if (startsOn && screenable) void turnScreen(true);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [startsOn, screenable]);

  async function copyReport(): Promise<void> {
    try {
      await copyText(reportText(full));
      setStatus(t("report.sheet.copied"), "success");
    } catch {
      setStatus(t("copyable.failed"), "error");
    }
  }

  return (
    <div data-slot="report-sheet" className="flex flex-col gap-3">
      {fromSettings && <p className="text-xs leading-snug text-muted-foreground">{t("report.sheet.fromSettings")}</p>}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{t("report.sheet.note")}</span>
        <input
          data-slot="report-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t("report.sheet.notePlaceholder")}
          maxLength={300}
          className="h-11 rounded-lg border border-border bg-background px-3 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>

      {hasTyped(sends) && (
        <div className={SWITCH_ROW}>
          <div className="min-w-0">
            <div id="report-typed" className="text-sm font-medium">{t("report.sheet.typed")}</div>
            <p className="text-xs leading-snug text-muted-foreground">{t("report.sheet.typedHint")}</p>
          </div>
          <Switch checked={includeTyped} onCheckedChange={setIncludeTyped} aria-labelledby="report-typed" />
        </div>
      )}
      {context?.screenable === true && (
        <div className={SWITCH_ROW}>
          <div className="min-w-0">
            <div id="report-screen" className="text-sm font-medium">{t("report.sheet.screen")}</div>
            {/* One line slot whose words change with the state, never a line that comes and goes. */}
            <p data-slot="report-screen-hint" className="text-xs leading-snug text-muted-foreground">
              {screenState === "loading"
                ? t("report.sheet.screenLoading")
                : screenState === "failed"
                  ? t("report.sheet.failed", { error: screenError })
                  : t("report.sheet.screenHint")}
            </p>
          </div>
          <Switch checked={includeScreen} onCheckedChange={(on) => void turnScreen(on)} disabled={screenState === "loading"} aria-labelledby="report-screen" />
        </div>
      )}

      <section className="flex flex-col gap-1" aria-label={t("report.sheet.preview")}>
        <span className="text-xs font-medium text-muted-foreground">{t("report.sheet.preview")}</span>
        {rows === null && <p className="text-xs text-muted-foreground">{t("report.sheet.loading")}</p>}
        {contextError !== null && <p className="text-xs text-muted-foreground">{t("report.sheet.failed", { error: contextError })}</p>}
        <pre
          data-slot="report-preview"
          className="max-h-[40dvh] overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/40 p-2 font-mono text-[11px] leading-snug"
        >
          {preview}
        </pre>
        {link.cut.screen !== "none" && <p data-slot="report-cut" className="text-xs text-muted-foreground">{t("report.sheet.cutScreen")}</p>}
        {link.cut.sends > 0 && <p data-slot="report-cut" className="text-xs text-muted-foreground">{tn("report.sheet.cutSends", link.cut.sends)}</p>}
        {link.cut.note && <p data-slot="report-cut" className="text-xs text-muted-foreground">{t("report.sheet.cutNote")}</p>}
      </section>

      <Notice tone="caution" variant="box">
        {t("report.sheet.public")}
      </Notice>

      <div className="flex flex-col gap-2">
        <a
          data-slot="report-open"
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: "default" }), "h-11")}
        >
          <ExternalLink className="size-4" />
          {t("report.sheet.open")}
        </a>
        {canCopyText() && (
          <Button type="button" variant="outline" className="h-11" data-slot="report-copy" onClick={() => void copyReport()}>
            {t("report.sheet.copy")}
          </Button>
        )}
        <a
          data-slot="report-search"
          href={searchLink(input)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center justify-center gap-1.5 text-xs text-muted-foreground underline underline-offset-2"
        >
          <Search className="size-3.5" />
          {t("report.sheet.search")}
        </a>
      </div>
    </div>
  );
}
