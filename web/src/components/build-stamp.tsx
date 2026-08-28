import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { fetchConfig } from "@/lib/api";
import { BUILD, buildLabel, isStaleBuild } from "@/lib/build";
import { getServerBuild, observeServerBuild, useServerBuild } from "@/lib/server-build";
import { checkForUpdate } from "@/lib/pwa";

// Tiny build stamp for the UI footer. The id is baked into THIS bundle, so it travels with the
// cached bundle — meaning the footer tells you which bundle you're actually running. It reads the
// bridge's current build id from the shared store (fed live by the `X-Collie-Build` header on every
// poll, see lib/server-build.ts) and, if they differ (you're on a stale bundle), flags it with a
// one-tap update — appearing/disappearing in real time as the server rebuilds. See README →
// Troubleshooting.
export function BuildStamp({ className }: { className?: string }) {
  useLocale();
  const serverBuild = useServerBuild();
  const [updating, setUpdating] = useState(false);
  useEffect(() => {
    let alive = true;
    // Initial fill: the poll-driven header normally seeds the store first, but fetch config once so
    // the footer is correct even before the first poll lands — and so an older bridge that reports
    // `build` in JSON but sends no header still works. Only seed when nothing's been observed yet
    // (the config response's own header usually already has), so we don't double-count an observation.
    void (async () => {
      try {
        const c = await fetchConfig();
        if (alive && getServerBuild() === undefined) observeServerBuild(c.build);
      } catch {
        /* offline / bridge down — just show the local stamp */
      }
    })();
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
        "text-center text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {/* Monospaced because the label carries the git hash — the operator reads it character by
          character against a `git log`, which is the one thing a proportional face makes harder.
          The bare semver in alpha-bar.tsx is chrome and wears the UI face; this is not. */}
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
                {t("settings.buildStamp.updating")}
              </span>
            ) : (
              t("settings.buildStamp.tapToUpdate")
            )}
          </button>
        </>
      )}
    </div>
  );
}
