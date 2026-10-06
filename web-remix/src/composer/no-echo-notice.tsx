// A port of web/src/components/no-echo-notice.tsx: the sentence, at the moment of a refused send, that
// names the screen and points at the control that works.
//
// A password prompt is the one case where the reply guard's evidence can never arrive: `sudo`, `ssh`
// and `gpg` turn echo off, so the characters land in the pane and the terminal deliberately shows
// nothing to read back. Send is right to withhold the submit key and will be right on every retry, so
// an operator who does not know WHY is left tapping Send at a screen that can never change (#103).
//
// It is a NOTICE, not a replacement for the override: Send keeps offering "Type anyway?", so a false
// positive costs a dismissable strip. The caller wraps it in a `Collapse` and mounts it where the
// terminal-draft preview sits.
//
// WHY THE HANDOFF CLEARS THE DRAFT (the caller's `onUseType`). The composer writes every keystroke
// through to storage, so by the time this appears the secret is already stored, and direct typing
// refuses to arm while a draft is present. Clearing on the way through fixes both.
//
// `onUseType === null` means the mode cannot be armed right now (a gone pane, a read-only device, the
// idle pause); the button leaves (absent, not greyed) and the sentence says what is in the way. It sits
// inside a notice that already moves as one block, so the swap is not a separate in-flow change.
import { on, type Handle } from "remix/component";
import { KeyRound, X } from "lucide";

import { t } from "@web/lib/i18n";

import { useLocale } from "../lib/i18n-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";

export interface NoEchoNoticeProps {
  /**
   * The prompt the pane is sitting at, verbatim off the mirror ("[sudo] password for altan:"). Shown
   * so the claim is checkable against the screen the operator is already looking at: a false positive
   * is then self-evidently one, and the x costs a tap.
   */
  prompt: string;
  /**
   * Whether the refused send had already put the text into the pane (a `stalled` outcome) or not
   * (`blocked`, where the pre-flight refused before typing). It changes the operator's next move
   * completely (press Enter, versus type the secret), so it changes what this says.
   */
  typed: boolean;
  /** Hand off to direct typing. Null while the mode cannot be armed. Read at tap time. */
  onUseType: (() => void) | null;
  /** Read at tap time. */
  onDismiss: () => void;
}

export function NoEchoNotice(handle: Handle<NoEchoNoticeProps>) {
  useLocale(handle);
  return () => {
    const { prompt, typed, onUseType } = handle.props;
    // Four sentences, because the next move differs on both axes: `typed` says whether the secret is
    // already in the pane (press Enter, and do NOT re-send, which would type a second copy) or not;
    // `onUseType` says whether naming the typing mode would be advice for a control that isn't there.
    const advice =
      onUseType === null
        ? typed
          ? t("composer.noEcho.noLiveTyped")
          : t("composer.noEcho.noLiveUntyped")
        : typed
          ? t("composer.noEcho.liveTyped")
          : t("composer.noEcho.liveUntyped");
    return (
      <div
        data-testid="no-echo-notice"
        class="mb-2 flex items-start gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
      >
        <Icon icon={KeyRound} class="mt-0.5 size-3 shrink-0" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">{t("composer.noEcho.title")}</div>
          <div class="mt-0.5 truncate font-mono text-[11px] leading-snug text-muted-foreground/90">{prompt}</div>
          <div class="mt-1 leading-snug">{advice}</div>
        </div>
        {onUseType !== null ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="no-echo-use-type"
            class="h-6 shrink-0 self-center px-2 text-xs font-medium"
            mix={on("click", () => handle.props.onUseType?.())}
          >
            {t("composer.noEcho.useType")}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          data-testid="no-echo-dismiss"
          class="size-6 shrink-0 self-start text-muted-foreground"
          aria-label={t("composer.noEcho.dismissAria")}
          mix={on("click", () => handle.props.onDismiss())}
        >
          <Icon icon={X} class="size-3" />
        </Button>
      </div>
    );
  };
}
