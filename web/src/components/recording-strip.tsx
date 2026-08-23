import { Loader2, Mic } from "lucide-react";

// The armed indicator for a voice recording, in the same in-flow slot as the "You sent:" and
// direct-typing strips — for the same reason the latter exists (components/direct-typing-strip.tsx):
// a live microphone is state you can leave the phone holding, and the only thing in the field of
// view that says so must be words, not a tinted icon.
//
// It carries the two controls that decision needs, and they are DIFFERENT actions: Stop ends the
// clip and transcribes it, ✕ throws it away and uploads nothing. Never one button — "stop" and
// "cancel" are the pair every recorder gets wrong, and here one of them spends the operator's audio
// on a provider.
export function RecordingStrip({
  elapsed,
  transcribing,
  handsFree,
  onStop,
  onDiscard,
}: {
  /** `m:ss` since the recording started. */
  elapsed: string;
  /** The clip is over and is being transcribed — no Stop left to offer, only a discard. */
  transcribing: boolean;
  /** Hands-free is armed AND this transcript would qualify, so the strip warns before, not after. */
  handsFree: boolean;
  onStop: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-1 pb-1 text-xs text-primary">
      {transcribing ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
      ) : (
        <Mic className="size-3.5 shrink-0 animate-pulse" />
      )}
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{transcribing ? "Transcribing…" : `Recording ${elapsed}`}</span>
        {!transcribing && (
          <span className="text-muted-foreground">
            {handsFree ? " — will send when you stop" : " — lands in the message box"}
          </span>
        )}
      </span>
      {!transcribing && (
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted"
        >
          Stop
        </button>
      )}
      <button
        type="button"
        onClick={onDiscard}
        aria-label="Discard recording"
        className="shrink-0 rounded-md px-2 py-0.5 font-medium text-muted-foreground underline-offset-2 transition-colors hover:underline active:bg-muted"
      >
        ✕
      </button>
    </div>
  );
}
