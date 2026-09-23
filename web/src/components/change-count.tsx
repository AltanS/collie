import { useState } from "react";

import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { countArrival, countSignature, type CountArrival, type WorkspaceChangeCount } from "@/lib/workspace-changes";

/** The words, or the numbers: `3 files +12 −4`. */
function ChangeCountText({ count }: { count: Exclude<WorkspaceChangeCount, { kind: "loading" }> }) {
  switch (count.kind) {
    case "clean":
      return <>{t("home.changes.clean")}</>;
    case "no-folder":
      return <>{t("home.changes.noFolder")}</>;
    case "unavailable":
      return <>{t("home.changes.unavailable")}</>;
    case "changed":
      return (
        <span className="flex items-center gap-2">
          <span>{tn("home.changes.files", count.files)}</span>
          <span className="font-mono text-[11px]">
            <span className="text-status-done">+{count.added}</span>{" "}
            <span className="text-status-blocked">−{count.removed}</span>
          </span>
        </span>
      );
  }
}

/**
 * One workspace's change count in a fixed 16px line: a skeleton bar until the first answer, then the
 * words or the numbers. The dashboard's Changes tab draws it on every row, and the Changes screen's
 * header draws the same one, so a tap carries the same line from one to the other. The bar and the
 * text share ONE grid cell, so the swap moves nothing.
 *
 * How a value shows (`countArrival`): the first answer crossfades in over the skeleton; a later,
 * different value swaps in place with a short opacity dip; an answer the page kept from an earlier
 * visit shows at once. The arrival is decided once per value, so a refresh with the same answer
 * renders the same classes and touches no node. The motion lives in index.css (`.count-*`), which
 * turns all of it off under reduced motion.
 *
 * `glide` marks the line for the tab-to-screen view transition (lib/glide.ts).
 */
export function ChangeCountSlot({
  count,
  glide,
  className,
}: {
  count: WorkspaceChangeCount;
  glide?: "count";
  className?: string;
}) {
  const sig = countSignature(count);
  const [shown, setShown] = useState<{ sig: string; how: CountArrival }>(() => ({
    sig,
    how: countArrival(null, count),
  }));
  let how = shown.how;
  if (shown.sig !== sig) {
    how = countArrival(shown.sig, count);
    setShown({ sig, how });
  }
  const loading = count.kind === "loading";
  return (
    <span
      className={cn("grid h-4 items-center [grid-template-areas:'slot'] *:[grid-area:slot]", className)}
      data-slot="count-line"
      data-state={loading ? "loading" : how}
      data-glide={glide}
    >
      <span aria-hidden className={cn("count-skeleton h-2.5 w-24 rounded-full bg-muted", !loading && "count-skeleton--done")} />
      {loading ? (
        <span className="sr-only">{t("home.changes.loading")}</span>
      ) : (
        <span key={sig} className={cn(how === "arrive" && "count-arrive", how === "update" && "count-update")}>
          <ChangeCountText count={count} />
        </span>
      )}
    </span>
  );
}
