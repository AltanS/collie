import { cn } from "@/lib/utils";
import { DogGallop } from "@/components/dog-gallop";

interface CollieHomeProps {
  /** Return to the dashboard. */
  onHome?: () => void;
  /** While the connection isn't live, run the gallop sprite; otherwise show the static app icon. */
  connecting: boolean;
  /** Show the "Collie" wordmark beside the mark (dashboard header). Omit inside a pane to save space. */
  wordmark?: boolean;
  className?: string;
}

// The single, shared Collie mark: brand + home button + connection loader in one, so the top-left of
// every screen means the same thing. At rest it's the familiar static app icon (favicon.svg); the
// moment the connection isn't live it springs into the galloping sprite, then settles back once live.
// Tapping it returns to the dashboard. The dashboard shows the "Collie" wordmark too; inside a pane
// the mark stands alone (the breadcrumb carries the context). Both headers render THIS component —
// the consistency is structural, not a convention two files have to keep agreeing on.
export function CollieHome({ onHome, connecting, wordmark = false, className }: CollieHomeProps) {
  return (
    <button
      type="button"
      onClick={onHome}
      // The gallop conveys connection state visually; fold it into the button's accessible name too,
      // so screen-reader and reduced-motion users get it (inside a pane there's no other cue).
      aria-label={connecting ? "Collie home — reconnecting" : "Collie home"}
      className={cn(
        "-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      {connecting ? (
        <DogGallop running />
      ) : (
        // Rest state = the original app icon (bigger, detailed collie), same 1.5rem box as the sprite.
        <img src="/favicon.svg" alt="" className="size-6 shrink-0 rounded" />
      )}
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
