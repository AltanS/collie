import { on, ref, type Handle, type RemixNode } from "remix/component";
import { BellRing, KeyRound, MonitorDown, SquarePlus } from "lucide";
import type { IconNode } from "lucide";

import { t, tn } from "@web/lib/i18n";
import { reasonText } from "@web/lib/push-copy";

import { useLocale } from "../lib/i18n-store";
import { scheduleUpdate } from "../lib/store";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Collapse } from "../ui/collapse";
import { CollieMark } from "../shell/collie-mark";
import { Icon } from "../ui/icon";
import { ListGroup } from "../ui/list-group";
import { SectionLabel } from "../ui/section-label";
import { BottomSheet } from "../ui/sheet";
import type { EnableResult, PushState } from "../routes/settings/push";

// THE FIRST-RUN SCREEN, port of web/src/components/tour-sheet.tsx (`TourSheet`, `TourPushBlock`):
// one full-height sheet, ONE scrolling screen. It opens with a claim, states what THIS install looks
// like (panes, machines, whether this device may type, push), offers at most two things to do about it,
// then lists in six lines what the app can do at all. Everything above the six lines is a fact or is
// absent. The wording is web's, through `t()`; the keys are web's `tour.*`.
//
// CONTROLLED, like web's: it knows nothing about storage, the snapshot, the browser's push permission
// or the router. `tour-host.tsx` gathers the facts and does the moving.
//
// Differences from web/: the mark is the splash's static one (the animated CollieMark is not ported,
// as the idle cover says); the two cards that can arrive while the sheet is up (push, install) and
// the "notifications are off" row enter through `Collapse`, because a card popping into the middle of
// a screen is the shift DESIGN.md section 2 forbids and Remix has no bail-out to make it cheap.

/**
 * How the screen was left. Nothing about the SHEET navigates; it reports which door was taken.
 *   skip       Skip, Escape, the backdrop, the X. Stay where you are.
 *   dashboard  the footer button on an install with nothing blocked.
 *   pane       the footer button when something is blocked: open it.
 *   pair       the "Pair this phone" card.
 *   space      the "Nothing is running yet" card.
 */
export type TourExit = "skip" | "dashboard" | "pane" | "pair" | "space";

/** Everything in the panel a Tab can land on, in DOM order, with the disabled ones left out. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface TourSheetProps {
  open: boolean;
  onClose: (reason: TourExit) => void;
  /** The multiplexer's display name; "" while no bridge has answered, which drops the clause. */
  mux: string;
  /** The lead machine's crew label, or undefined on a solo install (no machine name to print). */
  host?: string;
  /** How many agent panes the snapshot holds, and how many are blocked on you. */
  panes: number;
  needsYou: number;
  /** Machines in the crew. Below two there is no crew and the row is absent. */
  machines: number;
  /** Pairing is enforced and this device is not paired. The screen still shows; two rows change. */
  readOnly?: boolean;
  /** null means the first push read has not resolved yet: say nothing rather than guess. */
  pushState: PushState | null;
  pushBusy?: boolean;
  onEnablePush: () => Promise<EnableResult>;
  /** The browser is holding an install offer for this origin. */
  installOffer?: boolean;
  onInstall?: () => void;
}

/** One "Do this next" row: a fact, a remedy, and one button that carries it out. */
interface NextCard {
  id: "pair" | "space" | "push" | "install";
  icon: IconNode;
  title: string;
  body: string;
  action: RemixNode;
}

/** The six capability lines, in the order they are read. */
const CAN_KEYS = ["tour.can.mirror", "tour.can.answer", "tour.can.type", "tour.can.harness", "tour.can.session", "tour.can.crew"] as const;

export function TourSheet(handle: Handle<TourSheetProps>) {
  useLocale(handle);

  // THE FOCUS TRAP, bound to the whole dialog the sheet draws, not to this screen's own body: the
  // sheet's X sits in its sticky header, outside these children. Tab off the last control wraps to the
  // first, Shift+Tab off the first wraps to the last, and focus on the panel itself (where the sheet
  // puts it on open) counts as "before the first".
  const trap = (node: HTMLElement, signal: AbortSignal): void => {
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Tab" || !node.isConnected) return;
        const dialog = node.closest<HTMLElement>("[role='dialog']");
        if (!dialog) return;
        const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const at = items.findIndex((el) => el === document.activeElement);
        if (event.shiftKey) {
          if (at > 0) return;
          event.preventDefault();
          items[items.length - 1]?.focus();
          return;
        }
        if (at !== -1 && at < items.length - 1) return;
        event.preventDefault();
        items[0]?.focus();
      },
      { signal },
    );
  };

  return () => {
    const { open, onClose, mux, host, panes, needsYou, machines, readOnly = false, pushState, pushBusy = false, onEnablePush, installOffer = false, onInstall } = handle.props;

    // The claim's second sentence, in the most specific form the facts support. No placeholder is ever
    // invented: an unknown multiplexer and a solo install each drop their own clause.
    const lead = mux === "" ? t("tour.leadNoMux") : host === undefined ? t("tour.leadNoHost", { mux }) : t("tour.lead", { mux, host });

    // Push is "off on this phone" only where it could be on: a bridge with no keys, a plain-HTTP origin
    // and a browser without the API are all cases where the sentence would be an accusation.
    const pushOffer = pushState?.availability === "ready" && !pushState.subscribed && !pushState.userDisabled;

    // AT MOST TWO, first match wins, in the order below.
    const next: NextCard[] = [];
    if (readOnly) {
      next.push({
        id: "pair",
        icon: KeyRound,
        title: t("tour.pair.title"),
        body: t("tour.pair.body"),
        action: (
          <Button variant="outline" class="min-h-11 shrink-0 px-4" mix={on("click", () => onClose("pair"))}>
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
          <Button variant="outline" class="min-h-11 shrink-0 px-4" mix={on("click", () => onClose("space"))}>
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
          <Button variant="outline" class="min-h-11 shrink-0 px-4" mix={on("click", () => onInstall?.())}>
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
        // Full height, overriding the sheet's `max-h-[82dvh]`: this screen is the whole screen while it
        // is up. The panel is already the scroller.
        class="h-(--app-h) max-h-(--app-h) rounded-t-none"
      >
        <div mix={ref(trap)} data-testid="tour-panel" data-slot="tour-panel" class="flex min-h-full flex-col gap-6">
          {/* Skip is text, top-left. Never only an X: the X in the sheet's header reads as "close a
              dialog", and the operator needs to be told this screen is optional. */}
          <div class="flex justify-start">
            <Button variant="ghost" class="min-h-11 px-3 text-muted-foreground" data-testid="tour-skip" mix={on("click", () => onClose("skip"))}>
              {t("tour.skip")}
            </Button>
          </div>

          {/* 1. MARK AND CLAIM. The splash's own mark, so the first thing here is the thing the
              operator just watched bloom. */}
          <div class="flex flex-col items-center gap-3 px-2 text-center">
            {/* At rest: the mark drifts, as web/'s `<CollieMark size={64} weight="header" paper="var(--card)" />`.
                The splash's bloom is for a wait, and this screen is not one. */}
            <CollieMark size={64} paper="var(--card)" />
            <h2 class="text-balance text-xl font-semibold tracking-tight">{t("tour.title")}</h2>
            <p class="max-w-sm text-sm leading-relaxed text-muted-foreground">{lead}</p>
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
              <Collapse open={machines > 1}>
                <SetupRow>{tn("tour.setup.machines", machines)}</SetupRow>
              </Collapse>
              <SetupRow>{readOnly ? t("tour.setup.readOnly") : t("tour.setup.canType")}</SetupRow>
              <Collapse open={pushOffer}>
                <SetupRow>{t("tour.setup.pushOff")}</SetupRow>
              </Collapse>
            </ListGroup>
          </section>

          {/* 3. DO THIS NEXT. Absent entirely on an install with nothing to fix. */}
          <Collapse open={shown.length > 0}>
            <section data-testid="tour-next">
              <SectionLabel placement="above">{t("tour.doNext")}</SectionLabel>
              <div class="flex flex-col gap-3">
                {shown.map((card) => (
                  <Card key={card.id} class="gap-0 py-0" data-testid={`tour-card-${card.id}`}>
                    <div class="flex items-center justify-between gap-4 p-4">
                      <div class="flex min-w-0 items-start gap-3">
                        <Icon icon={card.icon} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                        <div class="min-w-0">
                          <div class="font-medium">{card.title}</div>
                          <p class="text-sm text-muted-foreground">{card.body}</p>
                        </div>
                      </div>
                      {card.action}
                    </div>
                  </Card>
                ))}
              </div>
            </section>
          </Collapse>

          {/* 4. WHAT YOU CAN DO HERE. Static, and the only static block on the screen. */}
          <section>
            <SectionLabel placement="above">{t("tour.can")}</SectionLabel>
            <ul class="flex flex-col gap-1.5 text-sm text-muted-foreground">
              {CAN_KEYS.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </section>

          {/* 5. FOOTER. One primary button, full width, above the 44px floor. `mt-auto` pins it to the
              bottom on a short screen and lets it sit at the end of the scroll on a long one. */}
          <div class="mt-auto pt-2">
            <Button class="min-h-11 w-full" data-testid="tour-done" mix={on("click", () => onClose(footerBlocked ? "pane" : "dashboard"))}>
              {footerBlocked ? t("tour.done.pane") : t("tour.done.dashboard")}
            </Button>
          </div>
        </div>
      </BottomSheet>
    );
  };
}

/** One row inside the "Your setup" group; the padding is `ui/list-group.tsx`'s stated 14px. */
function SetupRow(handle: Handle<{ children?: RemixNode }>) {
  return () => <div class="px-3.5 py-3 text-sm">{handle.props.children}</div>;
}

/**
 * The notifications card's own control: the offer, and what it becomes once tapped. It carries no
 * "cannot run here" branch: the card only exists where the answer is "you could, and you have not".
 */
function TourPushBlock(handle: Handle<{ busy: boolean; onEnable: () => Promise<EnableResult> }>) {
  useLocale(handle);
  let note: string | null = null;
  let done = false;
  const enable = async (): Promise<void> => {
    note = null;
    scheduleUpdate(handle);
    const res = await handle.props.onEnable();
    if (handle.signal.aborted) return;
    if (res.ok) done = true;
    else note = reasonText(res.reason);
    scheduleUpdate(handle);
  };
  return () => {
    if (done) return <p class="shrink-0 text-xs text-muted-foreground">{t("tour.push.enabled")}</p>;
    return (
      <div class="flex shrink-0 flex-col items-end gap-2">
        <Button variant="outline" class="min-h-11 px-4" disabled={handle.props.busy} data-testid="tour-push-enable" mix={on("click", () => void enable())}>
          {t("tour.push.enable")}
        </Button>
        <Collapse open={note !== null}>
          <p class="text-xs text-status-blocked">{note}</p>
        </Collapse>
      </div>
    );
  };
}
