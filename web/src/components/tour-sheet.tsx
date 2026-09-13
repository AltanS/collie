import * as React from "react";
import { KeyRound, MonitorDown, SquarePlus, BellRing } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListGroup } from "@/components/ui/list-group";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet } from "@/components/ui/sheet";
import { CollieMark } from "@/components/collie-mark";
import { NewSpaceSheet } from "@/components/new-space-sheet";
import { useLocale } from "@/hooks/use-locale";
import { usePushControl } from "@/hooks/use-push";
import { useSpaceActions } from "@/hooks/use-spaces";
import { t, tn } from "@/lib/i18n";
import { promptInstall, useInstallOffer } from "@/lib/install";
import { reasonText } from "@/lib/push-copy";
import type { EnableResult, PushState } from "@/lib/push";
import type { HomeData } from "@/lib/loaders";
import { leadHost, hostName, paneScope } from "@/lib/hosts";
import { useMuxName } from "@/lib/mux-capability";
import { homePath, pairedDevicesPath, panePath } from "@/lib/nav";
import { triage } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { isReadOnly } from "@/lib/types";
import { markTourSeen, shouldShowTour, useTourSeen } from "@/lib/tour";

// THE FIRST-RUN SCREEN. One full-height sheet, ONE scrolling screen, shown once per device on the
// first render where a REAL snapshot is in hand, and never again on its own.
//
// WHY IT IS NO LONGER A CAROUSEL. Three slides named three of about twelve shipped capabilities and
// not one sentence came from THIS install: not the multiplexer, not the machine, not the pane count,
// not the crew, not whether this device may type. The fault was never the slide count, so adding a
// fourth would not have fixed it. The screen now opens with a claim, then states what this install
// actually looks like, then offers at most two things to do about it, then lists in six lines what
// the app can do at all. Everything above the six lines is a fact or is absent.
//
// The file holds three components and the split is deliberate. `TourSheet` is CONTROLLED and knows
// nothing about storage, the snapshot, the browser's push permission or the router, which is what
// lets the states playground mount every situation as a plain prop combination. `FirstRunLive`
// gathers the live facts, and is mounted only while the screen is actually up, so an app that never
// shows it pays for no push probe. `TourHost` is the gate: it reads the store, decides once, and
// tells `RootLayout` what it decided.
//
// WHY IT IS MARKED SEEN ON OPEN, NOT ON CLOSE. A phone that loses the tab half way down is never
// shown the screen again on its own, and that is the price on purpose: marking on close hands a
// flaky link the power to replay the whole thing on every load, which is the worse failure. The
// Settings row ("Show the first screen again") is the whole recovery path.
//
// THE FOCUS TRAP LIVES HERE, NOT IN `ui/sheet.tsx`. `useDialogFocus` moves focus in and restores it
// out and says in its own comment that it does not trap. The router behind this sheet is still
// fully focusable, so this is the first modal in this app that must trap. One caller does not earn a
// promotion; the second one does.

/**
 * How the screen was left. Nothing about the SHEET navigates — it reports which door was taken and
 * the host does the moving, which is what keeps every card mountable in the playground with no
 * router under it.
 *
 * - `skip` — Skip, Escape, the backdrop, the ✕. Stay where you are.
 * - `dashboard` — the footer button on an install with nothing blocked.
 * - `pane` — the footer button when something is blocked: open it.
 * - `pair` — the "Pair this phone" card.
 * - `space` — the "Nothing is running yet" card.
 */
export type TourExit = "skip" | "dashboard" | "pane" | "pair" | "space";

/** Everything in the panel a Tab can land on, in DOM order, with the disabled ones left out. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface TourSheetProps {
  open: boolean;
  onClose: (reason: TourExit) => void;
  /**
   * The multiplexer's display name. `""` while no bridge has answered, which drops the clause rather
   * than printing "under unknown" (lib/mux-capability.ts states that rule for every read of it).
   */
  mux: string;
  /**
   * The lead machine's own crew label, or undefined on a solo install — where the snapshot carries
   * no `servers` at all and there is therefore no machine name to print. Deliberately NOT
   * `location.hostname`: on a served install that is a long DNS name nobody calls the machine.
   */
  host?: string;
  /** How many agent panes this snapshot holds, and how many of them are blocked on you. */
  panes: number;
  needsYou: number;
  /** Machines in the crew. Below two there is no crew and the row is absent. */
  machines: number;
  /** Pairing is enforced and this device is not paired. The screen still shows; two rows change. */
  readOnly?: boolean;
  /** `null` means the first push read has not resolved yet — say nothing rather than guess. */
  pushState: PushState | null;
  pushBusy?: boolean;
  onEnablePush: () => Promise<EnableResult>;
  /** The browser is holding an install offer for this origin (lib/install.ts). */
  installOffer?: boolean;
  onInstall?: () => void;
}

/** One "Do this next" row: a fact, a remedy, and one button that carries it out. */
interface NextCard {
  id: "pair" | "space" | "push" | "install";
  icon: typeof KeyRound;
  title: string;
  body: string;
  action: React.ReactNode;
}

export function TourSheet({
  open,
  onClose,
  mux,
  host,
  panes,
  needsYou,
  machines,
  readOnly = false,
  pushState,
  pushBusy = false,
  onEnablePush,
  installOffer = false,
  onInstall,
}: TourSheetProps) {
  useLocale();

  // THE FOCUS TRAP. Bound to the whole dialog the primitive renders, not to this screen's own body:
  // the sheet's ✕ lives in the primitive's sticky header, outside these children, and a trap that
  // only knew the body would make that ✕ unreachable by keyboard. Tab off the last control wraps to
  // the first, Shift+Tab off the first wraps to the last, and focus sitting on the panel itself
  // (where `useDialogFocus` puts it on open) counts as "before the first".
  const panelRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const dialog = panelRef.current?.closest<HTMLElement>("[role='dialog']");
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const at = items.findIndex((el) => el === document.activeElement);
      if (e.shiftKey) {
        if (at > 0) return;
        e.preventDefault();
        items[items.length - 1]!.focus();
        return;
      }
      if (at !== -1 && at < items.length - 1) return;
      e.preventDefault();
      items[0]!.focus();
    };
    dialog.addEventListener("keydown", onKey);
    return () => dialog.removeEventListener("keydown", onKey);
  }, [open]);

  // The claim's second sentence, in the most specific form the facts support. No placeholder is ever
  // invented: an unknown multiplexer and a solo install each drop their own clause instead.
  const lead =
    mux === ""
      ? t("tour.leadNoMux")
      : host === undefined
        ? t("tour.leadNoHost", { mux })
        : t("tour.lead", { mux, host });

  // Push is "off on this phone" only where it could be on: a bridge with no keys, a plain-HTTP
  // origin and a browser without the API are all cases where the sentence would be an accusation.
  const pushOffer =
    pushState?.availability === "ready" && !pushState.subscribed && !pushState.userDisabled;

  // AT MOST TWO, first match wins, in the order below. Three cards is a to-do list, and a to-do list
  // on the first screen is what the old slide 3 already got wrong by leading with notifications.
  const next: NextCard[] = [];
  if (readOnly) {
    next.push({
      id: "pair",
      icon: KeyRound,
      title: t("tour.pair.title"),
      body: t("tour.pair.body"),
      action: (
        <Button variant="outline" className="min-h-11 shrink-0 px-4" onClick={() => onClose("pair")}>
          {t("tour.pair.button")}
        </Button>
      ),
    });
  }
  if (panes === 0) {
    next.push({
      id: "space",
      icon: SquarePlus,
      title: t("tour.space.title"),
      body: t("tour.space.body"),
      action: (
        <Button
          variant="outline"
          className="min-h-11 shrink-0 px-4"
          onClick={() => onClose("space")}
        >
          {t("tour.space.button")}
        </Button>
      ),
    });
  }
  if (pushOffer) {
    next.push({
      id: "push",
      icon: BellRing,
      title: t("tour.pushCard.title"),
      body: t("tour.pushCard.body"),
      action: <TourPushBlock busy={pushBusy} onEnable={onEnablePush} />,
    });
  }
  if (installOffer) {
    next.push({
      id: "install",
      icon: MonitorDown,
      title: t("tour.install.title"),
      body: t("tour.install.body"),
      action: (
        <Button variant="outline" className="min-h-11 shrink-0 px-4" onClick={onInstall}>
          {t("tour.install.button")}
        </Button>
      ),
    });
  }
  const shown = next.slice(0, 2);

  const footerBlocked = needsYou > 0;

  return (
    <BottomSheet
      open={open}
      onClose={() => onClose("skip")}
      title={t("tour.title")}
      // Full height, overriding the primitive's `max-h-[82dvh]`: this screen is the whole screen
      // while it is up, and a sheet that leaves the dashboard peeking above it invites a tap on a
      // control the operator has not been told about yet. The panel is already the scroller.
      className="h-[100dvh] max-h-[100dvh] rounded-t-none"
    >
      <div ref={panelRef} data-slot="tour-panel" className="flex min-h-full flex-col gap-6">
        {/* Skip is text, top-left. Never only an ✕: the ✕ in the sheet's own header reads as "close a
            dialog", and the operator needs to be told this screen is optional. */}
        <div className="flex justify-start">
          <Button
            variant="ghost"
            className="min-h-11 px-3 text-muted-foreground"
            onClick={() => onClose("skip")}
          >
            {t("tour.skip")}
          </Button>
        </div>

        {/* 1. MARK AND CLAIM. The same drawn mark the boot splash uses, so the first thing here is
            the thing the operator just watched bloom. No new asset. */}
        <div className="flex flex-col items-center gap-3 px-2 text-center">
          <CollieMark size={64} weight="header" paper="var(--card)" />
          <h2 className="text-xl font-semibold tracking-tight text-balance">{t("tour.title")}</h2>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{lead}</p>
        </div>

        {/* 2. YOUR SETUP. Every row is a real fact or absent. Nothing here is static copy. */}
        <section>
          <SectionLabel placement="above">{t("tour.setup")}</SectionLabel>
          <ListGroup>
            <SetupRow>
              {panes === 0
                ? t("tour.setup.noPanes")
                : needsYou > 0
                  ? `${tn("tour.setup.panes", panes)}, ${tn("tour.setup.needsYou", needsYou)}`
                  : tn("tour.setup.panes", panes)}
            </SetupRow>
            {machines > 1 && <SetupRow>{tn("tour.setup.machines", machines)}</SetupRow>}
            <SetupRow>{readOnly ? t("tour.setup.readOnly") : t("tour.setup.canType")}</SetupRow>
            {pushOffer && <SetupRow>{t("tour.setup.pushOff")}</SetupRow>}
          </ListGroup>
        </section>

        {/* 3. DO THIS NEXT. Absent entirely on an install with nothing to fix, which is the point of
            deriving it: a screen that always had a to-do list would be showing a decoration. */}
        {shown.length > 0 && (
          <section>
            <SectionLabel placement="above">{t("tour.doNext")}</SectionLabel>
            <div className="flex flex-col gap-3">
              {shown.map((card) => (
                <Card key={card.id} className="gap-0 py-0">
                  <div className="flex items-center justify-between gap-4 p-4">
                    <div className="flex min-w-0 items-start gap-3">
                      <card.icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="font-medium">{card.title}</div>
                        <p className="text-sm text-muted-foreground">{card.body}</p>
                      </div>
                    </div>
                    {card.action}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        )}

        {/* 4. WHAT YOU CAN DO HERE. The six lines the website sells and the app never said. Static,
            and the only static block on the screen. */}
        <section>
          <SectionLabel placement="above">{t("tour.can")}</SectionLabel>
          <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {CAN_KEYS.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </section>

        {/* 5. FOOTER. One primary button, full width, above the 44px floor. `mt-auto` pins it to the
            bottom on a screen whose content is shorter than the viewport, and lets it sit at the end
            of the scroll on one that is longer. */}
        <div className="mt-auto pt-2">
          <Button
            className="min-h-11 w-full"
            onClick={() => onClose(footerBlocked ? "pane" : "dashboard")}
          >
            {footerBlocked ? t("tour.done.pane") : t("tour.done.dashboard")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}

/** The six capability lines, in the order they are read. Listed once so the copy and the render
 *  cannot drift into five lines and six keys. */
const CAN_KEYS = [
  "tour.can.mirror",
  "tour.can.answer",
  "tour.can.type",
  "tour.can.harness",
  "tour.can.session",
  "tour.can.crew",
] as const;

/** One row inside the "Your setup" group. The padding is `ui/list-group.tsx`'s stated 14px, so a row
 *  here and a row inside a `Card` land their content on the same x. */
function SetupRow({ children }: { children: React.ReactNode }) {
  return <div className="px-3.5 py-3 text-sm">{children}</div>;
}

/**
 * The notifications card's own control: the offer, and what it becomes once tapped.
 *
 * IT CARRIES NO "CANNOT RUN HERE" BRANCH ANY MORE, and that is the cost of deriving the card rather
 * than always showing it. The old slide 3 said "Turn on notifications" to every device and then had
 * to explain itself four ways — no VAPID keys, plain HTTP, already subscribed, turned off on
 * purpose. The card above only exists where the answer is "you could, and you have not", so the four
 * explanations have nowhere left to be printed: the card is simply absent, and the "Your setup" row
 * is absent with it. `settings.push.*` is where a device that cannot run push is told why.
 */
function TourPushBlock({ busy, onEnable }: { busy: boolean; onEnable: () => Promise<EnableResult> }) {
  useLocale();
  const [note, setNote] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  if (done) {
    return <p className="shrink-0 text-xs text-muted-foreground">{t("tour.push.enabled")}</p>;
  }
  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <Button
        variant="outline"
        className="min-h-11 px-4"
        disabled={busy}
        onClick={() => {
          setNote(null);
          void (async () => {
            const res = await onEnable();
            if (res.ok) setDone(true);
            else setNote(reasonText(res.reason));
          })();
        }}
      >
        {t("tour.push.enable")}
      </Button>
      {note !== null && <p className="text-xs text-status-blocked">{note}</p>}
    </div>
  );
}

export interface TourHostProps {
  /** The root snapshot, read once by `RootLayout` and passed down rather than re-read here. */
  home: HomeData;
  /** Told exactly once when the gate decides, and again when the sheet closes. */
  onDecision: (decision: "open" | "closed") => void;
}

/**
 * The gate. Mounted once, at the data root, inside `CrewProvider`. It opens the sheet on the first
 * render where the screen is unseen AND the snapshot on screen is real, and it never re-opens on its
 * own for the life of the document — a poll revalidation that flips `error` true and back must not
 * bring it back over a dashboard the operator is already using.
 *
 * A READ-ONLY DEVICE SEES IT. There is deliberately no fourth clause on `isReadOnly`: a family
 * tablet left on the dashboard is exactly the device that needs to be told what it is looking at.
 * Two rows branch their copy instead, and the first "Do this next" card becomes the repair.
 */
export function TourHost({ home, onDecision }: TourHostProps) {
  useLocale();
  const seen = useTourSeen();
  const [open, setOpen] = React.useState(false);
  const decided = React.useRef(false);

  React.useEffect(() => {
    if (decided.current) return;
    // Not a live snapshot: this render is the last-good one after a failed refresh, or the refresh
    // was refused outright. Neither is a first launch worth narrating, so we do not decide yet.
    if (home.error || home.authError) return;
    decided.current = true;
    if (!shouldShowTour(seen)) {
      onDecision("closed");
      return;
    }
    // Marked seen HERE, before the screen paints. Nothing in the close path writes the key.
    markTourSeen();
    setOpen(true);
    onDecision("open");
  }, [home.error, home.authError, seen, onDecision]);

  if (!open) return null;
  return (
    <FirstRunLive
      home={home}
      onClosed={() => {
        setOpen(false);
        onDecision("closed");
      }}
    />
  );
}

/**
 * The live half: it reads the multiplexer name, the push state and the install offer, and it owns
 * the navigation every exit door implies. Mounted ONLY while the screen is up, which is what keeps
 * an app that never shows it from probing push at boot.
 */
function FirstRunLive({ home, onClosed }: { home: HomeData; onClosed: () => void }) {
  const navigate = useNavigate();
  const mux = useMuxName();
  const { state, busy, setEnabled } = usePushControl();
  const installOffer = useInstallOffer();
  const { newSpace } = useSpaceActions();
  const [spaceOpen, setSpaceOpen] = React.useState(false);

  // The blocked panes, in the dashboard's own order (lib/triage.ts): "needs you" is the first
  // section, newest first inside it. Reading it through `triage` rather than re-filtering here is
  // what stops this button and the list under it disagreeing about which pane is the urgent one.
  const needs: readonly AgentView[] = triage(home.agents)[0]?.agents ?? [];
  const blocked: AgentView | undefined = needs[0];
  // The lead's own crew label. Solo installs emit no `servers` at all, so this is undefined there and
  // the claim simply drops its "on {host}" clause.
  const host = hostName(home.servers, leadHost(home.servers));

  const exit = (reason: TourExit) => {
    onClosed();
    if (reason === "pair") {
      navigate(pairedDevicesPath(home.scope));
      return;
    }
    if (reason === "space") {
      setSpaceOpen(true);
      return;
    }
    if (reason === "pane" && blocked) {
      navigate(panePath(blocked.paneId, paneScope(home.scope, blocked, home.servers, home.sessions)));
      return;
    }
    if (reason === "dashboard" || reason === "pane") navigate(homePath(home.scope));
  };

  return (
    <>
      <TourSheet
        open={!spaceOpen}
        onClose={exit}
        mux={mux}
        host={host}
        panes={home.agents.length}
        needsYou={needs.length}
        machines={home.servers.length}
        readOnly={isReadOnly(home.device)}
        pushState={state}
        pushBusy={busy}
        onEnablePush={() => setEnabled(true)}
        installOffer={installOffer}
        onInstall={() => void promptInstall()}
      />
      {/* The "Nothing is running yet" card's remedy, mounted HERE rather than reached for on the
          dashboard: this gate is not always opened over the dashboard, and a button that navigated
          first and opened a sheet second would need a signal to survive the navigation. No `repos`
          is passed, and that is a fact rather than an omission — the card only appears when nothing
          is running, so there is no open space for a worktree to be branched from. */}
      <NewSpaceSheet
        open={spaceOpen}
        onClose={() => setSpaceOpen(false)}
        onCreate={newSpace}
        scope={home.scope}
      />
    </>
  );
}
