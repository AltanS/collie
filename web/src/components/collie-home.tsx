import { cn } from "@/lib/utils";
import { DogGallop } from "@/components/dog-gallop";

interface CollieHomeProps {
  /** Return to the dashboard. */
  onHome?: () => void;
  /** While the connection isn't live, run the gallop sprite; otherwise show the static app icon. */
  connecting: boolean;
  /** The outage has passed the escalation threshold (useConnectionLost). The mark stops galloping and
   *  rests on the static app icon, muted — a galloping mark that never stops reads as "still trying"
   *  when we've in fact given up; the muted icon says "not connected" at a glance, matching the boot
   *  splash. (Never a gallop rest-frame — that full-stretch pose looks frozen mid-run.) */
  lost?: boolean;
  /** Show the "Collie" wordmark beside the mark (dashboard header). Omit inside a pane to save space. */
  wordmark?: boolean;
  className?: string;
}

// The single, shared Collie mark: brand + home button + connection loader in one, so the top-left of
// every screen means the same thing. At rest it's the familiar static app icon (favicon.svg); the
// moment the connection isn't live it springs into the galloping sprite — until the outage escalates
// (`lost`), when it drops the gallop and rests on the SAME static icon, muted, then settles back to
// the full-color icon once live. The rest state is always the static icon, never a paused sprite: a
// gallop strip's rest frame is a full-stretch mid-stride pose that reads as frozen mid-run. Tapping it
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
          // Escalated: the reconnect has run past the threshold — the dog rests on the static app icon,
          // muted (grayscale + dimmed) to read asleep/inactive, in the same box (no gallop). NOT a
          // paused sprite: a gallop rest-frame is a full-stretch mid-stride pose that looks frozen
          // mid-run — the "stuck mid-run" bug. Mirrors the boot splash's not-connected state.
          <img src="/favicon.svg" alt="" className="size-8 opacity-40 grayscale" />
        ) : (
          // Live rest state = the original app icon (bigger, detailed collie) at full color, same box
          // as the sprite so the mark doesn't resize when it settles. Larger than the agent logo.
          <img src="/favicon.svg" alt="" className="size-8" />
        )}
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
