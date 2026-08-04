import { Button } from "@/components/ui/button";

// The cover shown while the idle lock is engaged. It sits ABOVE a still-mounted router (see App), so
// resuming returns you to the exact screen, draft and scroll position you left — nothing is unmounted
// and nothing is rebuilt.
//
// It leads with the Collie mark for a plain reason: this is the one screen in the app with no header,
// no herd and no chrome, so without the badge a full-viewport "Paused" panel is unattributable — it
// could be any app that happened to be open. The mark is the STATIC app icon, never <DogGallop/>:
// that sprite's rest frame is a full-stretch mid-stride pose that reads as "frozen mid-run", and this
// screen is the app's most literal rest state.
//
// No lock iconography and no "for safety" — the pause guards nothing (.adr/0007). Saying otherwise
// would promise a gate that a page reload has always walked straight through.
export function IdleLock({ onUnlock }: { onUnlock: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Collie paused"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-background/95 px-6 text-center backdrop-blur-md"
    >
      <div className="flex flex-col items-center gap-3">
        {/* Same ringed badge the header uses, scaled up — the collie art is transparent, so the ring
            is what makes it read as a deliberate mark rather than a floating sticker. */}
        <span className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-500/40 ring-1 ring-[whitesmoke]/60">
          <img src="/favicon.svg" alt="" className="size-16" />
        </span>
        <span className="text-lg font-semibold tracking-tight">Collie</span>
      </div>
      <div className="space-y-1">
        <p className="font-medium">Paused</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Live updates stopped while this screen sat idle. Resuming picks up right where you left off.
        </p>
      </div>
      <Button size="lg" onClick={onUnlock}>
        Tap to resume
      </Button>
    </div>
  );
}
