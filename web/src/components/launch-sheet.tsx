import { Play } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { useLaunchers } from "@/lib/operator-config";
import type { Launcher } from "@/lib/types";

interface LaunchSheetProps {
  open: boolean;
  onClose: () => void;
  /** Fired with the row's command. The caller owns the write (useSpaceActions().launch). */
  onLaunch: (command: string) => void;
  /** This device isn't authorised to write — show a read-only note instead of the rows. */
  readOnly?: boolean;
}

// The launcher rows as a sheet, so they are reachable from a screen that is not the dashboard. Same
// rows as the dashboard's Launch section; a different reason to exist: from a Space, or from a pane
// you are reading, the strip is two navigations away, which is exactly the moment you wanted a
// glance at something else.
//
// A row shows its label AND its command, which the dashboard's buttons cannot: a sheet row is a full
// screen width, and `rumen-peek` under "Runs & quota" is the difference between trusting a button
// and wondering what it runs. `cwd` is deliberately not shown — it is an absolute host path, so it
// would be the longest and least distinguishing thing on every row.
export function LaunchSheet({ open, onClose, onLaunch, readOnly = false }: LaunchSheetProps) {
  const launchers = useLaunchers();

  function fire(launcher: Launcher) {
    // Close first: the launch navigates into the new pane, and a sheet still up while the route
    // changes under it would have to be dismissed on the screen you just arrived at.
    onClose();
    onLaunch(launcher.command);
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Launch">
      {readOnly ? (
        // Same posture as the pane action sheet: a write this device cannot make is explained here
        // rather than offered and then refused by the bridge.
        <p className="px-3 py-2 text-sm text-muted-foreground">
          Read-only — this device isn&apos;t authorised to start anything.
        </p>
      ) : launchers.length === 0 ? (
        // The sheet is only ever opened from a control that hides itself when there are no rows, so
        // this is the race where the config read has not landed yet — not an operator with none.
        <p className="px-3 py-2 text-sm text-muted-foreground">No launchers declared.</p>
      ) : (
        <div className="flex flex-col">
          {launchers.map((launcher) => (
            <button
              key={launcher.command}
              type="button"
              onClick={() => fire(launcher)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent active:bg-muted"
            >
              <Play className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{launcher.label}</span>
                {/* The command is operator-authored text going into a text node, never markup. */}
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {launcher.command}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </BottomSheet>
  );
}
