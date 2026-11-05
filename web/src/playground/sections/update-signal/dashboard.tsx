// The phone behind the "Update signal" round: the dashboard as it is today (real header and mark,
// real herd rows, real footer parts), plus the footer lines each option adds. Everything is local
// state, and no call reaches the bridge.
//
// DEV-ONLY, unreachable from the app entry.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { AgentCard } from "@/components/agent-card";
import { AppHeaderHost, RouteHeader, SettingsGear } from "@/components/app-header";
import { BuildStamp } from "@/components/build-stamp";
import { CollieMark } from "@/components/collie-mark";
import { CrewFooterLink } from "@/components/crew-footer-link";
import { Button } from "@/components/ui/button";
import { ListGroup } from "@/components/ui/list-group";
import { StripHost } from "@/components/ui/strip-host";
import { UpdateBanner } from "@/components/update-banner";
import { UpdateRibbon } from "@/components/update-ribbon";
import type { UpdateInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

import { herd, homeTrio } from "../../fixtures";
import { PackedRootRouter } from "../../harness";
import { beadClasses, BUSY_TEXT, RELEASE, signalsOf, type SignalCase, type Signals } from "./model";

/** 0 Today, 1 Bead lines, 2 Mark key, 3 Tap the mark. */
export type Option = 0 | 1 | 2 | 3;

const MARK_BOX = '[data-slot="collie-mark"]';

// The herd rows. None of them is a blocked pane: its red wash would read as the busy bead colour.
const CALM = herd.filter((a) => a.status !== "blocked");
const SHORT_HERD = ["working", "done", "idle"].flatMap((status) => CALM.find((a) => a.status === status) ?? []);
/** Long enough that the footer starts below the fold of a 720px frame (option 3). */
const LONG_HERD = Array.from({ length: 16 }, (_, i) => {
  const base = CALM[i % CALM.length]!;
  return { ...base, paneId: `${base.paneId}-row${i}` };
});

/** The data the real footer parts read: a waiting release, urgent or not. */
function homeFor(signal: SignalCase) {
  const waiting = signal === "update" || signal === "both" || signal === "urgent";
  if (!waiting) return homeTrio;
  const update: UpdateInfo = {
    current: "1.27.0",
    latest: RELEASE.version,
    latestUrl: `https://github.com/AltanS/collie/releases/tag/v${RELEASE.version}`,
    releaseAvailable: true,
    majorAvailable: null,
    majorUrl: null,
    bridgeStale: false,
    checkedAt: homeTrio.ts,
  };
  if (signal === "urgent") update.urgent = { version: RELEASE.version, reason: RELEASE.urgentReason };
  return { ...homeTrio, update };
}

/** The real mark's 44px box in the header, re-found if the header ever rebuilds it. */
function useMarkBox(root: RefObject<HTMLElement | null>): HTMLElement | null {
  const [box, setBox] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (el === null) return;
    const find = () => setBox(el.querySelector<HTMLElement>(MARK_BOX));
    find();
    const watch = new MutationObserver(find);
    watch.observe(el, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [root]);
  return box;
}

/** Make a tap on the real mark button call `onTap`. */
function useMarkTap(box: HTMLElement | null, onTap: (() => void) | null) {
  useEffect(() => {
    const button = box?.closest("button");
    if (button == null || onTap === null) return;
    button.addEventListener("click", onTap);
    return () => button.removeEventListener("click", onTap);
  }, [box, onTap]);
}

type Tone = "update" | "busy" | "urgent";

const DOT = {
  update: "bg-status-working",
  busy: "bg-status-blocked",
  urgent: "bg-destructive",
} as const satisfies Record<Tone, string>;

interface LineDef {
  readonly tone: Tone;
  readonly text: string;
  readonly action: string;
  readonly onAction: () => void;
}

function Line({ line }: { line: LineDef }) {
  return (
    <li className="flex min-h-11 items-center gap-2 text-[13px]">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[line.tone])} />
      <span className="min-w-0 flex-1 leading-tight">{line.text}</span>
      <Button type="button" size="sm" variant="outline" className="h-8 min-w-[4.5rem] px-3 text-xs" onClick={line.onAction}>
        {line.action}
      </Button>
    </li>
  );
}

/** The footer lines: one per active signal, after a thin rule. Quiet draws nothing. */
function SignalLines({
  lines,
  keyMark,
  signals,
  flash,
}: {
  lines: readonly LineDef[];
  keyMark: boolean;
  signals: Signals;
  flash: number;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="mx-4 mt-3 flex items-center gap-3 border-t border-rule">
      {keyMark && (
        <span data-slot="mark-key" className={cn("shrink-0", beadClasses(signals))}>
          <CollieMark size={28} weight="header" paper="var(--background)" />
        </span>
      )}
      {/* A new key restarts the highlight on every tap of the mark. */}
      <ul key={flash} className={cn("min-w-0 flex-1", flash > 0 && "upd-flash")}>
        {lines.map((line) => (
          <Line key={line.tone} line={line} />
        ))}
      </ul>
    </div>
  );
}

function Screen({ option, signal }: { option: Option; signal: SignalCase }) {
  const root = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const [applied, setApplied] = useState(false);
  const [flash, setFlash] = useState(0);
  const base = signalsOf(signal).signals;
  const signals: Signals = applied ? { update: false, busy: base.busy, urgent: false } : base;

  const box = useMarkBox(root);
  useMarkTap(
    box,
    option === 3
      ? () => {
          // The frame's own scroller: bring the footer to the bottom edge, then light the lines.
          const scroller = footer.current?.closest<HTMLElement>(".pg-phone-scroll");
          scroller?.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
          setFlash((n) => n + 1);
        }
      : null,
  );

  const lines: LineDef[] = [];
  if (signals.urgent) {
    lines.push({ tone: "urgent", text: `Urgent update: ${RELEASE.version}`, action: "Update", onAction: () => setApplied(true) });
  }
  if (signals.update && !signals.urgent) {
    lines.push({ tone: "update", text: `Update ready: ${RELEASE.version}, ${RELEASE.text}`, action: "Update", onAction: () => setApplied(true) });
  }
  if (signals.busy) {
    lines.push({ tone: "busy", text: BUSY_TEXT, action: "Open", onAction: () => {} });
  }

  const rows = option === 3 ? LONG_HERD : SHORT_HERD;
  let content: ReactNode = null;
  if (option > 0) content = <SignalLines lines={lines} keyMark={option === 2} signals={signals} flash={flash} />;

  return (
    <div ref={root} className={cn("flex min-h-full flex-1 flex-col", beadClasses(signals))}>
      <AppHeaderHost bridge="connected" error={false}>
        <RouteHeader wordmark rightTrail={<SettingsGear />} />
        <StripHost>
          {signals.urgent && <UpdateRibbon />}
          <div className="flex flex-1 flex-col">
            <ListGroup className="mx-4 mt-3">
              {rows.map((agent) => (
                <AgentCard key={agent.paneId} agent={agent} onClick={() => {}} density="row" statusStyle="dot" />
              ))}
            </ListGroup>
            <div ref={footer} className="mt-auto">
              {content}
              <CrewFooterLink className="px-4 pt-3" />
              {option === 0 && <UpdateBanner className="px-4 pt-3" />}
              <BuildStamp className="px-4 pb-3 pt-3" />
            </div>
          </div>
        </StripHost>
      </AppHeaderHost>
    </div>
  );
}

/** One phone. The router is built once per mount and freezes its props, so the caller keys this on
 *  the case: a new case is a new phone. */
export function SignalDashboard({ option, caseValue }: { option: Option; caseValue: string }) {
  const { signal } = signalsOf(caseValue);
  return (
    <PackedRootRouter data={homeFor(signal)}>
      <Screen option={option} signal={signal} />
    </PackedRootRouter>
  );
}
