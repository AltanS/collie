import { AskHeader } from "@/components/ask-screen";
import { HillImageStrip, type HillMediaSource, hillMediaSource } from "@/components/hill-media";
import { MarkdownText } from "@/components/markdown-text";
import { Button } from "@/components/ui/button";
import { BottomBar } from "@/components/ui/bottom-bar";
import { BandMain } from "@/components/ui/strip-host";
import { useLocale } from "@/hooks/use-locale";
import type { AskDecision } from "@/lib/hill/asks";
import type { HillAskFile } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";

// THE CONTEXT PAGE OF AN ASK (Asks build 2, 2026-11-23), `/hill/ask/:id/context`: what is behind the question, one level
// below the ask, so the ask screen stays short. The question, the agent's background in Markdown (`font-content`, the agent's own words),
// its pictures in the row the cards of the board use, and the files it linked. A linked file is a pointer, never a copy:
// "Open" goes to the existing Files preview of the session's pane, and where this device cannot make that request (no
// root, a session that is gone, a machine with no screen) the row says so in words. One bar at the foot goes back.

/** The words after a file's path: its heading or its line, when the agent gave one. */
export function filePlace(file: Pick<HillAskFile, "heading" | "line">): string | null {
  if (file.heading !== undefined && file.heading !== "") return `#${file.heading}`;
  if (file.line !== undefined) return t("asks.contextPage.line", { line: file.line });
  return null;
}

function FileRow({ file, onOpen }: { file: HillAskFile; onOpen: (() => void) | null }) {
  const place = filePlace(file);
  return (
    <li data-slot="ask-file" className="flex min-h-13 items-center gap-3 rounded-md border border-border bg-card px-3.5 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-slot="ask-file-path" className="truncate font-mono text-sm">
          {file.path}
        </span>
        {place !== null && <span className="truncate text-xs text-muted-foreground tabular-nums">{place}</span>}
        {onOpen === null && <span className="text-xs text-muted-foreground">{t("asks.contextPage.cannotOpen")}</span>}
      </span>
      {onOpen !== null && (
        <Button type="button" variant="outline" className="h-11 shrink-0" onClick={onOpen} aria-label={`${t("asks.contextPage.open")} ${file.path}`}>
          {t("asks.contextPage.open")}
        </Button>
      )}
    </li>
  );
}

export function AskContext({
  ask,
  name,
  openFile,
  onBack,
  source = hillMediaSource,
}: {
  ask: Pick<AskDecision, "id" | "title" | "body" | "media" | "ask">;
  /** The session's name. */
  name: string;
  /** What opening one linked file does, or null when this device cannot open it. */
  openFile: (file: HillAskFile) => (() => void) | null;
  onBack: () => void;
  source?: HillMediaSource;
}) {
  useLocale();
  return (
    <div data-slot="ask-context" className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <AskHeader name={t("asks.contextPage.title")} line={name} place={null} backLabel={t("asks.contextPage.backAria")} onBack={onBack} />
      <BandMain base={16} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pt-4 pb-4">
        <h2 data-slot="ask-context-question" className="font-content text-xl font-semibold leading-snug text-balance">
          {ask.title}
        </h2>
        {ask.body.trim() !== "" && (
          <div data-slot="ask-context-body" className="font-content text-[15px] leading-relaxed">
            <MarkdownText text={ask.body} showLinkTargets />
          </div>
        )}
        {ask.media.length > 0 && (
          <section data-slot="ask-context-pictures" className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">{t("asks.contextPage.pictures")}</h2>
            <HillImageStrip decisionId={ask.id} media={ask.media} source={source} />
          </section>
        )}
        {ask.ask.files.length > 0 && (
          <section data-slot="ask-context-files" className="flex flex-col gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">{t("asks.contextPage.files")}</h2>
            <ul className="flex flex-col gap-2">
              {ask.ask.files.map((file, index) => (
                <FileRow key={`${index}:${file.path}`} file={file} onOpen={openFile(file)} />
              ))}
            </ul>
          </section>
        )}
      </BandMain>
      <BottomBar>
        <Button type="button" variant="outline" data-slot="ask-context-back" className="h-11 w-full" onClick={onBack}>
          {t("asks.contextPage.back")}
        </Button>
      </BottomBar>
    </div>
  );
}
