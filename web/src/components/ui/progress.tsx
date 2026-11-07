import { cn } from "@/lib/utils";

/**
 * How far something is, as one bar. The fill is a width inside a box whose height is stated, so a
 * value that moves repaints and never re-lays-out (DESIGN.md section 2).
 *
 * Two sizes, both with the house 2px corner on the fill and the track:
 *  - `thin`: a 4px bar on a `--muted` track, for a row of its own (Chat's progress row).
 *  - `hairline`: a 1px line with NO track, for the bottom edge of a card or a row, where an empty
 *    track would read as a second border.
 *
 * It owns the look and the `progressbar` role. It owns no words: the caller passes `label` for the
 * screen reader and draws any visible text beside it.
 *
 * `value: null` is a bar that does not know its total yet: the track with no fill and NO
 * `aria-valuenow`, which is how ARIA says "indeterminate". Never a bar that claims 0%.
 */
export function Progress({
  value,
  label,
  size = "thin",
  className,
}: {
  /** 0 to 100. Anything outside is clamped, so a bad number never draws past the track. Null: not known yet. */
  value: number | null;
  /** What the bar measures, for a screen reader. */
  label: string;
  size?: "thin" | "hairline";
  className?: string;
}) {
  const percent = value === null ? null : Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(percent)}
      data-slot="progress"
      data-size={size}
      data-indeterminate={percent === null ? "" : undefined}
      className={cn("w-full overflow-hidden rounded-sm", size === "thin" ? "h-1 bg-muted" : "h-px", className)}
    >
      <div
        data-slot="progress-fill"
        className="h-full rounded-sm bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: `${percent ?? 0}%` }}
      />
    </div>
  );
}
