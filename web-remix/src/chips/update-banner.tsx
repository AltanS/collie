// The footer "update available" line: web/src/components/update-banner.tsx on the Remix 3 shell.
//
// It reads the snapshot's optional `update` and, when there is something to do, names it with the one
// command that fixes it. `updateNotice` is web's function word for word (that file is a React
// component, so it cannot be imported here without pulling React in); keep the two in step. The line
// appears and leaves through `Collapse`, and the copy chip's confirmation lasts 1.5 s on a timer that
// ends with the component.
import type { Handle } from "remix/component";
import { on } from "remix/component";
import { Check, Copy } from "lucide";

import { t } from "@web/lib/i18n";
import type { UpdateInfo } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { scheduleUpdate, useStore } from "../lib/store";
import { Collapse } from "../ui/collapse";
import { Icon } from "../ui/icon";

export interface UpdateNotice {
  /** The human line, e.g. "Bridge restart needed" / "Collie 0.12.0 available". */
  line: string;
  /** A copyable command that resolves it, spelled for the install kind. */
  command?: string;
  /** GitHub release page for the available version. Absent for the restart case. */
  href?: string;
}

/**
 * Decide what (if anything) the footer should nudge, from the snapshot's `update`. Precedence: a
 * stale running PROCESS outranks an available release. `null` = nothing to say.
 */
export function updateNotice(update: UpdateInfo | undefined): UpdateNotice | null {
  if (!update) return null;
  // An absent kind is an older bridge, read as Herdr-managed so the advice never regresses.
  const herdrManaged = update.installKind === undefined || update.installKind === "detached-checkout";
  // A packaged install never updates itself, so it gets no update command (ADR 0035).
  const selfUpdates = update.installKind !== "packaged";
  if (update.restartNeeded === true && update.restartCommand !== undefined) {
    return { line: t("settings.updateBanner.restartNeeded"), command: update.restartCommand };
  }
  if (update.bridgeStale) {
    return {
      line: t("settings.updateBanner.restart"),
      command: herdrManaged ? "herdr plugin action invoke restart --plugin herdr.collie" : "collie restart",
    };
  }
  if (update.releaseAvailable && update.latest) {
    return {
      line: t("settings.updateBanner.releaseAvailable", { version: update.latest }),
      href: update.latestUrl ?? undefined,
    };
  }
  if (update.majorAvailable) {
    const line = t("settings.updateBanner.majorAvailable", { version: update.majorAvailable });
    const href = update.majorUrl ?? undefined;
    if (!selfUpdates) return { line, href };
    return {
      line,
      href,
      command: herdrManaged ? "herdr plugin action invoke update-major --plugin herdr.collie" : "collie update --major",
    };
  }
  return null;
}

export function UpdateBanner(handle: Handle<{ class?: string }>) {
  const readSnapshot = useStore(handle, snapshot);
  useLocale(handle);
  let copied = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  handle.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });

  const copy = async (command: string): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(command);
    } catch {
      // Clipboard blocked (insecure context / denied): the command stays readable regardless.
      return;
    }
    if (handle.signal.aborted) return;
    copied = true;
    scheduleUpdate(handle);
    clearTimeout(timer);
    timer = setTimeout(() => {
      copied = false;
      scheduleUpdate(handle);
    }, 1500);
  };

  return () => {
    const notice = updateNotice(readSnapshot().data?.update);
    return (
      <Collapse open={notice !== null}>
        {notice === null ? null : (
          <div
            data-testid="update-banner"
            class={cn("text-center text-[11px] leading-relaxed text-muted-foreground", handle.props.class)}
          >
            {notice.href ? (
              <a
                href={notice.href}
                target="_blank"
                rel="noopener noreferrer"
                class="font-medium text-status-working underline decoration-dotted underline-offset-2"
              >
                {notice.line}
              </a>
            ) : (
              <span class="font-medium text-status-working">{notice.line}</span>
            )}
            {notice.command ? (
              <>
                {" · "}
                <button
                  type="button"
                  aria-label={t("settings.updateBanner.copyAria", { command: notice.command })}
                  mix={on("click", () => {
                    if (notice.command) void copy(notice.command);
                  })}
                  class="inline-flex items-center gap-1 align-middle rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                >
                  <code>{notice.command}</code>
                  <Icon icon={copied ? Check : Copy} class={copied ? "size-3 text-status-working" : "size-3 opacity-60"} />
                </button>
              </>
            ) : null}
          </div>
        )}
      </Collapse>
    );
  };
}
