import { existsSync } from "node:fs";

import { HILL_BODY_MAX, type HillDecision } from "../../web/src/lib/hill/wire.ts";
import type { HillMediaFile } from "../hill/media.ts";
import { hillSwitchPath, writeHillSwitch } from "../hill/switch.ts";
import { hillCrewStatePath, writeHillCrewState } from "../hill/crew-state.ts";
import { mergeCarriedMap } from "../tricks/hill.ts";
import type { StandbyHillStore } from "./standby-hill.ts";

// THE PERSON'S TAP BRINGS THE LEAD'S OPEN DECISIONS ALONG (CREW_PROTOCOL §25). Run inside the takeover
// commit (and `collie promote`), after the tricks were started (carry-adopt.ts), because a trick's
// Decision stays open only when its trick started here.
//
// Each carried Decision keeps its id. Pictures are read again off this machine's disk and their type read
// again from their bytes; one that is not here leaves the Decision with a line that says so. A trick's
// Decision whose trick did not start here closes instead, with its reason. The copy holds no Collie card
// but the carried notice (standby-hill.ts `readCarriedRecord`); the ones it dropped are counted.
// A trick Decision that stays is moved to this machine (`memberId`, `trickHost`), and its key's map
// entry comes along, so the trick does not post it again. Nothing is pushed: they are not new. The Hill's
// switch and the crew state come along too, each only when this machine holds none of its own.

/** The line a Decision carries when a picture of it did not come along. */
export function pictureStayed(lead: string): string {
  return `A picture stayed on ${lead}.`;
}
export const TRICK_NOT_STARTED = "Its trick did not start on this machine after the takeover.";

/** What the tap needs of this machine's Hill (hill/service.ts `adoptCarried`). */
export interface AdoptHillPort {
  adoptCarried(decisions: readonly HillDecision[], media: ReadonlyMap<string, readonly HillMediaFile[]>): string[];
}

export interface AdoptHillOptions {
  readonly store: StandbyHillStore;
  readonly hill: AdoptHillPort;
  /** The lead the copy is from. */
  readonly lead: string;
  /** This machine's member id and display name: a trick Decision that stays runs here now. */
  readonly self: string;
  readonly machine: string;
  /** The tricks the tap started here. */
  readonly started: ReadonlySet<string>;
  readonly stateDir: string;
  readonly now: () => number;
}

export interface AdoptHillResult {
  /** Decisions stored open. */
  readonly open: number;
  /** Decisions stored closed, with their reason. */
  readonly closed: number;
  /** Collie cards of the lead's list the copy did not hold. */
  readonly dropped: number;
}

function withNote(decision: HillDecision, note: string): HillDecision {
  const room = HILL_BODY_MAX - note.length - 2;
  const kept = decision.body.length > room ? decision.body.slice(0, Math.max(0, room)) : decision.body;
  return { ...decision, body: kept === "" ? note : `${kept}\n\n${note}` };
}

function closed(decision: HillDecision, reason: string, at: number): HillDecision {
  return { ...decision, state: "withdrawn", closedAt: at, closedReason: reason };
}

/** Bring the carried Decisions into this machine's Hill. Never throws; a copy from another lead brings nothing. */
export async function adoptCarriedHill(opts: AdoptHillOptions): Promise<AdoptHillResult> {
  const index = await opts.store.load();
  if (index === null || index.from !== opts.lead) return { open: 0, closed: 0, dropped: 0 };
  const at = opts.now();
  const out: HillDecision[] = [];
  const media = new Map<string, HillMediaFile[]>();
  for (const carried of index.decisions.toSorted((a, b) => a.at - b.at)) {
    const trickId = carried.from.kind === "trick" ? carried.from.trickId : null;
    if (trickId !== null && !opts.started.has(trickId)) {
      out.push(closed(carried, TRICK_NOT_STARTED, at));
      continue;
    }
    const files: HillMediaFile[] = [];
    const kept: HillDecision["media"] = [];
    for (const m of carried.media) {
      const bytes = await opts.store.mediaBytes(carried.id, m);
      if (bytes === null) continue;
      files.push({ id: m.id, bytes });
      kept.push(m);
    }
    let decision: HillDecision = { ...carried, media: kept };
    if (kept.length < carried.media.length) decision = withNote(decision, pictureStayed(opts.lead));
    if (trickId !== null) decision = { ...decision, from: { ...decision.from, memberId: opts.self, trickHost: opts.self, host: opts.machine } };
    if (files.length > 0) media.set(decision.id, files);
    out.push(decision);
  }
  const stored = new Set(opts.hill.adoptCarried(out, media));
  const startedWithDecisions = new Set(out.flatMap((d) => (d.state === "open" && stored.has(d.id) && d.from.trickId !== null ? [d.from.trickId] : [])));
  mergeCarriedMap(opts.stateDir, index.tricks, startedWithDecisions);
  // The switch moves with the crown; a machine that already chose for itself keeps its own choice.
  if (!existsSync(hillSwitchPath(opts.stateDir))) writeHillSwitch(opts.stateDir, index.on, at);
  // The crew state too (1.29.0), with the lead's time and setter, so "Tell all sessions now" is offered
  // again here for a quiet or away the sessions of this machine were never told of.
  if (index.crewState !== null && !existsSync(hillCrewStatePath(opts.stateDir))) writeHillCrewState(opts.stateDir, { state: index.crewState.state, by: index.crewState.by, at: index.crewState.at }, at);
  const closedStored = out.filter((d) => d.state !== "open" && stored.has(d.id)).length;
  return { open: stored.size - closedStored, closed: closedStored, dropped: index.dropped };
}
