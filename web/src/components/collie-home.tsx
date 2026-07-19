import { cn } from "@/lib/utils";
import { DogGallop } from "@/components/dog-gallop";

interface CollieHomeProps {
  /** Return to the dashboard. */
  onHome?: () => void;
  /** While the connection isn't live, run the gallop sprite; otherwise show the static app icon. */
  connecting: boolean;
  /** The outage has passed the escalation threshold (useConnectionLost). The mark stops galloping and
   *  rests on a still frame — a galloping mark that never stops reads as "still trying" when we've in
   *  fact given up; resting says "not connected" at a glance, matching the boot splash. */
  lost?: boolean;
  /** Show the "Collie" wordmark beside the mark (dashboard header). Omit inside a pane to save space. */
  wordmark?: boolean;
  className?: string;
}

// The single, shared Collie mark: brand + home button + connection loader in one, so the top-left of
// every screen means the same thing. At rest it's the familiar static app icon (favicon.svg); the
// moment the connection isn't live it springs into the galloping sprite — until the outage escalates
// (`lost`), when it stops galloping and rests, then settles back to the app icon once live. Tapping it
// returns to the dashboard. The dashboard shows the "Collie" wordmark too; inside a pane the mark
// stands alone (the breadcrumb carries the context). Both headers render THIS component — the
// consistency is structural, not a convention two files have to keep agreeing on.
export function CollieHome({ onHome, connecting, lost = false, wordmark = false, className }: CollieHomeProps) {
  const gallop = connecting && !lost;
  return (
    <button
      type="button"
      onClick={onHome}
      // The gallop conveys connection state visually; fold it into the button's accessible name too,
      // so screen-reader and reduced-motion users get it (inside a pane there's no other cue).
      aria-label={!connecting ? "Collie home" : lost ? "Collie home — not connected" : "Collie home — reconnecting"}
      className={cn(
        "-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      {/* A whitesmoke ring frames the mark so it reads as a deliberate badge against the dark header
          (the collie art is transparent, so it otherwise floats). The ring wraps every state so the
          frame doesn't pop in/out as the connection settles out of the gallop. */}
      <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-500/40 ring-1 ring-[whitesmoke]/60">
        {gallop ? (
          <DogGallop running size="2rem" />
        ) : lost ? (
          // Escalated: the reconnect has run past the threshold — the dog rests on a still frame in the
          // same 2rem box (no gallop), the visual "not connected" cue that mirrors the boot splash.
          <DogGallop size="2rem" />
        ) : (
          // Live rest state = the original app icon (bigger, detailed collie), same 2rem box as the
          // sprite so the mark doesn't resize when it settles. Larger than the agent logo beside it.
          <img src="/favicon.svg" alt="" className="size-8" />
        )}
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
