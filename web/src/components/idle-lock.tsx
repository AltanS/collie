import { Button } from "@/components/ui/button";
import { DogGallop } from "@/components/dog-gallop";

// The cover shown while the idle lock is engaged. It sits ABOVE a still-mounted router (see App), so
// resuming returns you to the exact screen, draft and scroll position you left — nothing is unmounted
// and nothing is rebuilt.
//
// It is deliberately GLASS rather than opaque. The cover's job is to say "this is frozen, not live" —
// a paused mirror read as a current one is the actual hazard — and it does that better while the herd
// stays legible underneath: you can see WHAT is stale instead of losing the screen entirely. The
// trade is that an unattended screen no longer hides agent output; that's accepted, because the
// device's own screen lock is the thing that was ever going to handle shoulder-surfing.
//
// It leads with the Collie mark for a plain reason: this is the one screen in the app with no header,
// no herd chrome and no nav, so without the badge a full-viewport panel is unattributable — it could
// be any app that happened to be open. The mark is the STATIC app icon, never <DogGallop/>: that
// sprite's rest frame is a full-stretch mid-stride pose that reads as "frozen mid-run", and this
// screen is the app's most literal rest state.
//
// No lock iconography and no "for safety" — the pause guards nothing (.adr/0007). Saying otherwise
// would promise a gate that a page reload has always walked straight through.
interface IdleLockProps {
  onUnlock: () => void;
  /** The refetch fired on resume is still in flight — hold the cover and run the gallop rather than
   *  dropping straight back onto the frozen screen this panel just warned about. */
  catchingUp?: boolean;
}

export function IdleLock({ onUnlock, catchingUp = false }: IdleLockProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Collie paused"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/40 px-6 backdrop-blur-[3px]"
    >
      {/* The panel carries its own, heavier blur so the copy stays readable over arbitrary pane text,
          while the scrim above keeps the herd recognisable behind it. */}
      <div className="flex flex-col items-center gap-6 rounded-3xl border border-border/60 bg-card/70 px-8 py-10 text-center shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl">
        <div className="flex flex-col items-center gap-3">
          {/* Same ringed badge the header uses, scaled up — the collie art is transparent, so the ring
              is what makes it read as a deliberate mark rather than a floating sticker. */}
          <span className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-500/40 ring-1 ring-[whitesmoke]/60">
            {catchingUp ? (
              // Same box, gallop swapped in for the static mark — exactly how CollieHome renders the
              // header mark when the connection is working, so "the dog is running" means one thing
              // everywhere: Collie is fetching.
              <DogGallop running size="4rem" label="Catching up" />
            ) : (
              <img src="/favicon.svg" alt="" className="size-16" />
            )}
          </span>
          <span className="text-lg font-semibold tracking-tight">Collie</span>
        </div>
        {catchingUp ? (
          <div className="space-y-1">
            <p className="font-medium">Catching up</p>
            <p className="max-w-xs text-sm text-muted-foreground">Fetching the herd's current state.</p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="font-medium">Paused</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Live updates stopped while this screen sat idle — what's behind this is frozen. Resuming
              picks up right where you left off.
            </p>
          </div>
        )}
        {/* The button doesn't just disable during the catch-up — it's replaced by the gallop above, so
            there's nothing to press twice and no dead control to look at. */}
        {!catchingUp && (
          <Button size="lg" onClick={onUnlock}>
            Tap to resume
          </Button>
        )}
      </div>
    </div>
  );
}
