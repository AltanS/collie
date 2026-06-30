import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { fetchConfig } from "@/lib/api";
import { BUILD, buildLabel, isStaleBuild } from "@/lib/build";
import { checkForUpdate } from "@/lib/pwa";

// Tiny build stamp for the UI footer. The id is baked into THIS bundle, so it travels with the
// service-worker cache — meaning the footer tells you which bundle you're actually running. It also
// fetches the bridge's current build id and, if they differ (you're on a stale per-origin cache),
// flags it with a one-tap update. See README → Troubleshooting.
export function BuildStamp({ className }: { className?: string }) {
  const [serverBuild, setServerBuild] = useState<string | undefined>();
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => {
        if (alive) setServerBuild(c.build);
      })
      .catch(() => {
        /* offline / bridge down — just show the local stamp */
      });
    return () => {
      alive = false;
    };
  }, []);

  const stale = isStaleBuild(BUILD.id, serverBuild);

  function update() {
    // Hand off to the SW update flow: force a check, then let the new worker activate and reload us
    // (see lib/pwa.ts). The reload navigates away, so `updating` is just feedback until it does.
    setUpdating(true);
    void checkForUpdate();
  }

  return (
    <div
      className={cn(
        "text-center text-[11px] leading-relaxed text-muted-foreground/70",
        className,
      )}
    >
      <span className="font-mono">{buildLabel()}</span>
      {stale && (
        <>
          {" · "}
          <button
            type="button"
            onClick={update}
            disabled={updating}
            className="font-medium text-status-working underline underline-offset-2 disabled:no-underline disabled:opacity-70"
          >
            {updating ? (
              <span className="inline-flex items-center gap-1 align-middle">
                <Loader2 className="size-3 animate-spin" />
                updating…
              </span>
            ) : (
              "new build — tap to update"
            )}
          </button>
        </>
      )}
    </div>
  );
}
