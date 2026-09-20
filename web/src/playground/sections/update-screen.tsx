// The Update screen tab of the states playground: every state the sheet a running update takes the
// screen with can be in. See ../app.tsx's header for the page's two rules (mount REAL components with
// REAL props; drive a module store through its own mutators). This file follows both — the component
// is `components/update-screen.tsx` itself, and every state on screen comes out of the real reducer
// in `lib/update-screen.ts`, given a fixture.
//
// WHY THE VIEW IS BUILT RATHER THAN PROVOKED. The sheet reads five stores at once: the run poll, the
// worker's stage, its per-file progress, the controller swap and "this device tapped the confirm".
// Driving all five to one combination would need a live bridge, a service worker and a real deploy —
// which is what `e2e/update-screen.spec.ts` is for. Here the REDUCER is the seam: it is pure, it is
// the one thing that decides every state, and handing it an input is the same act as the app handing
// it one. Nothing below re-implements a row, a word or a decision.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { StatusArea } from "@/components/status-area";
import { UpdateScreen } from "@/components/update-screen";
import { UpdateRunStrip } from "@/components/update-run-strip";
import { StripHost } from "@/components/ui/strip-host";
import { clearStatus, setStatus } from "@/lib/status";
import {
  DOWNLOAD_HUNG_MS,
  LEAD_STALLED_MS,
  PEER_UNREACHABLE_MS,
  endSentence,
  updateScreenView,
  type UpdateScreenCrewRun,
  type UpdateScreenInput,
} from "@/lib/update-screen";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdatePeerLeg, UpdateRun, UpdateRunState } from "@/lib/types";

import { Card, Group, Section, Stage, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "update-screen",
  title: "Update screen",
  intent:
    "What the phone shows while an update runs: a row per machine, a row for this device's own download, the app blocked behind it on the device that started it, a badge everywhere else, and a way out of every state that can stall.",
};

const NOW = Date.now();

/** A run record, anchored to this module's load time so every elapsed number reads as a live run. */
function run(state: UpdateRunState, over: Partial<UpdateRun> = {}): UpdateRun {
  return {
    schema: 1,
    state,
    from: "1.8.2",
    to: "1.9.0",
    startedAt: NOW - 45_000,
    updatedAt: NOW - 4_000,
    pid: 4242,
    attempt: 0,
    ...over,
  };
}

const BASE: UpdateScreenInput = {
  run: undefined,
  crew: [],
  leadName: "bluefin",
  stage: "idle",
  progress: null,
  installingSince: null,
  startedHere: true,
  controllerChangedAt: null,
  downloadReleased: false,
  leadReleased: false,
  now: NOW,
};

/**
 * The sheet's own state object, as `App.tsx` hands it over — the real reading plus the four things a
 * component holds. The callbacks are no-ops here: what each of them DOES is a state of its own, and
 * each of those states has its own card below rather than being reachable by a tap nobody can see the
 * result of on a page with sixteen sheets on it.
 */
function sheet(over: Partial<UpdateScreenInput>): UpdateScreenState {
  const view = updateScreenView({ ...BASE, ...over });
  return {
    view,
    mode: view.mode,
    blocking: view.mode === "expanded" && !view.dismissible,
    setExpanded: () => {},
    releaseDownload: () => {},
    releaseLead: () => {},
  };
}

/** The collapsed form, in the band it actually lives in. `StripHost` is not decoration here: the
 *  strip registers a SLOT and draws nothing without a host, which is the same arrangement
 *  `routes/root.tsx` gives it. */
function BandStage({ screen }: { screen: UpdateScreenState }): ReactNode {
  return (
    <Stage height={420}>
      <StripHost>
        <UpdateRunStrip screen={screen} />
      </StripHost>
    </Stage>
  );
}

/** One sheet in a box. `Stage` is the containing block for the sheet's `position: fixed`, so the
 *  panel renders at the card's size rather than over the whole page. */
function SheetStage({ screen }: { screen: UpdateScreenState }): ReactNode {
  return (
    <Stage height={420}>
      <UpdateScreen screen={screen} onOpenUpdates={() => {}} />
    </Stage>
  );
}

export function UpdateScreenSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The run, state by state">
        <CollapsedCard />
        <ExpandedPreflightCard />
        <ExpandedStagingCard />
        <ExpandedRestartingCard />
        <ExpandedVerifyingCard />
      </Group>
      <Group title="The crew, when a machine does not follow">
        <PeerUnreachableCard />
        <PeerRolledBackCard />
      </Group>
      <Group title="This device's own download">
        <DownloadFilesCard />
        <DownloadHungCard />
      </Group>
      <Group title="The ways out, and the end">
        <LeadStalledCard />
        <StuckCard />
        <DoneToastCard />
        <DoneToastSoloCard />
      </Group>
      <Group title="A run that moves only the members">
        <CrewOnlyExpandedCard />
        <CrewOnlyFailedCard />
        <CrewOnlyDoneToastCard />
      </Group>
    </Section>
  );
}

// ── 1. The badge, on a device that did not start it ─────────────────────────

function CollapsedCard(): ReactNode {
  return (
    <Card
      state="collapsed"
      label="the badge, on a device that did not start the run"
      reach="confirm an update on your phone, then look at the tablet. A takeover nobody asked for reads as hijacked, so every other device gets one line it can open."
      note="`startedHere` is false here, which is the ONLY thing that differs from the card below it. The reducer answers `collapsed`, nothing behind it goes inert, and since 2026-09-20 the badge is a strip in the band above the header rather than a bar over the composer."
    >
      <BandStage screen={sheet({ startedHere: false, run: run("staging") })} />
    </Card>
  );
}

// ── 2-5. The four in-flight states, expanded and blocking ───────────────────


/**
 * The body every one of the four in-flight cards shares. The `Card` itself is written out four times
 * below, with its handle as a LITERAL: a browser case greps this file for the string it types, and the
 * milestone counts those strings, so a composed template would be a handle nobody can find.
 */
function expandedSheet(runState: "preflight" | "staging" | "restarting" | "verifying"): UpdateScreenState {
  return sheet({
    run: run(runState, {
      peers: [
        { name: "minibuch", state: "updating", version: "1.8.2", updatedAt: NOW - 6_000 },
        { name: "cellar", state: "waiting", version: "1.8.2", updatedAt: NOW - 6_000 },
      ],
    }),
  });
}

const EXPANDED_REACH =
  "tap Update on /settings/updates. The sheet opens full-height on the device that tapped, and the app behind it goes inert until the run is over.";

/** The shared half of each note: what every one of these four states has in common. */
const EXPANDED_NOTE =
  "Two peers ride along so the rows are a crew and not one machine. Undismissible: there is no ✕, because the app behind cannot be used anyway.";

function ExpandedPreflightCard(): ReactNode {
  return (
    <Card
      state="expanded-preflight"
      label="the sheet, expanded, run state preflight"
      reach={EXPANDED_REACH}
      note={`The run's first state: the host is checking itself before it fetches anything. ${EXPANDED_NOTE}`}
      span={2}
    >
      <SheetStage screen={expandedSheet("preflight")} />
    </Card>
  );
}

function ExpandedStagingCard(): ReactNode {
  return (
    <Card
      state="expanded-staging"
      label="the sheet, expanded, run state staging"
      reach={EXPANDED_REACH}
      note={`The build. This is the long one, and the one a slow host stretches past every estimate. ${EXPANDED_NOTE}`}
      span={2}
    >
      <SheetStage screen={expandedSheet("staging")} />
    </Card>
  );
}

function ExpandedRestartingCard(): ReactNode {
  return (
    <Card
      state="expanded-restarting"
      label="the sheet, expanded, run state restarting"
      reach={EXPANDED_REACH}
      note={`THE BRIDGE IS GONE in this window, and that is the update working. The rows keep their last reading and the store reads the standby door on the second port instead. ${EXPANDED_NOTE}`}
      span={2}
    >
      <SheetStage screen={expandedSheet("restarting")} />
    </Card>
  );
}

function ExpandedVerifyingCard(): ReactNode {
  return (
    <Card
      state="expanded-verifying"
      label="the sheet, expanded, run state verifying"
      reach={EXPANDED_REACH}
      note={`The new version is up and the host is checking it before it calls the run done. ${EXPANDED_NOTE}`}
      span={2}
    >
      <SheetStage screen={expandedSheet("verifying")} />
    </Card>
  );
}

// ── 6. A peer that has gone quiet ───────────────────────────────────────────

function PeerUnreachableCard(): ReactNode {
  return (
    <Card
      state="peer-unreachable"
      label="a peer that stopped answering"
      reach="update a crew with a member that is asleep, off the tailnet, or wedged. The lead gives up on it after three missed sweeps and reports the leg unreachable."
      note={`Past PEER_UNREACHABLE_MS (${PEER_UNREACHABLE_MS / 1000}s) the row dates itself from the leg's own stamp and offers the two things that are actually available: keep waiting, or read the Updates page. Nothing here cancels the run.`}
      span={2}
    >
      <SheetStage
        screen={sheet({
          run: run("verifying", {
            peers: [
              {
                name: "minibuch",
                state: "unreachable",
                version: "1.8.2",
                reason: "minibuch has missed 3 sweeps",
                updatedAt: NOW - 4 * 60_000,
              },
              { name: "cellar", state: "done", version: "1.9.0", updatedAt: NOW - 9_000 },
            ],
          }),
        })}
      />
    </Card>
  );
}

// ── 7. A peer that tried and fell back ──────────────────────────────────────

function PeerRolledBackCard(): ReactNode {
  return (
    <Card
      state="peer-rolled-back"
      label="a peer that rolled back, and one its package manager owns"
      reach="a member whose health gate fails after the swap puts its old version back; a member installed from a package manager sits the run out entirely (ADR 0035)."
      note="The rolled-back row NAMES the version the machine is on, which is the fact an operator needs first. The package-managed row is a state and never a failure — no red, no spinner, and a sentence saying who owns that machine."
      span={2}
    >
      <SheetStage
        screen={sheet({
          run: run("done", {
            peers: [
              {
                name: "minibuch",
                state: "rolled-back",
                version: "1.8.2",
                reason: "health gate timed out after three attempts on the standby door",
                updatedAt: NOW - 20_000,
              },
              { name: "cellar", state: "package-managed", version: "1.8.2", updatedAt: NOW - 30_000 },
            ],
          }),
          stage: "installing",
          installingSince: NOW - 8_000,
          progress: { done: 7, total: 28, at: NOW - 1_000 },
        })}
      />
    </Card>
  );
}

// ── 8. This device, counting files ──────────────────────────────────────────

function DownloadFilesCard(): ReactNode {
  return (
    <Card
      state="download-files"
      label="this device's own download, counted in files"
      reach="the machines finish and the bridge starts serving the new bundle. The service worker precaches it, and every completed asset posts one message to this page."
      note="FILES, never bytes. `fetchDidSucceed` fires once per completed asset and carries no byte count, so a byte bar would move in file-sized jumps anyway while costing a build-time size stamp and a fallback. The run is `done` here and the sheet is still up, which is legitimate: two independent truths, and the controller swap is what ends this one."
      span={2}
    >
      <SheetStage
        screen={sheet({
          run: run("done", { peers: [{ name: "minibuch", state: "done", version: "1.9.0" }] }),
          stage: "installing",
          installingSince: NOW - 19_000,
          progress: { done: 12, total: 28, at: NOW - 400 },
        })}
      />
    </Card>
  );
}

// ── 9. A download that has stopped saying anything ──────────────────────────

function DownloadHungCard(): ReactNode {
  return (
    <Card
      state="download-hung"
      label="a download with nothing new for two minutes"
      reach="a phone that loses its link mid-precache, or a worker that died holding the job. The install is not cancelled and the controller swap still lands if it ever finishes."
      note={`Past DOWNLOAD_HUNG_MS (${DOWNLOAD_HUNG_MS / 1000}s with no new file) the row says so, the sheet becomes dismissible, and one checkForUpdate() re-check goes out so a badge lying about a dead worker corrects itself. The escape is always "keep the app you have", never a forced reload.`}
      span={2}
    >
      <SheetStage
        screen={sheet({
          run: run("done", { peers: [{ name: "minibuch", state: "done", version: "1.9.0" }] }),
          stage: "installing",
          installingSince: NOW - DOWNLOAD_HUNG_MS - 30_000,
          progress: { done: 12, total: 28, at: NOW - DOWNLOAD_HUNG_MS - 1_000 },
        })}
      />
    </Card>
  );
}

// ── 10. A lead that has held one state too long ─────────────────────────────

function LeadStalledCard(): ReactNode {
  return (
    <Card
      state="lead-stalled"
      label="the lead has been at one thing for three minutes"
      reach="a build on a slow host, or an update job that wedged. The run record's `updatedAt` stops moving while the state stays the same."
      note={`Past LEAD_STALLED_MS (${LEAD_STALLED_MS / 60_000} min in one state) the sheet stops promising it is nearly over. "Keep waiting" hands the app back WITHOUT cancelling anything; "See Updates" goes to the page that owns the log tail and the retry.`}
      span={2}
    >
      <SheetStage
        screen={sheet({
          run: run("staging", { updatedAt: NOW - LEAD_STALLED_MS - 30_000 }),
        })}
      />
    </Card>
  );
}

// ── 11. A run that ended badly ──────────────────────────────────────────────

function StuckCard(): ReactNode {
  return (
    <Card
      state="stuck"
      label="the run is stuck, and the sheet says so on every device"
      reach="an update that cannot finish and cannot roll back — the one state that prints a command for the operator to run by hand."
      note="Expanded on EVERY device, not only the one that tapped: this is a statement about the machine, and it is dismissible, so it is a statement and not a trap. The recovery command itself lives on the Updates page, which the button goes to."
      span={2}
    >
      <SheetStage
        screen={sheet({
          startedHere: false,
          run: run("stuck", {
            reason: "the new binary did not answer the health gate and the old one is gone",
            recovery: "cd ~/apps/collie && bin/collie update --rollback",
          }),
        })}
      />
    </Card>
  );
}

// ── 12-13. The end, through the status channel ──────────────────────────────

/** The two toasts. The sheet is HIDDEN in both — the end is announced, never presented as a panel the
 *  operator has to close — so the card shows the real `StatusArea` carrying the real sentence. */
function EndToastCard({
  state,
  label,
  reach,
  note,
  screen,
}: {
  state: string;
  label: string;
  reach: string;
  note: string;
  screen: UpdateScreenState;
}): ReactNode {
  // `lib/status.ts` is a module-scoped store shared with the whole app, so this card must not leave a
  // status standing behind it when the page switches tabs.
  useEffect(() => () => clearStatus(), []);
  const sentence = endSentence(screen.view.end) ?? "(no end)";
  return (
    <Card state={state} label={label} reach={reach} note={note} span={2}>
      <div className="mb-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          onClick={() => setStatus(sentence, "success")}
        >
          Announce the end
        </Button>
      </div>
      <Stage height={160}>
        <div className="p-4">
          <StatusArea />
          <UpdateScreen screen={screen} onOpenUpdates={() => {}} />
        </div>
      </Stage>
    </Card>
  );
}

function DoneToastCard(): ReactNode {
  return (
    <EndToastCard
      state="done-toast"
      label="the end, on a crew"
      reach="every machine arrives and this document is running the new bundle. The sheet closes itself and the toast is the whole announcement."
      note="The sheet is HIDDEN in this state — that is the point, and the reducer says so. The sentence is the reducer's own (`endSentence`), published through the same status channel every other confirmation uses."
      screen={sheet({
        run: run("done", { peers: [{ name: "minibuch", state: "done", version: "1.9.0" }] }),
        controllerChangedAt: NOW - 1_000,
      })}
    />
  );
}

function DoneToastSoloCard(): ReactNode {
  return (
    <EndToastCard
      state="done-toast-solo"
      label="the end, on a solo install"
      reach="the same moment on a machine with no crew at all."
      note="It names the MACHINE, never a crew. A toast saying 'Crew updated' on a one-machine install is the screen inventing company, and an operator who reads it starts looking for the other machine."
      screen={sheet({ run: run("done"), controllerChangedAt: NOW - 1_000 })}
    />
  );
}

// ── 14-16. A run that moves only the members (M32) ──────────────────────────

/** A lead already on the newest release, levelling its members to it. No record on the lead. */
const LEAD_CURRENT = "1.9.0";

function crewOnly(legs: UpdatePeerLeg[], settledAt: number | null = null): UpdateScreenCrewRun {
  return { legs, settledAt, to: LEAD_CURRENT, current: LEAD_CURRENT };
}

function CrewOnlyExpandedCard(): ReactNode {
  return (
    <Card
      state="crew-only-expanded"
      label="a run that moves only the members, on the device that tapped it"
      reach="the lead already runs the newest release and a member is a release back: tap Retry crew update on /settings/updates. The run writes no record on the lead, and its legs ride the status."
      note="The same takeover as a full update: expanded, no ✕, the app behind inert. The lead's row says it is already on the version and is not part of the run, never an old record's state. There is no device row, because the lead serves the same bundle before and after."
      span={2}
    >
      <SheetStage
        screen={sheet({
          crewRun: crewOnly([
            { name: "minibuch", state: "updating", version: "1.8.2", updatedAt: NOW - 6_000 },
            { name: "cellar", state: "waiting", version: "1.8.2", updatedAt: NOW - 6_000 },
          ]),
        })}
      />
    </Card>
  );
}

function CrewOnlyFailedCard(): ReactNode {
  return (
    <Card
      state="crew-only-failed"
      label="a run that moves only the members, and one did not arrive"
      reach="a member's health gate fails after its swap and it puts its old version back. Only the device that started the run gets this sheet; every other device reads the same sentence on the band."
      note="The sentence is the band's own, word for word, so the sheet and the band never read as two facts about one member. Dismissible, because the run is over."
      span={2}
    >
      <SheetStage
        screen={sheet({
          crewRun: crewOnly(
            [
              {
                name: "minibuch",
                state: "rolled-back",
                version: "1.8.2",
                reason: "health gate timed out",
                updatedAt: NOW - 20_000,
              },
              { name: "cellar", state: "done", version: LEAD_CURRENT, updatedAt: NOW - 40_000 },
            ],
            NOW - 20_000,
          ),
        })}
      />
    </Card>
  );
}

function CrewOnlyDoneToastCard(): ReactNode {
  return (
    <EndToastCard
      state="crew-only-done-toast"
      label="the end of a run that moved only the members"
      reach="every member reports the lead's version and the lead stamps the run settled."
      note="It names the MEMBERS. The lead did not move, so 'Crew updated' would claim it did. Announced once per run on the device that started it, keyed by the settle stamp, since every such run levels to the same version."
      screen={sheet({
        crewRun: crewOnly([{ name: "minibuch", state: "done", version: LEAD_CURRENT, updatedAt: NOW - 2_000 }], NOW - 2_000),
      })}
    />
  );
}
