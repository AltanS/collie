// The connection strip, the host-stale banner and the read-only banner
// (web/src/components/connection-banner.tsx, host-stale-banner.tsx, read-only-banner.tsx).
//
// THE STRIP is the app's ONE connection surface, a band slot (`shell/strip-model.ts`) drawn by the
// strip host above the header. Like the update ribbon it renders NOTHING in place: `ConnectionBanner`
// is a leaf the Shell mounts once, it subscribes to what it reads, and it drives its slot after each
// commit. Four states, all web's:
//   - amber  "Reconnecting..." once not live for 4 s (static Plug, no spinner; the mark carries the
//            motion). DEGRADED priority.
//   - red    "Can't reach Collie" (cause by probe, dated "last seen HH:MM") at 15 s, with Retry (a
//            spinner while retrying) and Reload. OUTAGE priority.
//   - green  "Connected" for 1.8 s after a SHOWN bar recovers; a blip that never showed a bar
//            recovers silently. DEGRADED priority.
//   - auth   a 401 or 403 on the snapshot: the loudest fact, AUTH priority, a sign-in link and a
//            reload. It has no clock and no probe: a refusal is not an outage.
// The tone clock is `shell/connection-state.ts`, the one the mark and the splash read, so strip and
// mark can never disagree.
//
// THE HOST-STALE BANNER is the pane's tier-2 surface (the lead is fine, this pane's MACHINE is not);
// the pane screen mounts it. THE READ-ONLY BANNER is home's and the space's: a refused write gate
// (the bridge's device allowlist, or this device not paired) as a Collapse over a strip notice.
import { on, type Handle, type RemixNode } from "remix/component";
import { CheckCircle2, ChevronRight, KeyRound, Loader2, Lock, LogIn, Plug, RefreshCw, RotateCw, ServerOff, TriangleAlert, WifiOff } from "lucide";
import type { IconNode } from "lucide";

import { mounted } from "@web/lib/base-path";
import { clockTime } from "@web/lib/format";
import type { HostHealth } from "@web/lib/host-health";
import { t } from "@web/lib/i18n";
import { pairedDevicesPath } from "@web/lib/nav";
import { PROXY_AUTH_PATH } from "@web/lib/sw-routes";
import { isReadOnly } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { crewOf, hostWriteBlock } from "../chips/crew";
import { fetchConfig } from "../lib/api";
import { address, snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { pairing } from "../lib/pairing";
import { refreshNow } from "../lib/polling";
import { scheduleUpdate, useStore } from "../lib/store";
import { goDown } from "../routes/frame/up";
import { reloadDocument } from "../update/pwa";
import { Button, buttonVariants } from "../ui/button";
import { Collapse } from "../ui/collapse";
import { Icon } from "../ui/icon";
import { Notice, NOTICE_ACTION, NOTICE_ACTION_TAP, type NoticeTone } from "../ui/notice";
import { stripsOf } from "./context";
import { connection } from "./connection-state";
import { AUTH, DEGRADED, OUTAGE } from "./strip-model";

/** How long the "Connected" confirmation lingers after a visible bar recovers (web's GREEN_MS). */
export const GREEN_MS = 1_800;

/** /api/config probes the lead's HTTP surface, never a member or a mux. */
export type Probe = "unknown" | "reachable" | "unreachable";
export type Tone = "amber" | "red" | "green";

export interface StripView {
  copy: string;
  icon: IconNode;
  tone: NoticeTone;
}

/**
 * The strip's sentence, icon and colour for a tone (web's `resolveView`). A config answer proves
 * HTTP reachability; only a fresh, lead-scoped snapshot can also prove the mux is disconnected.
 * Red also DATES what is on screen when it can, because a herd drawn from cache looks live undated.
 */
export function resolveView(
  tone: Tone,
  online: boolean,
  probe: Probe,
  muxDisconnected: boolean,
  memberFault: string | undefined,
  lastSeenAt?: number,
): StripView {
  if (tone === "green") return { copy: t("connection.connected"), icon: CheckCircle2, tone: "success" };
  if (tone === "amber") return { copy: t("connection.reconnecting"), icon: Plug, tone: "caution" };
  if (probe === "reachable" && !muxDisconnected && memberFault !== undefined) {
    return { copy: memberFault, icon: TriangleAlert, tone: "danger" };
  }
  const cause =
    probe === "reachable" && muxDisconnected
      ? { copy: t("connection.herdrDown"), icon: TriangleAlert }
      : probe === "unreachable" && !online
        ? { copy: t("connection.offlineCantReach"), icon: WifiOff }
        : { copy: t("connection.cantReach"), icon: TriangleAlert };
  const copy =
    lastSeenAt === undefined ? cause.copy : t("connection.withLastSeen", { cause: cause.copy, time: clockTime(lastSeenAt) });
  return { copy, icon: cause.icon, tone: "danger" };
}

/** What the live signals want on screen: red wins over amber, null is healthy. Green is timed, not derived. */
export function activeTone(trouble: boolean, lost: boolean): Exclude<Tone, "green"> | null {
  return lost ? "red" : trouble ? "amber" : null;
}

export function ConnectionBanner(handle: Handle) {
  useLocale(handle);
  const slot = stripsOf(handle).slot(handle.signal);
  const readSnapshot = useStore(handle, snapshot);

  let tone: Tone | null = null;
  // Has an amber or red bar actually been shown since the last time it went hidden? It gates the
  // green flash, so a sub-trouble blip recovers silently.
  let shownBar = false;
  let greenTimer: ReturnType<typeof setTimeout> | undefined;
  let probe: Probe = "unknown";
  let retrying = false;
  let wasLost = false;
  // What the band draws, and the counter that tells the model it changed.
  let drawn: { tone: Tone | "auth"; view: StripView | null } | null = null;
  let drawnKey = "";
  let rev = 0;
  handle.signal.addEventListener("abort", () => clearTimeout(greenTimer), { once: true });

  const setTone = (next: Tone | null): void => {
    if (next === tone) return;
    tone = next;
    scheduleUpdate(handle);
  };

  const runProbe = async (): Promise<void> => {
    try {
      await fetchConfig(address.get().scope, handle.signal);
      if (!handle.signal.aborted) probe = "reachable";
    } catch {
      if (!handle.signal.aborted) probe = "unreachable";
    }
  };

  const follow = (): void => {
    const { trouble, lost } = connection.state;
    // Probe HTTP reachability only while red; reset on recovery so a later outage probes again.
    if (lost !== wasLost) {
      wasLost = lost;
      if (lost) void runProbe().then(() => scheduleUpdate(handle));
      else probe = "unknown";
    }
    const active = activeTone(trouble, lost);
    if (active !== null) {
      shownBar = true;
      clearTimeout(greenTimer);
      setTone(active);
      return;
    }
    if (!shownBar) {
      setTone(null);
      return;
    }
    // Recovery from a visible bar: a brief green "connected", then hide.
    shownBar = false;
    setTone("green");
    clearTimeout(greenTimer);
    greenTimer = setTimeout(() => setTone(null), GREEN_MS);
  };

  handle.queueTask(() => {
    connection.subscribe(follow, handle.signal);
    window.addEventListener("online", () => scheduleUpdate(handle), { signal: handle.signal });
    window.addEventListener("offline", () => scheduleUpdate(handle), { signal: handle.signal });
    follow();
  });

  // Retry nudges recovery along: poll now and probe again. A live poll flips the signals by itself.
  const onRetry = async (): Promise<void> => {
    retrying = true;
    scheduleUpdate(handle);
    await Promise.all([refreshNow(), runProbe()]);
    if (handle.signal.aborted) return;
    retrying = false;
    scheduleUpdate(handle);
  };

  // Made ONCE. The band calls it whenever it draws; it reads what the last `show` committed.
  const render = (): RemixNode => {
    const strip = drawn;
    if (strip === null) return null;
    if (strip.tone === "auth") {
      return (
        <div data-testid="connection-strip" data-state="auth">
          <Notice
            tone="danger"
            variant="strip"
            announce="alert"
            icon={<Icon icon={TriangleAlert} />}
            action={
              <>
                {/* An <a>, not a button: an ordinary navigation the service worker sees as one. A
                    reload alone cannot reach a fronting proxy from an installed PWA. */}
                <a href={mounted(PROXY_AUTH_PATH)} class={cn(buttonVariants({ size: "sm" }), "h-6 gap-1 px-2 text-xs no-underline", NOTICE_ACTION_TAP)}>
                  <Icon icon={LogIn} class="size-3.5" />
                  {t("connection.auth.signIn")}
                </a>
                <Button size="icon" variant="ghost" aria-label={t("connection.reload.aria")} class={cn("size-6 text-muted-foreground", NOTICE_ACTION_TAP)} mix={on("click", reloadDocument)}>
                  <Icon icon={RefreshCw} class="size-3.5" />
                </Button>
              </>
            }
          >
            {t("connection.auth.message")}
          </Notice>
        </div>
      );
    }
    const view = strip.view;
    if (view === null) return null;
    return (
      <div data-testid="connection-strip" data-state={strip.tone}>
        <Notice
          tone={view.tone}
          variant="strip"
          // Red is an actionable error (assertive); amber and green are ambient.
          announce={strip.tone === "red" ? "alert" : "status"}
          icon={<Icon icon={view.icon} />}
          // Actions only in red: amber is ambient, green is a passing confirmation.
          action={
            strip.tone === "red" ? (
              <>
                <Button size="sm" class={NOTICE_ACTION} disabled={retrying} data-testid="connection-retry" mix={on("click", () => void onRetry())}>
                  <Icon icon={retrying ? Loader2 : RotateCw} class={cn("size-3.5", retrying && "animate-spin")} />
                  {t("connection.retry")}
                </Button>
                <Button size="icon" variant="ghost" aria-label={t("connection.reload.aria")} class={cn("size-6 text-muted-foreground", NOTICE_ACTION_TAP)} mix={on("click", reloadDocument)}>
                  <Icon icon={RefreshCw} class="size-3.5" />
                </Button>
              </>
            ) : undefined
          }
        >
          {view.copy}
        </Notice>
      </div>
    );
  };

  return () => {
    const loaded = readSnapshot();
    const refused = loaded.status === 401 || loaded.status === 403;
    let next: { tone: Tone | "auth"; view: StripView | null } | null = null;
    let priority = DEGRADED;
    if (refused) {
      next = { tone: "auth", view: null };
      priority = AUTH;
    } else if (tone !== null) {
      const crew = crewOf(loaded.data);
      const host = address.get().scope.host;
      const bridge = loaded.data?.bridge;
      const muxDisconnected = loaded.error === undefined && bridge === "disconnected" && (host === undefined || host === crew.lead);
      // A member view with a lead that still answers: the lead's own snapshot says whether that
      // member is down. Read only to NAME the cause; it feeds no clock and no latch.
      const memberFault = host !== undefined && host !== crew.lead ? hostWriteBlock(crew, host) : undefined;
      next = {
        tone,
        view: resolveView(tone, navigator.onLine, probe, muxDisconnected, memberFault, loaded.at === 0 ? undefined : loaded.at),
      };
      priority = tone === "red" ? OUTAGE : DEGRADED;
    }
    const key = next === null ? "" : JSON.stringify([next.tone, next.view?.copy ?? null, retrying]);
    if (key !== drawnKey) {
      drawnKey = key;
      rev++;
    }
    const nowRev = rev;
    // The band's model is written after commit, never during render.
    handle.queueTask(() => {
      drawn = next;
      if (next === null) slot.hide();
      else slot.show({ priority, render, rev: nowRev });
    });
    return null;
  };
}

// ── The host-stale banner ────────────────────────────────────────────────────────────────────────

/**
 * Tier 2: the lead is fine, this pane's MACHINE is not. Scoped to the pane, informational (sky, not
 * red: the content below is real, it is just not current). The table is web's: `state` decides
 * whether this surface speaks at all (one missed sweep must not flash a banner), `writable` decides
 * what it says. A merely old receipt on a machine the lead still believes up says nothing.
 */
export function hostStaleSpeaks(health: HostHealth | undefined): boolean {
  if (!health || health.state === "live") return false;
  return health.incompatible === true || !health.writable || health.state === "unknown";
}

export function HostStaleBanner(handle: Handle<{ health: HostHealth | undefined; class?: string }>) {
  useLocale(handle);
  return () => {
    const { health, class: className } = handle.props;
    if (!health || !hostStaleSpeaks(health)) return null;
    const nothingCached = health.state === "unknown";
    const reason = health.incompatible
      ? t("connection.stale.incompatible", { name: health.name })
      : t("connection.stale.unreachable", { name: health.name, label: health.lastSeenLabel });
    const detail = nothingCached ? t("connection.stale.nothingCached") : t("connection.stale.showingLastKnown");
    // The one case with nothing to refuse and nothing to show: one waiting sentence, no refusal claim.
    const message =
      nothingCached && health.writable
        ? t("connection.stale.waitingFirst", { name: health.name })
        : t("connection.stale.messageTemplate", { reason, detail });
    return (
      <output
        data-testid="host-stale"
        class={cn(
          "flex items-start gap-2 rounded-sm border border-status-info/40 bg-status-info/15 px-4 py-2 text-xs font-medium text-status-info",
          className,
        )}
      >
        <Icon icon={ServerOff} class="mt-px size-3.5 shrink-0" />
        <span>
          {message}
          {health.incompatible && health.protocolDetail ? ` ${health.protocolDetail}` : ""}
        </span>
      </output>
    );
  };
}

// ── The read-only banner ─────────────────────────────────────────────────────────────────────────

/**
 * "You can look, but you can't type", for both write gates. The pairing latch outranks the device
 * gate: only it names a remedy the phone can carry out, so only it is tappable (the Paired devices
 * card). It sits below the header as CONTENT, so it is a Collapse: the strip slides shut on the very
 * sentence that explained it. Renders nothing when neither gate refuses.
 */
export function ReadOnlyBanner(handle: Handle) {
  useLocale(handle);
  const readSnapshot = useStore(handle, snapshot);
  const readPairing = useStore(handle, pairing);
  return () => {
    const device = readSnapshot().data?.device;
    const gate = readPairing().refused ? "pairing" : isReadOnly(device) ? "device" : null;
    return (
      <Collapse open={gate !== null}>
        {gate === "pairing" ? (
          <div data-testid="read-only-banner" data-gate="pairing">
            <Notice
              variant="strip"
              tone="caution"
              announce="status"
              icon={<Icon icon={KeyRound} />}
              action={<Icon icon={ChevronRight} class="size-3.5 opacity-70" />}
              onActivate={() => goDown(pairedDevicesPath(address.get().scope))}
            >
              {t("space.readOnly.notPaired")}
            </Notice>
          </div>
        ) : gate === "device" ? (
          <div data-testid="read-only-banner" data-gate="device">
            <Notice variant="strip" tone="caution" announce="status" icon={<Icon icon={Lock} />}>
              {t("space.readOnly.deviceUnauthorised")}
            </Notice>
          </div>
        ) : null}
      </Collapse>
    );
  };
}
