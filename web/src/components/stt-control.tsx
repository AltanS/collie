import { Loader2, Mic } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { audioRecordingSupported } from "@/hooks/use-audio-recorder";
import { useSttAvailability } from "@/hooks/use-stt-availability";
import { setHandsFree, setSttEnabled, useSttPrefs } from "@/lib/stt-prefs";

export function SttControl() {
  const serverStatus = useSttAvailability();
  const prefs = useSttPrefs();
  const browserSupported = audioRecordingSupported();
  const available = Boolean(serverStatus?.available && browserSupported);
  const reason = !browserSupported
    ? "This browser does not support audio recording"
    : serverStatus?.reason;
  const effectiveEnabled = available && prefs.enabled;

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Mic className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Speech to text</div>
            <p className="text-sm text-muted-foreground">
              Record a reply with experimental Codex transcription.
            </p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          {serverStatus ? (
            <Switch
              checked={effectiveEnabled}
              disabled={!available}
              onCheckedChange={setSttEnabled}
              aria-label="Speech to text"
            />
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-border/60 p-4">
        <div className="min-w-0 pl-8">
          <div className="font-medium">Hands free</div>
          <p className="text-sm text-muted-foreground">
            Send the transcript immediately instead of placing it in the input box.
          </p>
        </div>
        <Switch
          checked={prefs.handsFree}
          disabled={!effectiveEnabled}
          onCheckedChange={setHandsFree}
          aria-label="Hands free"
        />
      </div>

      {serverStatus && !available && reason && (
        <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          {reason}
        </p>
      )}
    </Card>
  );
}
