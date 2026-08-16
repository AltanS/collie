import { KeyRound, X } from "lucide-react";

import { Button } from "@/components/ui/button";

interface NoEchoNoticeProps {
  /** The prompt the pane is sitting at, verbatim off the mirror ("[sudo] password for altan:"). Shown
   *  so the claim is checkable against the screen the operator is already looking at — a false
   *  positive is then self-evidently one, and the ✕ costs a tap. */
  prompt: string;
  /** Whether the refused send had already put the text into the pane (a `stalled` outcome) or not
   *  (`blocked`, where the pre-flight refused before typing). It changes the operator's next move
   *  completely — press Enter, versus type the secret — so it changes what this says. */
  typed: boolean;
  /** Hand off to direct typing: clears the draft (and its stored copy) and arms "Type". Absent while
   *  the mode can't be armed at all — a gone pane, a read-only device, the idle pause. */
  onUseType: (() => void) | null;
  onDismiss: () => void;
}

// The one thing #103 was missing: a sentence, at the moment of the refusal, that names the screen and
// points at the control that works.
//
// A password prompt is the single case where the reply guard's evidence can never arrive — `sudo`,
// `ssh` and `gpg` turn echo off, so the characters land in the pane and the terminal deliberately
// shows nothing to read back (lib/no-echo.ts). Send is right to withhold the submit key, and it will
// be right on every retry, so an operator who does not know WHY is left tapping Send at a screen that
// can never change. The reporter of #103 gave up and walked to a laptop for three days.
//
// It is a NOTICE, not a replacement for the override. The Send slot keeps offering "Type anyway?"
// exactly as before, so a false positive costs a dismissable strip rather than an action; this sits
// where the terminal-draft preview sits and says the part the status line has no room for.
//
// WHY THE HANDOFF CLEARS THE DRAFT. The composer write-through persists every keystroke to
// localStorage (lib/drafts.ts, 48h), so by the time this appears the secret is already stored — and
// `useDirectTyping` refuses to arm at all while a draft is present, which means the failed attempt
// blocks the remedy. Clearing on the way through fixes both: it is the one path where the draft is
// known to be a secret, and dropping it is what the operator wanted anyway.
export function NoEchoNotice({ prompt, typed, onUseType, onDismiss }: NoEchoNoticeProps) {
  return (
    <div className="mb-2 flex items-start gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
      <KeyRound className="mt-0.5 size-3 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Password prompt — nothing echoes</div>
        <div className="mt-0.5 truncate font-mono text-[11px] leading-snug text-muted-foreground/90">
          {prompt}
        </div>
        {/* Four sentences, because the operator's next move differs on both axes. `typed` says whether
            the secret is already in the pane (press Enter — and do NOT re-send, which would type a
            second copy) or not (type it in the mode that works). `onUseType === null` means the mode
            can't be armed at all right now, so naming it would be advice for a control that isn't
            there; say what's in the way instead. */}
        <div className="mt-1 leading-snug">
          {onUseType === null
            ? typed
              ? "What you typed is already in the pane, unsubmitted — but this view isn't live, so nothing can be sent from here. Answer it at the terminal."
              : "Nothing was typed. This view isn't live, so the keys that would work can't be sent from here."
            : typed
              ? "What you typed is already in the pane — it just can't be confirmed, so it wasn't submitted. Press Enter in Type, and don't send it again."
              : "Send confirms what it typed, and this prompt shows nothing to confirm. Type sends your keys straight through, Enter included."}
        </div>
      </div>
      {onUseType !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 self-center px-2 text-xs font-medium"
          onClick={onUseType}
        >
          Use Type
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 self-start text-muted-foreground"
        aria-label="Dismiss password-prompt notice"
        onClick={onDismiss}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}
