// The build stamp (web/src/components/build-stamp.tsx): the id baked into THIS bundle, so it tells you
// which bundle you are running. When the bridge reports a different build (a stale cached bundle) it
// offers one tap to move onto the new one, through the shell's own service-worker flow.
import { on, type Handle } from "remix/component";
import { LoaderCircle } from "lucide";

import { BUILD, buildLabel, isStaleBuild } from "@web/lib/build";
import { t } from "@web/lib/i18n";

import { lastLiveAt, serverBuild } from "../../lib/api";
import { useLocale } from "../../lib/i18n-store";
import { useStore } from "../../lib/store";
import { checkForUpdate } from "../../update/pwa";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";

/** The bridge answered inside this window, so dropping the precache cannot strand the page offline. */
const LIVE_WINDOW_MS = 15_000;

export function BuildStamp(handle: Handle) {
  const readBuild = useStore(handle, serverBuild);
  useLocale(handle);
  let updating = false;
  return () => {
    const stale = isStaleBuild(BUILD.id, readBuild());
    return (
      <div class="text-center text-[11px] leading-relaxed text-muted-foreground" data-testid="build-stamp">
        {/* Monospaced because the label carries the git hash, read character by character against a log. */}
        <span class="font-mono">{buildLabel()}</span>
        <Collapse open={stale}>
          <button
            type="button"
            disabled={updating}
            class="font-medium text-status-working underline underline-offset-2 disabled:no-underline disabled:opacity-70"
            mix={on("click", () => {
              updating = true;
              void handle.update();
              void checkForUpdate({ bypass: false, bridgeAnswering: Date.now() - lastLiveAt.get() < LIVE_WINDOW_MS });
            })}
          >
            {updating ? (
              <span class="inline-flex items-center gap-1 align-middle">
                <Icon icon={LoaderCircle} class="size-3 animate-spin" />
                {t("settings.buildStamp.updating")}
              </span>
            ) : (
              t("settings.buildStamp.tapToUpdate")
            )}
          </button>
        </Collapse>
      </div>
    );
  };
}
