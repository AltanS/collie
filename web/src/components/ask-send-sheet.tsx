import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";
import type { AsksSendState } from "@/hooks/use-asks-send";
import { useLocale } from "@/hooks/use-locale";
import type { AsksReview } from "@/lib/hill/asks";
import type { SessionClock } from "@/lib/hill/asks-board";
import { t } from "@/lib/i18n";

// THE SEND SHEET (Asks build 2, 2026-11-23): what goes to the agent, before it goes. One Send is one request for one
// session (`POST /api/hill/answers`), and partial sends are allowed: the answers that wait go, the asks without one
// stay open, and the message says so for each of them (lib/hill/answers-message.ts, the very text the bridge types).
// The sheet shows that text, how long it is, and what the session's cache means for the cost of this turn. A cold
// session is the one caution: the send starts a turn at full price. Notices that come and go (a refusal, a send that
// did not reach the bridge) arrive through `Collapse`, above the buttons, so the buttons never move under a thumb.

/** The sentence and tone for what the session's cache means to this send, or null when the clock says nothing. */
function clockNotice(clock: SessionClock): { tone: NoticeTone; words: string } | null {
  switch (clock.kind) {
    case "warm":
      return { tone: "neutral", words: t("asks.sendSheet.warm") };
    case "working":
      return { tone: "neutral", words: t("asks.sendSheet.working") };
    case "cold":
      return { tone: "caution", words: t("asks.sendSheet.cold") };
    case "unknown":
      return null;
  }
}

export function AskSendSheet({
  open,
  onClose,
  name,
  review,
  clock,
  state,
  onSend,
}: {
  open: boolean;
  onClose: () => void;
  /** The session's name. */
  name: string;
  review: AsksReview;
  clock: SessionClock;
  state: AsksSendState;
  onSend: () => void;
}) {
  useLocale();
  const notice = clockNotice(clock);
  const sending = state.phase === "sending";
  const problem = state.phase === "refused" ? state.words : state.phase === "failed" ? t("asks.sendSheet.failed") : review.tooLong ? t("asks.send.tooLong", { over: review.over }) : null;
  return (
    <BottomSheet open={open} onClose={onClose} title={t("asks.sendSheet.title", { name })}>
      <div data-slot="ask-send" className="flex flex-col gap-3">
        {notice !== null && (
          <Notice tone={notice.tone} variant="box">
            {notice.words}
          </Notice>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">{t("asks.sendSheet.message")}</span>
          <pre data-slot="ask-send-message" className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground">
            {review.message}
          </pre>
          <span data-slot="ask-send-count" className="text-xs text-muted-foreground tabular-nums">
            {t("asks.sendSheet.chars", { length: review.length.toLocaleString("en-US"), max: review.max.toLocaleString("en-US") })}
          </span>
        </div>
        <Collapse open={problem !== null}>
          {problem !== null && (
            <Notice tone="caution" variant="box" announce="alert" className="mb-0.5">
              {problem}
            </Notice>
          )}
        </Collapse>
        <div className="flex flex-col gap-2">
          <Button type="button" data-slot="ask-send-go" className="h-11 w-full" disabled={!review.canSend || sending} onClick={onSend}>
            {sending ? t("asks.sendSheet.sending") : t("asks.sendSheet.send", { count: review.count })}
          </Button>
          <Button type="button" variant="outline" data-slot="ask-send-hold" className="h-11 w-full" onClick={onClose}>
            {t("asks.sendSheet.hold")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
