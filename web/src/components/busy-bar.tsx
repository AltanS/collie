import { useBusy } from "@/lib/busy";

// Slim indeterminate progress bar pinned to the very top of the viewport while any mutation is in
// flight (see lib/busy). Purely ambient: it's aria-hidden because every action already surfaces its
// own outcome through the status channel — this is just "something is submitting" reassurance. The
// CSS holds it invisible for a short delay after mount, so a fast action (resolved within that
// window) unmounts before it ever paints and never flashes.
export function BusyBar() {
  const busy = useBusy();
  if (!busy) return null;
  return (
    <div className="busy-bar" aria-hidden="true">
      <span className="busy-bar__indicator" />
    </div>
  );
}
