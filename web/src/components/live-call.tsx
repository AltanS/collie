import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Phone, PhoneOff, Play, Volume2 } from "lucide-react";

import { useLiveCall } from "@/hooks/use-live-call";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { LivePhase } from "@/lib/live";
import type { Scope } from "@/lib/scope";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Notice } from "@/components/ui/notice";
import { BottomSheet } from "@/components/ui/sheet";

interface LiveCallControlProps {
  paneId: string;
  scope?: Scope;
  disabled: boolean;
}

function phaseLabel(phase: LivePhase | undefined): string {
  switch (phase) {
    case "connecting":
      return t("live.phase.connecting");
    case "listening":
      return t("live.phase.listening");
    case "working":
      return t("live.phase.working");
    case "muted":
      return t("live.phase.muted");
    case "error":
      return t("live.phase.error");
    case "idle":
    default:
      return t("live.phase.idle");
  }
}


export function LiveCallControl({ paneId, scope, disabled }: LiveCallControlProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const [needsPlay, setNeedsPlay] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const detachRemote = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio === null) return;
    audio.pause();
    audio.srcObject = null;
  }, []);
  const attemptPlay = useCallback(async (audio: HTMLAudioElement) => {
    try {
      await audio.play();
      if (audioRef.current === audio) setNeedsPlay(false);
    } catch {
      if (audioRef.current === audio) setNeedsPlay(true);
    }
  }, []);
  const attachRemote = useCallback(
    (stream: MediaStream | null) => {
      detachRemote();
      if (stream === null) return;
      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "");
      audio.srcObject = stream;
      audioRef.current = audio;
      void attemptPlay(audio);
    },
    [attemptPlay, detachRemote],
  );
  useEffect(() => detachRemote, [detachRemote]);
  const live = useLiveCall({ paneId, scope, disabled, onRemoteStream: attachRemote });
  const unavailable = live.status?.available === false;
  const muted = live.status?.muted ?? false;
  const playRemote = useCallback(() => {
    const audio = audioRef.current;
    if (audio !== null) void attemptPlay(audio);
  }, [attemptPlay]);
  const stop = live.stop;
  const closeSheet = useCallback(() => {
    stop();
    setOpen(false);
  }, [stop]);

  return (
    <>
      <div className="px-3 pt-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          className="h-11 w-full justify-start"
          aria-label={t("live.control.openAria")}
          onClick={() => setOpen(true)}
        >
          <Phone className="size-4" />
          {t("live.control.open")}
        </Button>
      </div>
      <BottomSheet open={open} onClose={closeSheet} title={t("live.sheet.title")}>
        <div className="space-y-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <Card className="gap-0 py-0">
            <div className="flex items-start gap-3 p-4">
              <Phone className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="font-medium">{t("live.sheet.title")}</p>
                <p className="mt-1 text-sm text-muted-foreground">{phaseLabel(live.status?.phase)}</p>
              </div>
            </div>
            <div className="border-t border-border p-4">
              {live.active ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-11 min-w-0 flex-1"
                    disabled={live.busy}
                    aria-pressed={muted}
                    onClick={() => void live.setMuted(!muted)}
                  >
                    {muted ? <Mic className="size-4" /> : <MicOff className="size-4" />}
                    {muted ? t("live.control.unmute") : t("live.control.mute")}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    size="lg"
                    className="h-11 min-w-0 flex-1"
                    onClick={() => void live.stop()}
                  >
                    <PhoneOff className="size-4" />
                    {t("live.control.end")}
                  </Button>
                </div>
              ) : live.busy ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="lg"
                  className="h-11 w-full"
                  onClick={() => void live.stop()}
                >
                  <PhoneOff className="size-4" />
                  {t("live.control.end")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="lg"
                  className="h-11 w-full"
                  disabled={disabled || unavailable || live.loading}
                  onClick={() => void live.start()}
                >
                  <Phone className="size-4" />
                  {t("live.control.start")}
                </Button>
              )}
            </div>
          </Card>

          {needsPlay && live.active && (
            <Button type="button" variant="outline" size="lg" className="h-11 w-full" onClick={playRemote}>
              <Play className="size-4" />
              {t("live.control.play")}
            </Button>
          )}

          {unavailable && !live.status?.error && (
            <Notice tone="neutral" variant="box" announce="none" icon={<Volume2 className="size-4" />}>
              {t("live.unavailable")}
            </Notice>
          )}
          {live.status?.error && (
            <Notice tone="danger" variant="box" announce="alert" icon={<MicOff className="size-4" />}>
              {live.status.error}
            </Notice>
          )}

          {live.status !== null && live.status.transcripts.length > 0 && (
            <Card className="gap-0 py-0">
              <div className="border-b border-border p-4">
                <p className="font-medium">{t("live.transcript.title")}</p>
              </div>
              <ol className="max-h-44 space-y-2 overflow-y-auto p-4 font-content text-sm">
                {live.status.transcripts.map((line, index) => (
                  <li key={`${line.role}-${index}`} className="text-foreground">
                    <span className="mr-1 text-xs text-muted-foreground">
                      {line.role === "user" ? t("live.transcript.user") : t("live.transcript.assistant")}
                    </span>
                    {line.text}
                  </li>
                ))}
              </ol>
            </Card>
          )}

          <p className="px-1 text-xs leading-snug text-muted-foreground">{t("live.limitation")}</p>
        </div>
      </BottomSheet>
    </>
  );
}
