// The Update mode tab of the states playground: every state update mode can be in (ADR 0064), in the
// real component, stepped through one at a time in one phone. See ../app.tsx's header for the page's
// two rules (mount REAL components with REAL props; drive a module store through its own mutators).
// The component is `components/update-screen.tsx` itself, the strip is `update-run-strip.tsx`, and
// every state comes out of the real reducer in `lib/update-screen.ts`, given a fixture.
//
// ONE PHONE, NUMBERED STATES. Altan picked this design from a drawn playground that stepped one frame
// through thirteen states, and he reviews by number ("7 to 8 shifts"). So this is the same: a
// numbered list, Back and Next, and one 375x812 phone. Stepping here is also the quickest way to see
// the no-shift rule hold: the heading, the subtitle box, every row and the footer stay where they are.
// `e2e/update-screen.spec.ts` measures the same thing on the real bundle.
//
// WHY THE VIEW IS BUILT RATHER THAN PROVOKED: the panel reads seven stores at once, and driving all of
// them to one combination needs a bridge, a service worker and a deploy. The REDUCER is the seam, and
// handing it an input is the same act as the app handing it one.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useState, type ReactNode } from "react";

import { UpdateScreen } from "@/components/update-screen";
import { UpdateRunStrip } from "@/components/update-run-strip";
import { StripHost } from "@/components/ui/strip-host";
import {
  DOWNLOAD_HUNG_MS,
  LEAD_STALLED_MS,
  PEER_UNREACHABLE_MS,
  updateScreenView,
  type UpdateScreenInput,
} from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateAsk } from "@/lib/update-ask";
import type { UpdateClaim } from "@/lib/update-ribbon";
import type { UpdateCrewMember, UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";

import { Card, Group, Section, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "update-screen",
  title: "Update mode",
  intent:
    "What the phone shows while an update runs: the app locked behind a veil, a band with the step and a clock, and a docked panel that walks seven steps with one row per machine and one for this phone.",
};

const NOW = Date.now();
const FROM = "1.11.1";
const TO = "1.12.0";

const CREW: UpdateCrewMember[] = [
  { name: "minibuch", version: FROM, verdict: "green", reasons: [], asOf: NOW - 5_000 },
  { name: "cellar", version: FROM, verdict: "green", reasons: [], asOf: NOW - 5_000 },
];

const CLAIM: UpdateClaim = {
  startedAt: NOW - 4 * 60_000,
  runId: "run-1",
  target: TO,
  peersOnly: false,
  bundleAtStart: "bundle-a",
  skipped: [],
  lead: "bluefin",
  members: ["minibuch", "cellar"],
  lastPhase: null,
};

const ASK: UpdateAsk = { kind: "crew", version: TO, major: false, peersOnly: false, current: FROM };

/** A run record, anchored to this module's load time so every elapsed number reads as a live run. */
function run(state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun {
  return {
    schema: 1,
    state,
    from: FROM,
    to: TO,
    startedAt: NOW - 4 * 60_000,
    updatedAt: NOW - 8_000,
    pid: 4242,
    attempt: 0,
    runId: "run-1",
    ...over,
  };
}

function leg(name: string, state: UpdatePeerLeg["state"], over: Partial<UpdatePeerLeg> = {}): UpdatePeerLeg {
  return { name, state, version: FROM, updatedAt: NOW - 5_000, ...over };
}

const BASE: UpdateScreenInput = {
  run: undefined,
  crew: CREW,
  leadName: "bluefin",
  stage: "idle",
  progress: null,
  installingSince: null,
  startedHere: true,
  controllerChangedAt: null,
  released: false,
  now: NOW,
  claim: CLAIM,
  bundle: { id: "bundle-a", version: FROM },
  serverStale: false,
};

/** One numbered state: what the reducer is handed, and whether the strip was opened by hand. */
interface StepState {
  readonly label: string;
  readonly input: Partial<UpdateScreenInput>;
  /** The strip's "View" was tapped: the read-only panel on a device that did not start the run. */
  readonly opened?: boolean;
}

const WAITING = [leg("minibuch", "waiting"), leg("cellar", "waiting")];

/** Every state, in the order an update passes through them, then the other ends and devices. */
const STATES: readonly StepState[] = [
  { label: "Ready to start", input: { ask: ASK, claim: null, startedHere: false } },
  { label: "Checking", input: { run: run("preflight", { peers: WAITING }) } },
  { label: "Building", input: { run: run("staging", { peers: WAITING }) } },
  { label: "Lead restarting", input: { run: run("restarting", { peers: WAITING, updatedAt: NOW - 14_000 }) } },
  { label: "Verifying", input: { run: run("verifying", { peers: WAITING }) } },
  {
    label: "Members, one updating",
    input: { run: run("done", { peers: [leg("minibuch", "updating"), leg("cellar", "waiting")] }) },
  },
  {
    label: "Members, one unreachable",
    input: {
      run: run("done", {
        peers: [
          leg("minibuch", "updating"),
          leg("cellar", "waiting", { updatedAt: NOW - PEER_UNREACHABLE_MS * 2 }),
        ],
      }),
    },
  },
  {
    label: "Members, one rate-limited",
    input: {
      run: run("done", {
        peers: [
          leg("minibuch", "done", { version: TO }),
          leg("cellar", "waiting", { reason: "rate-limited, retries by 08:14" }),
        ],
      }),
    },
  },
  {
    label: "Phone downloading",
    input: {
      run: run("done", {
        peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { updatedAt: NOW - 90_000 })],
      }),
      claim: { ...CLAIM, skipped: ["cellar"] },
      stage: "installing",
      installingSince: NOW - 20_000,
      progress: { done: 132, total: 214, at: NOW - 500 },
    },
  },
  {
    label: "Phone switching",
    input: {
      run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "done", { version: TO })], settledAt: NOW - 30_000 }),
      stage: "installing",
      installingSince: NOW - 30_000,
      progress: { done: 214, total: 214, at: NOW - 500 },
    },
  },
  {
    label: "Phone download hung",
    input: {
      run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "done", { version: TO })], settledAt: NOW - 200_000 }),
      stage: "installing",
      installingSince: NOW - DOWNLOAD_HUNG_MS - 60_000,
      progress: { done: 40, total: 214, at: NOW - DOWNLOAD_HUNG_MS - 5_000 },
    },
  },
  {
    label: "Done",
    input: {
      run: run("done", { peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "done", { version: TO })], settledAt: NOW - 60_000 }),
      bundle: { id: "bundle-b", version: TO },
    },
  },
  {
    label: "Done, one skipped",
    input: {
      run: run("done", {
        peers: [leg("minibuch", "done", { version: TO }), leg("cellar", "waiting", { updatedAt: NOW - 90_000 })],
      }),
      claim: { ...CLAIM, skipped: ["cellar"] },
      bundle: { id: "bundle-b", version: TO },
    },
  },
  {
    label: "Rolled back",
    input: {
      run: run("rolled-back", {
        peers: WAITING,
        reason: "the service came back as 1.11.1 after the health check",
      }),
    },
  },
  {
    label: "Stuck",
    input: {
      run: run("stuck", {
        peers: WAITING,
        reason: "the new binary did not answer and the old one is gone",
        recovery: "collie update --rollback",
      }),
    },
  },
  {
    label: "Stopped",
    input: { run: run("interrupted", { peers: WAITING, reason: "the updater was killed during the build" }) },
  },
  {
    label: "Lead stalled, the way out",
    input: { run: run("staging", { peers: WAITING, updatedAt: NOW - LEAD_STALLED_MS - 30_000 }) },
  },
  {
    label: "Second device, the strip",
    input: { run: run("restarting", { peers: WAITING }), claim: null, startedHere: false },
  },
  {
    label: "Second device, View opened",
    input: { run: run("restarting", { peers: WAITING }), claim: null, startedHere: false },
    opened: true,
  },
  {
    label: "Try minibuch again",
    input: {
      ask: { kind: "retry", version: TO, major: false, peersOnly: true, current: TO, names: ["minibuch"] },
      claim: null,
      startedHere: false,
      crew: [
        { name: "minibuch", version: FROM, verdict: "green", reasons: [], asOf: NOW - 5_000 },
        { name: "cellar", version: TO, verdict: "green", reasons: [], asOf: NOW - 5_000 },
      ],
    },
  },
  {
    label: "Members only, one updating",
    input: {
      claim: { ...CLAIM, peersOnly: true, target: TO },
      crewRun: {
        legs: [leg("minibuch", "updating"), leg("cellar", "done", { version: TO })],
        settledAt: null,
        to: TO,
        current: TO,
      },
      bundle: { id: "bundle-b", version: TO },
    },
  },
];

/** The controls do nothing here: each thing a tap would do is a numbered state of its own. */
function noop(): void {}

/** The panel's own state object, as `App.tsx` hands it over, with no-op controls. */
function screenOf(step: StepState): UpdateScreenState {
  const input = { ...BASE, ...step.input };
  const view = updateScreenView(input);
  const mode = view.mode === "collapsed" && step.opened === true ? "expanded" : view.mode;
  return {
    view,
    mode,
    blocking: mode === "expanded",
    ask: input.ask ?? null,
    setExpanded: noop,
    release: noop,
    skip: noop,
    keepTrying: noop,
    back: noop,
    notNow: noop,
    retryMembers: noop,
    tryAgain: noop,
  };
}

/** A still app behind the veil. Playground chrome, not app chrome: the veil is the point. */
function FakeApp(): ReactNode {
  const panes = [
    ["fix loop", "bluefin · claude · working"],
    ["translating docs", "bluefin · claude · working"],
    ["tolvik work", "minibuch · codex · idle"],
    ["PR work", "cellar · claude · done"],
  ] as const;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center border-b border-rule px-4 text-base">Dashboard</div>
      {panes.map(([title, meta]) => (
        <div key={title} className="border-b border-border px-4 py-2.5">
          <div className="text-sm">{title}</div>
          <div className="text-xs text-muted-foreground">{meta}</div>
        </div>
      ))}
    </div>
  );
}

export function UpdateScreenSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="Update mode, state by state">
        <StepperCard />
      </Group>
    </Section>
  );
}

function StepperCard(): ReactNode {
  const [index, setIndex] = useState(0);
  const step = STATES[index] ?? STATES[0]!;
  const screen = screenOf(step);
  const go = (delta: number) => setIndex((i) => (i + delta + STATES.length) % STATES.length);
  return (
    <Card
      state="update-mode-stepper"
      label="update mode, every state in one phone"
      reach="tap Update all machines on /settings/updates. The first screen is Ready to start; Start update locks the app and the panel walks the seven steps. A second device sees the strip."
      note="Every state comes out of the real reducer and renders in the real component. Step through them and watch the heading, the subtitle box, the rows and the footer: none of them moves. e2e/update-screen.spec.ts measures that on the real bundle at 375x812 in Chromium and WebKit."
      span={2}
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="flex flex-col gap-2 md:w-64">
          <div className="flex items-center gap-2 text-sm">
            <button type="button" className="rounded-md border border-border px-2 py-1" onClick={() => go(-1)}>
              Back
            </button>
            <span className="min-w-0 flex-1 text-center tabular-nums">
              State {index + 1} of {STATES.length}
            </span>
            <button type="button" className="rounded-md border border-border px-2 py-1" onClick={() => go(1)}>
              Next
            </button>
          </div>
          <ol role="group" aria-label="Update mode states" className="flex flex-col gap-1 text-xs">
            {STATES.map((s, i) => (
              <li key={s.label}>
                <button
                  type="button"
                  aria-pressed={i === index}
                  onClick={() => setIndex(i)}
                  className="w-full rounded-md border border-border px-2 py-1 text-left aria-pressed:bg-primary aria-pressed:text-primary-foreground"
                >
                  <span className="mr-1.5 tabular-nums opacity-60">{i + 1}</span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div
          className="relative isolate w-[375px] max-w-full shrink-0 overflow-hidden rounded-[1.75rem] border-[6px] border-zinc-800 bg-background shadow-xl dark:border-zinc-700"
          style={{ height: 812, transform: "translate(0)" }}
        >
          <div className="flex h-full flex-col">
            <StripHost>
              <UpdateRunStrip screen={screen} />
            </StripHost>
            <div className="min-h-0 flex-1">
              <FakeApp />
            </div>
          </div>
          <UpdateScreen screen={screen} onOpenUpdates={() => {}} onStarted={() => {}} />
        </div>
      </div>
    </Card>
  );
}
