// The voice takeover's cards: the REAL `VoiceTakeover` in each of its four states, standing over a
// drawn chrome block exactly as it stands over the composer's. DEV-ONLY, unreachable from the app
// entry.
//
// WHAT IS REAL AND WHAT IS STAGED. The takeover, the speech detector, the ring, the bars and the
// belt (`ActionsRow`) are the app's own components. The microphone is not: a card has no stream, so
// each one reads a SCRIPTED level source (`scripted` below), a plain `LevelSource` that plays quiet,
// or speech, or speech then quiet. The detector runs on it for real, so the countdown card's ring
// closes because three seconds of quiet were heard, not because an animation was told to. The
// composer under the takeover is drawn, not mounted: a real `Composer` needs a bridge publishing a
// speech provider, and this page answers no API. The block is built the way the real one is, a
// `relative` box whose flow content is hidden and `inert` and whose takeover is `absolute inset-0`,
// so the cards show the real geometry (the swap, the OK button on the mic's spot).

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons/icon";

import { ActionsRow } from "@/components/actions-row";
import { MIRROR_INVERT, MIRROR_SPACE } from "@/components/mirror-space";
import { Button } from "@/components/ui/button";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import { VoiceTakeover, VOICE_BAR_COUNT, type VoiceTakeoverPhase } from "@/components/voice-takeover";
import type { LevelSource } from "@/lib/audio-meter";
import { SILENCE_FINISH_MS } from "@/lib/speech-endpoint";
import { cn } from "@/lib/utils";

import { Card, Group } from "../layout";
import { took, useRoomyActions } from "./shared";

type Script = "quiet" | "speech" | "speech-then-quiet";

/** How long the countdown card speaks before it goes quiet, in ms. */
const SPEECH_MS = 1200;

/** Real-looking bars for a moment of speech: a travelling wave over a slow envelope. */
function speechBars(bars: Float32Array, seconds: number): void {
  const count = bars.length;
  const envelope = 0.7 + 0.3 * Math.sin(seconds * 2.1);
  for (let i = 0; i < count; i += 1) {
    const spread = 0.35 + 0.65 * Math.exp(-(((i - (count - 1) / 2) / (count * 0.45)) ** 2));
    const wave = 0.5 + 0.5 * Math.sin(i * 0.8 - seconds * 9) * Math.cos(i * 0.31 + seconds * 3.1);
    bars[i] = Math.min(1, Math.max(0.06, envelope * spread * (0.3 + 0.7 * wave)));
  }
}

/** A level source that plays a script from the moment it is made. */
function scripted(script: Script): LevelSource {
  const started = performance.now();
  return {
    read(bars) {
      const elapsed = performance.now() - started;
      const speaking = script === "speech" || (script === "speech-then-quiet" && elapsed < SPEECH_MS);
      if (speaking) {
        speechBars(bars, elapsed / 1000);
        return 0.12;
      }
      for (let i = 0; i < bars.length; i += 1) bars[i] = (bars[i] ?? 0) * 0.8;
      return 0.004;
    },
  };
}

/** A mounted script that starts over: the countdown card replays every few seconds. */
function useReplayKey(everyMs: number | null): number {
  const [key, setKey] = useState(0);
  useEffect(() => {
    if (everyMs === null) return;
    const id = window.setInterval(() => setKey((k) => k + 1), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return key;
}

/** The composer's box as it stands under the takeover: attach and the mic, drawn. */
function DrawnBox() {
  return (
    <div className="flex items-end gap-1 rounded-xl border border-input bg-background p-1">
      <div className="min-h-9 min-w-0 flex-1 py-1.5 pl-2 font-mono text-[14px] leading-6 text-muted-foreground">Reply to the agent</div>
      <Button size="icon" variant="ghost" className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full text-muted-foreground")} aria-label="Attach">
        <Icon name="attach" className="size-4" />
      </Button>
      <Button size="icon" className={cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full")} aria-label="Record a voice message">
        <Icon name="mic" className="size-4" />
      </Button>
    </div>
  );
}

const BLOCK_PAD = "pb-2";

/** A pane's worth of dark above, then the chrome block with the takeover over it. */
function TakeoverStage({
  phase,
  elapsed,
  script,
  replayMs = null,
  engine = "host",
  failure = null,
  canSendToHost = false,
}: {
  phase: VoiceTakeoverPhase;
  elapsed: string;
  script: Script;
  replayMs?: number | null;
  engine?: "host" | "phone";
  failure?: string | null;
  canSendToHost?: boolean;
}) {
  const roomy = useRoomyActions();
  const key = useReplayKey(replayMs);
  const [source, setSource] = useState<LevelSource>(() => scripted(script));
  useEffect(() => setSource(scripted(script)), [script, key]);
  return (
    <div data-pg-frame="" className="relative isolate flex h-[250px] w-[390px] max-w-full flex-col overflow-hidden rounded-xl border border-border bg-background" style={{ transform: "translate(0)" }}>
      <div className={cn("min-h-0 flex-1", MIRROR_SPACE, MIRROR_INVERT)} />
      <div data-slot="chrome-block" className="relative border-t border-rule bg-chrome">
        <div className={cn("relative bg-chrome px-3 invisible", BLOCK_PAD)} inert>
          <ActionsRow general={roomy} agent="claude" onRun={took} />
          <DrawnBox />
        </div>
        <VoiceTakeover
          key={key}
          phase={phase}
          elapsed={elapsed}
          source={source}
          padClassName={BLOCK_PAD}
          engine={engine}
          failure={failure}
          onSendToHost={canSendToHost ? () => {} : null}
          onStop={() => {}}
          onDiscard={() => {}}
          takeFocus={false}
        />
      </div>
    </div>
  );
}

const NOTE =
  "The takeover is the real component over a drawn composer block; the microphone is a scripted level " +
  `source feeding the real speech detector (${VOICE_BAR_COUNT} bars). It fills the block's own box, so the ` +
  "block is exactly as tall as the composer under it.";

export function VoiceTakeoverGroup() {
  return (
    <Group title="Voice takeover (design 3.3)">
      <Card
        state="voice-takeover-listening"
        label="1: listening, no speech yet"
        reach="tap the round mic button on an empty composer, then stay quiet. There is no auto-finish until a word has been heard."
        note={NOTE}
      >
        <TakeoverStage phase="recording" elapsed="0:03" script="quiet" />
      </Card>
      <Card
        state="voice-takeover-hearing"
        label="2: hearing speech"
        reach="tap the mic and talk. The bars follow your voice and take the primary ink."
        note={NOTE}
      >
        <TakeoverStage phase="recording" elapsed="0:07" script="speech" />
      </Card>
      <Card
        state="voice-takeover-countdown"
        label={`3: the ${SILENCE_FINISH_MS / 1000} s countdown after speech`}
        reach={`stop talking after a sentence. ${SILENCE_FINISH_MS / 1000} s of quiet closes the ring round OK and transcribes; speaking again empties it.`}
        note={`${NOTE} This card speaks for ${SPEECH_MS / 1000} s, then goes quiet and replays every 6 s.`}
      >
        <TakeoverStage phase="recording" elapsed="0:12" script="speech-then-quiet" replayMs={6000} />
      </Card>
      <Card
        state="voice-takeover-transcribing"
        label="4: transcribing, the bin still cancels"
        reach="tap OK, or let the countdown finish. The ring becomes one turning arc, OK is dimmed and disabled, the bin throws the clip away and aborts the request."
        note={`${NOTE} Under reduced motion the arc is a still full ring at 40%.`}
      >
        <TakeoverStage phase="transcribing" elapsed="0:12" script="quiet" />
      </Card>
      <Card
        state="voice-takeover-transcribing-phone"
        label="5: transcribing on this phone"
        reach="choose This phone in Settings, Speech, then record. Only the word changes; there is still one turning arc."
        note={NOTE}
      >
        <TakeoverStage phase="transcribing" elapsed="0:12" script="quiet" engine="phone" />
      </Card>
      <Card
        state="voice-takeover-failed"
        label="6: the phone could not transcribe, the host can"
        reach="make the phone engine fail (a damaged model, or two crashes). The sentence takes the word's place, Send to host takes the bars' place, and nothing is sent until you tap it."
        note={`${NOTE} Without an available host provider the button is not drawn and the bars stay dimmed.`}
      >
        <TakeoverStage phase="failed" elapsed="0:12" script="quiet" failure="The speech engine stopped." canSendToHost />
      </Card>
    </Group>
  );
}
