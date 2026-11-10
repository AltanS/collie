import { useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { NOTICE_ACTION, Notice } from "@/components/ui/notice";

import { useLocale } from "@/hooks/use-locale";
import { useBundleApply, type BundleApply } from "@/lib/bundle-apply";
import { t } from "@/lib/i18n";
import { checkForUpdate, getPrecacheProgress, subscribePrecacheProgress, type PrecacheProgress } from "@/lib/pwa";
import { isReloadHeld, subscribeReloadHeld } from "@/lib/reload-guard";
import { cn } from "@/lib/utils";
import type { UpdateInfo } from "@/lib/types";
import { useOptionalRootData } from "@/lib/route-data";

// The footer "update available" chip, sitting next to the build stamp. It reads the snapshot's
// optional `update` field (surfaced on the root loader data) and, when there's something to do,
// names it with the one command that fixes it. Everything renders as plain React text nodes.
//
// ── THE APP BUNDLE, FIRST (2026-11-06) ───────────────────────────────────────
// While a new app build is being applied on this phone the header mark turns in the update colour,
// and a tap on it lands here (`components/app-header.tsx`). So this line says what the mark means,
// ahead of anything about Collie on the host: "downloading" with how far, or "tap to update" when the
// new build is in and waiting. These are the two lines the strip band used to carry, and the
// download line also shows on the automatic lane, where the band said nothing (`lib/bundle-apply.ts`
// says when a download counts). The download
// outranks the release lines because it is happening now and is the answer the tap came for; a
// release offer is still standing when it is done.

/**
 * HOW THE LINE LOOKS WHILE A NEW APP BUILD IS BEING APPLIED (2026-11-09). Altan: the line must be
 * more apparent, "maybe an orange background or ribbon visual without being fixed". Three looks, all
 * in flow at the line's own place, all in the status "working" tone (`Notice`'s `caution`):
 *
 *   band        the line on a full-width band, a soft working-tone ground with a rule above and below
 *   card        an inset box with an edge on all four sides, and the reload as a real button
 *   band-pulse  the band, plus one highlight when the mark's tap brings it into view
 *
 * ONE constant, so the pick is a one-line change. Every other state of the line looks as before.
 */
export type UpdateLineLook = "band" | "card" | "band-pulse";
// Altan picked the card on 2026-11-09 (option 7 on the comparison page).
export const UPDATE_LINE_LOOK: UpdateLineLook = "card";

/** How long the arrival highlight of `band-pulse` lasts, in milliseconds. It runs once and ends. */
export const UPDATE_LINE_PULSE_MS = 1200;

/**
 * Bring the update line into view, the way the header mark's tap asks for it (`routes/home.tsx`).
 * Centred, because the New button floats over the foot of the list. Under `band-pulse` the band then
 * lights up once: a Web Animation with one iteration and no fill, so it is gone when it ends and no
 * animation is left running (issue 748). Under reduced motion there is no highlight.
 */
export function arriveAtUpdateLine(el: HTMLElement | null, look: UpdateLineLook = UPDATE_LINE_LOOK): void {
  if (el === null) return;
  el.scrollIntoView({ block: "center" });
  if (look !== "band-pulse") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true) return;
  const band = el.querySelector<HTMLElement>('[data-slot="notice"]');
  if (band === null || !("animate" in band)) return;
  const ground = getComputedStyle(band).backgroundColor;
  band.animate(
    [{ backgroundColor: "color-mix(in oklab, var(--status-working) 45%, transparent)" }, { backgroundColor: ground }],
    { duration: UPDATE_LINE_PULSE_MS, easing: "ease-out" },
  );
}

export interface UpdateNotice {
  /** The human line, e.g. "Bridge restart needed" / "Collie 0.12.0 available". */
  line: string;
  /** A copyable command that resolves it, spelled for the install kind — the Herdr plugin action on a
   *  Herdr-managed checkout (Herdr resolves the plugin's checkout, so it runs from ANY directory), the
   *  `collie` verb everywhere else. Only the RESTART and MAJOR cases carry one; the release case sends
   *  you to `href` instead, where the release notes carry the commands. A `packaged` install
   *  carries one on RESTART only — it never updates itself, so there is no update command to give. */
  command?: string;
  /** GitHub release page for the available version — the line links to it. Absent for the restart case. */
  href?: string;
  /** The line is a button that reloads THIS PAGE onto the new app build (`checkForUpdate()`). Only the
   *  bundle's `ready` line carries it: a bundle that is in is the one thing a tap here can apply. */
  reload?: true;
  /** A second, quieter sentence after the line: how far a download is, or that the page reloads on
   *  its own. */
  detail?: string;
}

/** What the app bundle is doing, for {@link updateNotice}. The two client facts beside the stage. */
export interface BundleFacts {
  stage: BundleApply;
  /** The precache's file count, or null before the worker's first message. */
  progress: Pick<PrecacheProgress, "done" | "total"> | null;
  /** A reload hold is active (`lib/reload-guard.ts`): the self-updater reloads the page as soon as it
   *  clears. False means it will not reload by itself (it already spent its one automatic reload on
   *  this build), so the line must not promise that it will. */
  reloadHeld: boolean;
}

/** Whole per cent of the precache that has landed, or null when there is no count to divide. */
export function bundlePercent(progress: BundleFacts["progress"]): number | null {
  if (progress === null || progress.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.floor((progress.done / progress.total) * 100)));
}

function bundleNotice(bundle: BundleFacts): UpdateNotice | null {
  if (bundle.stage === "installing") {
    const notice: UpdateNotice = { line: t("pwa.updateInstalling") };
    const percent = bundlePercent(bundle.progress);
    if (percent !== null) notice.detail = t("settings.updateBanner.bundleProgress", { percent });
    return notice;
  }
  if (bundle.stage === "ready") {
    const notice: UpdateNotice = { line: t("pwa.updateAvailable"), reload: true };
    if (bundle.reloadHeld) notice.detail = t("settings.updateBanner.bundleReloads");
    return notice;
  }
  return null;
}

/**
 * Decide what (if anything) the footer should nudge, from the snapshot's `update` and this phone's
 * own bundle. Precedence: the app bundle being applied first (see the header), then a stale running
 * PROCESS over an available release — restarting is the cheaper, more urgent fix, and a release
 * upgrade restarts the service anyway. `null` = nothing to say (an older bridge omits `update`, or
 * you're current). Kept pure and exported so the precedence is unit-tested directly.
 */
export function updateNotice(update: UpdateInfo | undefined, bundle?: BundleFacts): UpdateNotice | null {
  const applying = bundle === undefined ? null : bundleNotice(bundle);
  if (applying !== null) return applying;
  if (!update) return null;
  // The command spelling is a function of the install kind (M14/01 §5.3): Herdr's plugin actions
  // reach only a Herdr-managed (detached) checkout — on a binary install, a linked dev clone or an
  // unknown layout they name a plugin Herdr does not manage, so those get the `collie` verbs, which
  // work everywhere the CLI is on PATH. An absent kind is an older bridge from the git-install era,
  // which is read as Herdr-managed so the advice never regresses mid-upgrade.
  const herdrManaged = update.installKind === undefined || update.installKind === "detached-checkout";
  // A packaged install is the one kind that does not update itself at all: its root is not writable,
  // so `collie update` refuses there by design (ADR 0035). It therefore gets NO update command —
  // printing one would print the exact command that refuses. Restarting is still its own business
  // and `collie restart` works, because the binary is on PATH like any other packaged program.
  const selfUpdates = update.installKind !== "packaged";
  // A PACKAGE SWAP UNDER A LIVE PROCESS (M17/02). Above `bridgeStale` because it is the stronger
  // statement about the same machine: not "the source moved", but "the version on disk is no longer
  // the version running". The command is the HOST's own answer, spelled there from the install kind
  // — the phone renders it and never derives a second one.
  if (update.restartNeeded === true && update.restartCommand !== undefined) {
    return { line: t("settings.updateBanner.restartNeeded"), command: update.restartCommand };
  }
  if (update.bridgeStale) {
    // No release page for "restart needed" — show the one command that restarts it, to copy.
    return {
      line: t("settings.updateBanner.restart"),
      command: herdrManaged
        ? "herdr plugin action invoke restart --plugin herdr.collie"
        : "collie restart",
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
    const line = t("settings.updateBanner.majorAvailable", { version: update.majorAvailable });
    const href = update.majorUrl ?? undefined;
    // The major line still appears on a packaged install — that a major is out is worth knowing
    // however it gets taken — but it carries no command. Collie can see that its root is unwritable,
    // which is what makes the update someone else's; nothing on disk says WHOSE, so there is no
    // command it could honestly name in place of the one it must not print.
    if (!selfUpdates) return { line, href };
    return {
      line,
      href,
      command: herdrManaged
        ? "herdr plugin action invoke update-major --plugin herdr.collie"
        : "collie update --major",
    };
  }
  return null;
}

export function UpdateBanner({ className, ref }: { className?: string; ref?: Ref<HTMLDivElement> }) {
  useLocale();
  const data = useOptionalRootData();
  const stage = useBundleApply();
  const progress = useSyncExternalStore(subscribePrecacheProgress, getPrecacheProgress, getPrecacheProgress);
  const reloadHeld = useSyncExternalStore(subscribeReloadHeld, isReloadHeld, isReloadHeld);
  const notice = updateNotice(data?.update, { stage, progress, reloadHeld });
  if (!notice) return null;
  // A bundle stage outranks every release line (`updateNotice`), so while one is on, this notice is
  // the bundle's.
  return <UpdateNoticeLine notice={notice} applying={stage !== null} className={className} ref={ref} />;
}

/**
 * The line itself, for a notice already decided. Split from {@link UpdateBanner} so the playground
 * can draw the bundle's two lines from the real precedence without moving the app's own service
 * worker and self-updater stores, which every header on that page reads too.
 */
export function UpdateNoticeLine({
  notice,
  applying = false,
  look = UPDATE_LINE_LOOK,
  className,
  ref,
}: {
  notice: UpdateNotice;
  /** The notice is the app bundle's (downloading, or waiting for the reload): drawn in `look`. */
  applying?: boolean;
  /** Which look the bundle's line takes. The app passes nothing; the comparison page passes each. */
  look?: UpdateLineLook;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  const [copied, setCopied] = useState(false);
  if (applying) return <ApplyingLine notice={notice} look={look} className={className} ref={ref} />;

  async function copy() {
    if (!notice.command) return;
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
      ref={ref}
      className={cn(
        "text-center text-[11px] leading-relaxed text-muted-foreground",
        className,
      )}
    >
      {notice.reload ? (
        // The same path the build stamp's chip takes, and the band's old reload row before it. Never
        // disabled: a second tap on a download already under way only follows it (`lib/pwa.ts`).
        <button
          type="button"
          onClick={() => void checkForUpdate()}
          className="font-medium text-status-working underline underline-offset-2"
        >
          {notice.line}
        </button>
      ) : notice.href ? (
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
              <Icon name="copied" className="size-3 text-status-working" />
            ) : (
              <Icon name="copy" className="size-3 opacity-60" />
            )}
          </button>
        </>
      ) : null}
      {notice.detail === undefined ? null : (
        <>
          {" · "}
          <span>{notice.detail}</span>
        </>
      )}
    </div>
  );
}

/** The bundle's line and its detail, as words. The reload stays today's text button unless `card`. */
function ApplyingText({ notice, reloadAsText }: { notice: UpdateNotice; reloadAsText: boolean }): ReactNode {
  const line =
    notice.reload && reloadAsText ? (
      <button
        type="button"
        onClick={() => void checkForUpdate()}
        className="font-medium underline underline-offset-2"
      >
        {notice.line}
      </button>
    ) : (
      <span className="font-medium">{notice.line}</span>
    );
  return (
    <>
      {line}
      {notice.detail === undefined ? null : (
        <>
          {" · "}
          <span className="font-normal">{notice.detail}</span>
        </>
      )}
    </>
  );
}

/**
 * The bundle's line in the picked look ({@link UPDATE_LINE_LOOK}). In flow, at the line's own place:
 * never fixed, never sticky, nothing over the list. Both looks are the one `Notice` surface in its
 * `caution` tone, which is the status "working" tokens.
 */
function ApplyingLine({
  notice,
  look,
  className,
  ref,
}: {
  notice: UpdateNotice;
  look: UpdateLineLook;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}) {
  if (look === "card") {
    const action = notice.reload ? (
      <Button size="sm" variant="outline" className={NOTICE_ACTION} onClick={() => void checkForUpdate()}>
        {t("settings.updateBanner.updateNow")}
      </Button>
    ) : undefined;
    return (
      <div ref={ref} className={className}>
        <Notice tone="caution" variant="box" action={action}>
          <p>
            <ApplyingText notice={notice} reloadAsText={false} />
          </p>
        </Notice>
      </div>
    );
  }
  // The band runs edge to edge of the column, so the caller's side gutter goes and the band's own
  // padding takes its place. A rule above as well as the strip's own below: in the middle of the
  // footer a band needs both edges.
  return (
    <div ref={ref} className={cn(className, "px-0")}>
      <Notice tone="caution" variant="strip" wrap className="border-t">
        <ApplyingText notice={notice} reloadAsText />
      </Notice>
    </div>
  );
}
