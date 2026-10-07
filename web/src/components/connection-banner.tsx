import { useCallback, useEffect, useRef, useState } from "react";
import { useRevalidator } from "react-router";
import {
  CheckCircle2,
  CloudOff,
  Loader2,
  LogIn,
  Plug,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  WifiOff,
} from "lucide-react";

import { useCrew, useHostHealth } from "@/components/crew-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { Notice, NOTICE_ACTION, NOTICE_ACTION_TAP } from "@/components/ui/notice";
import { StripSlot } from "@/components/ui/strip-host";
import { AUTH, DEGRADED, OUTAGE } from "@/lib/strip-priority";
import { cn } from "@/lib/utils";
import { PROXY_AUTH_PATH } from "@/lib/sw-routes";
import { useConnectionLost, useConnectionTrouble } from "@/hooks/use-connection-lost";
import { useLoadingStalled } from "@/hooks/use-loading-stalled";
import { useOnline } from "@/hooks/use-online";
import { isConnecting } from "@/lib/connection";
import { clockTime, savedAtLabel } from "@/lib/format";
import { writeRefusal } from "@/lib/host-health";
import * as api from "@/lib/api";
import type { BridgeStatus } from "@/lib/types";
import { mounted } from "@/lib/base-path";
import { usePairing } from "@/lib/pairing";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface ConnectionBannerProps {
  /** Herdr link from the last snapshot (undefined before the first successful poll). */
  bridge: BridgeStatus | undefined;
  /** The machine being viewed. The snapshot's bridge field still belongs to the lead. */
  host?: string;
  /** The last snapshot fetch failed (stale data on screen). */
  error: boolean;
  /** The failed snapshot request was rejected with HTTP 401 or 403. */
  authError: boolean;
  /**
   * When the data on screen was last actually fetched, if it can be dated (lib/last-seen.ts). Shown in
   * the RED copy only, where it is the fact the operator most needs: a cold boot with no network
   * re-renders the herd from cache, and an undated old screen is indistinguishable from a live one.
   */
  lastSeenAt?: number;
  /**
   * What is on screen is the SAVED COPY (M46 spec 10, `HomeData.stale` / `PaneData.stale`): a cold
   * open before any live answer, or an outage the shared clock has latched. The strip then says so
   * at once, in one of two sentences (see {@link resolveView}), instead of waiting out the amber
   * and red escalation that exists to keep a blip quiet: a cold open with no bridge is not a blip.
   */
  stale?: boolean;
}

// /api/config probes the lead's HTTP surface, never a member or a mux.
type Probe = "unknown" | "reachable" | "unreachable";

// The three color-coded states, plus null = nothing. green = established, amber = checking, red = failed.
type Tone = "amber" | "red" | "green";

// How long the "Connected" confirmation lingers after a visible bar recovers, then it exits.
//
// This one is BUSINESS LOGIC and stays here: how long a confirmation is worth reading is a fact
// about what the operator is being told, not about how a row leaves the screen. The exit itself was
// this file's own (`EXIT_MS`, a delayed unmount through a hand-rolled 0fr↔1fr grid) and is now the
// band's — `ui/strip-host.tsx` keeps painting the last strip while `ui/collapse.tsx` closes it, on
// one duration shared with everything else in the app that moves in flow.
export const GREEN_MS = 1_800;

// The ONE connection surface: a single, thin bar in the band above the header — `ui/strip-host.tsx`,
// registered from here as a StripSlot — that is the app's entire connection UI; the header pill is
// gone. It appears only on SUSTAINED trouble, escalates from amber → red on a real outage, flashes
// green on recovery, and otherwise renders nothing. It reads the SAME two shared-clock signals
// the header dog does (useConnectionTrouble at 4s, useConnectionLost at 15s), so bar and dog can never
// disagree; `connecting` is poll-truth (isConnecting) — navigator.onLine is COPY-only (it picks the
// red cause), never a gate. Threshold lockstep with the shared clock is proven in use-connection-lost;
// here we own the amber→red→green state machine and nothing else.
//
// ONE SLOT, THREE TONES, TWO RANKS. The tone changes inside the slot the way it always did, and the
// slot's PRIORITY moves with it: a lost connection is `OUTAGE`, trouble and the recovery flash are
// `DEGRADED` (`lib/strip-priority.ts`). Green is not a fifth level — it is this same fact, resolved,
// and it outranks the update offer for the second it stands for exactly the reason amber does.
//
// THREE OFFLINE STATES, TOLD APART HERE AND NOWHERE ELSE (M46 spec 10, reworded in pass 3):
//   1. The phone says it is offline (`navigator.onLine` false): "You are offline. Showing what was
//      saved at …".
//   2. Any other failed read: "No connection to the bridge. Showing what was saved at …", with a
//      smaller second line, "Check your connection or Tailscale."
//   3. The bridge answered and refused this device (a 403 `device not paired` or `device expired`
//      while a token was held): the wipe has run, nothing kept is drawn, and the pair screen is the
//      answer. No connection strip at all, below.
// The first two draw the saved copy and date it by when it was fetched.
//
// WHY STATE 2 GUESSES NO CAUSE. `navigator.onLine` false is a fact, so state 1 may say "offline". True
// is not the opposite fact: a VPN (Tailscale on a phone) keeps a network interface up, so the flag
// stays true in airplane mode. From inside the page, "the phone has no network" and "the bridge or the
// tunnel is down" then look the same: a request that gets no answer. Telling them apart would take a
// probe to some third-party host, and Collie does not make one (ADR 0034: Collie collects nothing).
// So the sentence says only what is known, and the second line names both places to look. It used to
// say "Is Tailscale connected?", which read as a diagnosis on a phone that was simply offline.
//
// WHEN IT APPEARS, AND WHY IT DOES NOT FLAP (M46 pass 3). The saved-copy strip is red at once when the
// screen IS the saved copy (`stale`), and the screen becomes that on the read that proves the outage
// (lib/connection-health.ts `noteNetworkFailure` and `noteServerFailure`: the first read that got no
// answer, or the second 5xx in a row). It goes only on a live answer. Amber no longer stands in front
// of it: amber is kept for the one case where the bridge answers and says its multiplexer is down, so
// a failing read goes from nothing straight to the saved-copy strip, and a slow read (a stall) moves
// only the header dog. Every red variant reserves the height of the tallest one, so a change of
// sentence does not move the page.
export function ConnectionBanner({ bridge, host, error, authError, lastSeenAt, stale = false }: ConnectionBannerProps) {
  const { refused: notPaired } = usePairing();
  if (authError) return <AuthErrorBanner />;
  // Refused for want of pairing (ADR 0086: reads need the token). The bridge answered, so this is not
  // an outage, and the pairing strip on the route names the remedy. No connection strip at all.
  if (notPaired && error) return null;
  return (
    <ConnectionStateBanner bridge={bridge} host={host} error={error} lastSeenAt={lastSeenAt} stale={stale} />
  );
}

// A refusal is not an outage, so it gets its own surface ahead of the connection state machine: no
// probe, no reconnect spinner, no escalation clock. The copy stays deliberately non-specific about
// the cause. The flag covers 401 and 403 alike, and a 403 can equally mean "this device is not
// allowlisted", "host not allowed" or "cross-origin rejected", so naming any one of them would be
// wrong more often than right. What the operator needs here is the one fact the old behaviour hid:
// this is not the network.
//
// Reload alone is NOT enough to reach a fronting proxy, which is what this banner used to claim. In
// an installed PWA the service worker answers every navigation it owns — a reload included — from
// the precached app shell, so a reload re-renders the same refused UI and never touches the proxy.
// "Sign in" is the escape: a real navigation to the one path the SW always passes to the network
// (lib/sw-routes). An <a>, not a button, so it is an ordinary navigation the SW sees as such — and
// so it still works if React is wedged. Reload stays alongside it, since a merely stale session on
// an already-signed-in device recovers without leaving the app.
function AuthErrorBanner() {
  useLocale();
  return (
    // The loudest fact this app has, so it takes the band from anything else that wants it. One
    // announcement, not two: `announce="alert"` emits `role="alert"` and NOTHING beside it — the
    // `aria-live="polite"` that used to sit next to that role asked for assertive and polite at
    // once, which is the contradiction `ui/notice.tsx` exists to make unwritable.
    <StripSlot priority={AUTH}>
      <Notice
        tone="danger"
        variant="strip"
        announce="alert"
        icon={<TriangleAlert />}
        action={
          <>
            {/* An <a>, not a button, so it is an ordinary navigation the service worker sees as
                such — see this component's header for why a reload alone cannot reach the proxy. */}
            <a
              href={mounted(PROXY_AUTH_PATH)}
              className={cn(
                buttonVariants({ size: "sm" }),
                "h-6 gap-1 px-2 text-xs no-underline",
                NOTICE_ACTION_TAP,
              )}
            >
              <LogIn className="size-3.5" />
              {t("connection.auth.signIn")}
            </a>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t("connection.reload.aria")}
              className={cn("size-6 text-muted-foreground", NOTICE_ACTION_TAP)}
              onClick={() => window.location.reload()}
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </>
        }
      >
        {t("connection.auth.message")}
      </Notice>
    </StripSlot>
  );
}

function ConnectionStateBanner({
  bridge,
  host,
  error,
  lastSeenAt,
  stale = false,
}: Omit<ConnectionBannerProps, "authError">) {
  useLocale();
  const { lead } = useCrew();
  const memberHealth = useHostHealth(host);
  const stalled = useLoadingStalled();
  // Amber is the bridge ANSWERING that its multiplexer is down, and nothing else (see the header). A
  // failed read and a stall are left to `lost`: one failed read that proves nothing shows no strip at
  // all, and the read that does prove it shows the red one at once.
  const muxTrouble = !error && !stalled && bridge === "disconnected";
  const trouble = useConnectionTrouble(muxTrouble);
  // Red waits for a read that has FAILED, not one that is merely slow. The latch is set inside the
  // failing herd read, a beat before the loader hands over the saved copy; counting the stall here
  // drew one frame of "Can't reach Collie" before the saved-copy sentence replaced it, a jump in
  // height measured at 390px. The poll deadline (lib/api.ts POLL_TIMEOUT_MS) turns a stall into a
  // failure within 6s anyway, and the header dog still gallops on the stall.
  const lost = useConnectionLost(isConnecting({ bridge, error }));

  // What the live signals want on screen right now — red wins over amber; null = healthy (or a blip
  // that never reached trouble). Green is NOT derived here: it's a timed confirmation the state machine
  // adds only when a VISIBLE bar recovers, so it can't come from the instantaneous signals.
  //
  // A saved copy on screen is red at once (see `stale`): the escalation clock exists to keep a blip
  // quiet, and a herd drawn from the store is already past being one. Recovery from it flashes green
  // like any other visible bar.
  const activeTone: Exclude<Tone, "green"> | null = stale || lost ? "red" : trouble ? "amber" : null;

  // The rendered tone. Adds the recovery "connected" flash on top of the live signals.
  const [tone, setTone] = useState<Tone | null>(null);
  // Has an amber/red bar actually been shown since the last time we went hidden? Gates the green flash
  // so a sub-trouble blip (which never showed a bar) recovers silently.
  const shownBar = useRef(false);

  useEffect(() => {
    if (activeTone) {
      shownBar.current = true;
      setTone(activeTone);
      return;
    }
    // activeTone === null → recovered, or never troubled.
    if (!shownBar.current) {
      setTone(null); // a blip that never showed a bar → show nothing.
      return;
    }
    // Recovery FROM a visible bar → a brief green "connected", then hide.
    shownBar.current = false;
    setTone("green");
    const id = window.setTimeout(() => setTone(null), GREEN_MS);
    return () => clearTimeout(id);
  }, [activeTone]);

  // NO EXIT MACHINERY HERE ANY MORE. This component used to run its own delayed unmount, its own
  // 0fr↔1fr grid and its own `shownToneRef` ghost so the row could animate out with its copy
  // intact. All three are the band's now: `ui/collapse.tsx` holds the last non-empty children for
  // the whole exit and `ui/strip-host.tsx` keeps painting the last strip while the band closes. Two
  // collapse mechanisms on one row would fight — this one would unmount the slot before the band
  // had finished closing over it — so what is left here is the state machine and nothing else:
  // there is a tone, or there is no slot.
  //
  // Probe HTTP reachability only while red. Reset on recovery so a later outage re-probes.
  const online = useOnline();
  const revalidator = useRevalidator();
  const [probe, setProbe] = useState<Probe>("unknown");
  const [retrying, setRetrying] = useState(false);

  const runProbe = useCallback(async () => {
    try {
      await api.fetchConfig();
      setProbe("reachable");
    } catch {
      setProbe("unreachable");
    }
  }, []);

  useEffect(() => {
    if (!lost) {
      setProbe("unknown");
      return;
    }
    void runProbe();
  }, [lost, runProbe]);

  if (tone === null) return null;

  // Recovery (a successful poll) flips the signals → tone → hidden on its own, no reload. Retry just
  // nudges that along: revalidate the snapshot and re-run the probe.
  async function onRetry() {
    setRetrying(true);
    revalidator.revalidate();
    await runProbe();
    setRetrying(false);
  }

  const muxDisconnected = !error && bridge === "disconnected" && (host === undefined || host === lead);
  // A member view with a lead that still answers: the lead's own last snapshot already says whether
  // that member is down, and the sentence for it exists (`connection.stale.*`, the one the pane
  // notice and a refused write use). Read only to NAME the cause; it feeds no clock and no latch.
  const memberFault = host !== undefined && host !== lead ? writeRefusal(memberHealth) : undefined;
  const view = resolveView(tone, online, probe, muxDisconnected, memberFault, lastSeenAt, stale);

  return (
    // A lost connection outranks trouble, and both outrank the update offer. Green rides at
    // DEGRADED with amber: it is the same fact resolved, not a level of its own.
    <StripSlot priority={tone === "red" ? OUTAGE : DEGRADED}>
      <Notice
        tone={view.tone}
        variant="strip"
        // Red is an actionable error (assertive); amber and green are ambient. One attribute either
        // way — the `aria-live="polite"` that used to sit beside the role is gone, and cannot come
        // back: `ui/notice.tsx` has no way to spell a role and a liveness at the same time.
        announce={view.tone === "danger" ? "alert" : "status"}
        icon={<view.Icon />}
        // The saved-copy sentence names the cause and the saved time, and both matter: at 390px
        // beside Retry it truncated mid-word. It wraps to a second line instead.
        wrap={view.saved}
        // ONE HEIGHT FOR EVERY RED VARIANT (M46 pass 3). The strip flipped between one, two and three
        // lines as its sentence changed, and every flip moved the page under the operator's thumb.
        // Red reserves the tallest variant's height (see RED_MIN_HEIGHT), so a change of sentence
        // changes words and nothing else.
        className={tone === "red" ? RED_MIN_HEIGHT : undefined}
        // Actions only in red — amber is ambient (no buttons), green is a passing confirmation.
        action={
          tone === "red" ? (
            <>
              <Button
                size="sm"
                // `whitespace-nowrap`: Retry is one word on one line, whatever the sentence beside it.
                className={cn(NOTICE_ACTION, "whitespace-nowrap")}
                onClick={onRetry}
                disabled={retrying}
              >
                {retrying ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCw className="size-3.5" />
                )}
                {t("connection.retry")}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t("connection.reload.aria")}
                className={cn("size-6 text-muted-foreground", NOTICE_ACTION_TAP)}
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </>
          ) : undefined
        }
      >
        {view.hint === undefined ? (
          view.copy
        ) : (
          <>
            {view.copy}
            {/* The second line: smaller and quieter, because it is advice, not the state. */}
            <span data-slot="connection-hint" className="block text-[11px] font-normal text-muted-foreground">
              {view.hint}
            </span>
          </>
        )}
      </Notice>
    </StripSlot>
  );
}

/**
 * The red strip's reserved height: four 16px lines (`text-xs`; the hint's smaller type keeps the same
 * line) and the strip's own 8px of padding. That is the tallest variant at 390px beside Retry and
 * Reload: the "no connection" sentence on three lines and the hint under it, measured 2026-10-07.
 * Every red variant takes it, so the strip does not change height while the outage changes its words.
 * A longer translation may still grow it; nothing shrinks it.
 */
const RED_MIN_HEIGHT = "min-h-[72px]";

// A config response proves HTTP reachability. Only a fresh, lead-scoped snapshot can also prove
// the mux is disconnected. Member snapshots retain the lead's mux status, not the member's.
//
// Red also DATES what's on screen when it can ("… — last seen 14:32"). That matters most in the case
// this whole path exists for: a PWA the browser discarded, reopened with the tunnel still down, has a
// full herd on screen rendered from cache. Without the stamp it looks live. The cause wording is kept
// rather than replaced by a flat "Disconnected", because "Herdr is down on the host" is a different
// (and more actionable) fact than "we can't reach Collie", and both can be undated or dated.
//
// The three tones are `ui/notice.tsx`'s and name the SAME three tokens this file used to mix for
// itself: `success` is `--status-done`, `caution` is `--status-working`, `danger` is
// `--status-blocked`. Nothing here changed colour; the recipe moved to the one table allowed to
// hold it, which is what stops the next banner drifting an alpha.
function resolveView(
  tone: Tone,
  online: boolean,
  probe: Probe,
  muxDisconnected: boolean,
  memberFault: string | undefined,
  lastSeenAt?: number,
  stale = false,
) {
  if (tone === "green") {
    return { copy: t("connection.connected"), Icon: CheckCircle2, tone: "success", saved: false, hint: undefined } as const;
  }
  if (tone === "amber") {
    // Static Plug (no spinner) — the galloping dog carries the motion, and a spinner would fight
    // prefers-reduced-motion. Ambient by design.
    return { copy: t("connection.reconnecting"), Icon: Plug, tone: "caution", saved: false, hint: undefined } as const;
  }
  // The lead answered, so the fault is one it can name. A mux that is down belongs to the machine
  // being viewed only when that machine is the lead (or there is no crew); on a member the lead's
  // own `bridge` says nothing, and what the lead knows about that member is its health. The member's
  // sentence carries its own "last seen", so it is not dated a second time below.
  if (probe === "reachable" && !muxDisconnected && memberFault !== undefined) {
    return { copy: memberFault, Icon: TriangleAlert, tone: "danger", saved: false, hint: undefined } as const;
  }
  // THE SAVED COPY, in the quiet tone: it is not an error state, it is the screen the operator left,
  // dated (M46 spec 10). `online` false is the phone's own fact and needs no probe. Anything else is
  // ONE sentence that guesses no cause, with the places to look on a second line: a VPN keeps
  // `navigator.onLine` true in airplane mode, so "offline" and "bridge down" cannot be told apart
  // from here without a probe to a third-party host, which Collie never makes (ADR 0034; see the
  // header). A probe that says the bridge DOES answer HTTP falls through to the named cause below,
  // because "no connection" would then be false.
  if (stale && lastSeenAt !== undefined && probe !== "reachable") {
    const time = savedAtLabel(lastSeenAt);
    return online
      ? ({
          copy: t("connection.saved.noBridge", { time }),
          hint: t("connection.saved.hint"),
          Icon: CloudOff,
          tone: "neutral",
          saved: true,
        } as const)
      : ({ copy: t("connection.saved.offline", { time }), Icon: WifiOff, tone: "neutral", saved: true, hint: undefined } as const);
  }
  const cause =
    probe === "reachable" && muxDisconnected
      ? { copy: t("connection.herdrDown"), Icon: TriangleAlert }
      : probe === "unreachable" && !online
        ? { copy: t("connection.offlineCantReach"), Icon: WifiOff }
        : { copy: t("connection.cantReach"), Icon: TriangleAlert };
  const copy =
    lastSeenAt === undefined
      ? cause.copy
      : t("connection.withLastSeen", { cause: cause.copy, time: clockTime(lastSeenAt) });
  return { copy, Icon: cause.Icon, tone: "danger", saved: false, hint: undefined } as const;
}
