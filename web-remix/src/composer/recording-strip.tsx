// The armed indicator for a voice recording (a port of web/src/components/recording-strip.tsx), for
// the same in-flow slot as the "You sent:" and direct-typing strips, and for the same reason: a live
// microphone is state you can leave the phone holding, and the only thing in the field of view that
// says so must be words, not a tinted icon. The caller wraps it in a `Collapse`; this draws the row.
//
// Two controls, and they are DIFFERENT actions: Stop ends the clip and transcribes it, the ✕ throws it
// away and uploads nothing. Never one button: "stop" and "cancel" are the pair every recorder gets
// wrong, and here one of them spends the operator's audio on a provider.
//
// While transcribing there is no Stop left to offer, but its slot stays (`invisible`, out of the tab
// order) so the ✕ does not jump under the finger that was about to press it, and nothing in the row
// appears or leaves (REMIX3.md, rule 7). The hint is text inside one truncating span, not a node.
import { on, type Handle } from "remix/component";
import { LoaderCircle, Mic } from "lucide";

import { t } from "@web/lib/i18n";
import { cn } from "@web/lib/utils";

import { useLocale } from "../lib/i18n-store";
import { Icon } from "../ui/icon";

export interface RecordingStripProps {
  /** `m:ss` since the recording started. */
  elapsed: string;
  /** The clip is over and is being transcribed: no Stop left to offer, only a discard. */
  transcribing: boolean;
  /** Hands-free is armed AND this transcript would qualify, so the strip warns before, not after. */
  handsFree: boolean;
  /** Read at tap time. */
  onStop: () => void;
  /** Read at tap time. */
  onDiscard: () => void;
}

export function RecordingStrip(handle: Handle<RecordingStripProps>) {
  useLocale(handle);
  return () => {
    const { elapsed, transcribing, handsFree } = handle.props;
    const hint = transcribing ? "" : `, ${handsFree ? t("composer.mic.handsFreeHint") : t("composer.mic.manualHint")}`;
    return (
      <div data-testid="recording-strip" class="flex items-center gap-2 px-1 pb-1 text-xs text-primary">
        <Icon
          icon={transcribing ? LoaderCircle : Mic}
          class={cn("size-3.5 shrink-0", transcribing ? "animate-spin" : "animate-pulse")}
        />
        <span class="min-w-0 flex-1 truncate">
          <span class="font-medium">
            {transcribing ? t("composer.mic.transcribing") : t("composer.mic.recording", { elapsed })}
          </span>
          <span class="text-muted-foreground">{hint}</span>
        </span>
        <button
          type="button"
          data-testid="recording-stop"
          disabled={transcribing}
          tabindex={transcribing ? -1 : undefined}
          aria-hidden={transcribing ? "true" : undefined}
          mix={on("click", () => handle.props.onStop())}
          class={cn(
            "shrink-0 rounded-md px-2 py-0.5 font-medium underline-offset-2 transition-colors hover:underline active:bg-muted",
            transcribing && "invisible",
          )}
        >
          {t("composer.mic.stop")}
        </button>
        <button
          type="button"
          data-testid="recording-discard"
          aria-label={t("composer.mic.discardAria")}
          mix={on("click", () => handle.props.onDiscard())}
          class="shrink-0 rounded-md px-2 py-0.5 font-medium text-muted-foreground underline-offset-2 transition-colors hover:underline active:bg-muted"
        >
          ✕
        </button>
      </div>
    );
  };
}
