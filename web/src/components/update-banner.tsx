import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { UpdateInfo } from "@/lib/types";
import { useOptionalRootData } from "@/lib/route-data";

// The footer "update available" chip, sitting next to the build stamp. It reads the snapshot's
// optional `update` field (surfaced on the root loader data) and, when there's something to do,
// names it with the one command that fixes it. Everything renders as plain React text nodes.

export interface UpdateNotice {
  /** The human line, e.g. "Bridge restart needed" / "Collie 0.12.0 available". */
  line: string;
  /** A copyable command that resolves it — a Herdr plugin action, so it runs from ANY directory
   *  (Herdr resolves the plugin's checkout). Only the RESTART case carries one: it has no page to link
   *  to. The release case sends you to `href` instead, where the release notes carry the commands. */
  command?: string;
  /** GitHub release page for the available version — the line links to it. Absent for the restart case. */
  href?: string;
}

/**
 * Decide what (if anything) the footer should nudge, from the snapshot's `update`. Precedence: a
 * stale running PROCESS outranks an available release — restarting is the cheaper, more urgent fix,
 * and a release upgrade restarts the service anyway. `null` = nothing to say (an older bridge omits
 * `update`, or you're current). Kept pure and exported so the precedence is unit-tested directly.
 */
export function updateNotice(update: UpdateInfo | undefined): UpdateNotice | null {
  if (!update) return null;
  if (update.bridgeStale) {
    // No release page for "restart needed" — show the Herdr restart action to copy.
    return {
      line: t("settings.updateBanner.restart"),
      command: "herdr plugin action invoke restart --plugin herdr.collie",
    };
  }
  // Guard on `latest` too: without a version string there's nothing meaningful to name. The release
  // page (linked) carries the update commands, so the footer just links there.
  if (update.releaseAvailable && update.latest) {
    return {
      line: t("settings.updateBanner.releaseAvailable", { version: update.latest }),
      href: update.latestUrl ?? undefined,
    };
  }
  // A MAJOR is out. It ranks below a routine release because it is the one thing the plain update
  // action will NOT take (ADR 0020) — so this line names the consent command instead of leaving the
  // operator to tap update, see it succeed, and still see a banner.
  if (update.majorAvailable) {
    return {
      line: t("settings.updateBanner.majorAvailable", { version: update.majorAvailable }),
      href: update.majorUrl ?? undefined,
      command: "herdr plugin action invoke update-major --plugin herdr.collie",
    };
  }
  return null;
}

export function UpdateBanner({ className }: { className?: string }) {
  useLocale();
  const data = useOptionalRootData();
  const notice = updateNotice(data?.update);
  const [copied, setCopied] = useState(false);

  if (!notice) return null;

  async function copy() {
    if (!notice?.command) return;
    try {
      await navigator.clipboard?.writeText(notice.command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / denied) — the command stays readable regardless.
    }
  }

  return (
    <div
      className={cn(
        "text-center text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {notice.href ? (
        // Links to the GitHub release page for the available version (its notes carry the update
        // commands). External navigation — new tab.
        <a
          href={notice.href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-status-working underline decoration-dotted underline-offset-2"
        >
          {notice.line}
        </a>
      ) : (
        <span className="font-medium text-status-working">{notice.line}</span>
      )}
      {notice.command ? (
        <>
          {" · "}
          <button
            type="button"
            onClick={copy}
            aria-label={t("settings.updateBanner.copyAria", { command: notice.command })}
            className="inline-flex items-center gap-1 align-middle rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
          >
            <code>{notice.command}</code>
            {copied ? (
              <Check className="size-3 text-status-working" />
            ) : (
              <Copy className="size-3 opacity-60" />
            )}
          </button>
        </>
      ) : null}
    </div>
  );
}
