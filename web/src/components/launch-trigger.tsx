import { useState } from "react";
import { Rocket } from "lucide-react";

import { LaunchSheet } from "@/components/launch-sheet";
import { cn } from "@/lib/utils";
import { useLaunchers } from "@/lib/operator-config";
import { useSpaceActions } from "@/hooks/use-spaces";

interface LaunchTriggerProps {
  /** This device isn't authorised to write — the sheet says so instead of offering the rows. */
  readOnly?: boolean;
  /**
   * Button classes, for a host whose right cluster is not the standard header one: the pane packs
   * `size-8` icons against its status badge, while the dashboard and space headers use the roomier
   * `size-11` of the Settings gear beside them.
   */
  className?: string;
}

// The header's launch control: an icon that opens the launcher sheet. Self-contained on purpose —
// it owns the open state and mounts its own sheet, so a route adds launchers to its header with one
// element in a slot and no state to thread through the route tree.
//
// It renders nothing when no rows are declared, which is what makes it safe to mount in every
// header: an operator without a `launchers.toml` gets the header they already had, with no dead icon
// eating a touch target in the one row of the screen where space is scarcest.
export function LaunchTrigger({ readOnly = false, className }: LaunchTriggerProps) {
  const launchers = useLaunchers();
  const { launch, launching } = useSpaceActions();
  const [open, setOpen] = useState(false);

  if (launchers.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Launch"
        className={cn(
          "grid size-11 place-items-center text-muted-foreground transition-colors hover:text-foreground",
          className,
        )}
      >
        <Rocket className="size-5" />
      </button>
      <LaunchSheet
        open={open}
        onClose={() => setOpen(false)}
        onLaunch={launch}
        launching={launching}
        readOnly={readOnly}
      />
    </>
  );
}
