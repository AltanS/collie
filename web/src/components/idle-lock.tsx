import { Lock } from "lucide-react";

import { Button } from "@/components/ui/button";

// Shown after the idle timeout. While visible, polling is paused (see App), so a left-open phone
// neither leaks live agent state nor keeps hitting the socket.
export function IdleLock({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background/95 px-6 text-center backdrop-blur-md">
      <Lock className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-medium">Paused for safety</p>
        <p className="text-sm text-muted-foreground">Live updates stopped after a while idle.</p>
      </div>
      <Button size="lg" onClick={onUnlock}>
        Tap to resume
      </Button>
    </div>
  );
}
