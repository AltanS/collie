import { DogGallop } from "@/components/dog-gallop";
import { cn } from "@/lib/utils";

interface CollieHomeProps {
  /** Return to the dashboard. */
  onHome?: () => void;
  /** Generic route loading animation only; it makes no freshness or connection claim. */
  loading?: boolean;
  /** Static treatment for a degraded root snapshot. */
  degraded?: boolean;
  /** Show the "Collie" wordmark beside the mark (dashboard header). */
  wordmark?: boolean;
  className?: string;
}

// The shared brand/home mark. Generic loading may animate it; degraded root data is a separate,
// static visual treatment. The accessible name stays stable because neither state diagnoses a network.
export function CollieHome({
  onHome,
  loading = false,
  degraded = false,
  wordmark = false,
  className,
}: CollieHomeProps) {
  return (
    <button
      type="button"
      onClick={onHome}
      aria-label="Collie home"
      className={cn(
        "-mx-1 flex items-center gap-2 rounded px-1 transition-opacity active:opacity-70",
        className,
      )}
    >
      <span
        className={cn(
          "grid size-10 shrink-0 place-items-center overflow-hidden rounded-full bg-zinc-500/40 ring-1 ring-[whitesmoke]/60",
          degraded && "opacity-40 grayscale",
        )}
      >
        {loading ? (
          <DogGallop running size="2rem" />
        ) : (
          <img src="/favicon.svg" alt="" className="size-8" />
        )}
      </span>
      {wordmark && <span className="text-lg font-semibold tracking-tight">Collie</span>}
    </button>
  );
}
