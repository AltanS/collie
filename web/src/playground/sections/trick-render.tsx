// The Trick render section of the states playground (M94 slice 02): every core node kind from the schema's
// fixtures, the legs and the tracker views, the part frame in each of its states, the busy and unknown
// taps, the placeholder, and the trick mark in every tone. Each card mounts the REAL renderer at 390 px on
// the page colour. The two tap cards run a store of their own over a stand-in transport, so a tap shows
// Collie's busy state for a moment and then the receipt.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useMemo, type ReactNode } from "react";

import { LEGS_DOCUMENT, TRACKER_DOCUMENT, nodeDocument } from "@/lib/tricks/fixtures";
import { TrickMark } from "@/lib/tricks/mark";
import { TrickView, PartFrame } from "@/lib/tricks/part-frame";
import { Placeholder, renderView, type RenderCtx } from "@/lib/tricks/render";
import {
  CORE_NODE_KINDS,
  TONES,
  parseTrickDocument,
  partKey,
  type TrickPart,
  type TrickTapReply,
  type NodeKind,
  type TapOutcome,
  type ViewNode,
  type WireTrickInfo,
  type WireTrickPart,
} from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore, type TapState } from "@/lib/tricks/store";
import type { JsonObject } from "@/lib/json";
import { mintRequestId } from "@/lib/worktree-name";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "trick-render",
  title: "Trick render",
  intent: "Every core node, two tricks, the frame and the mark, at 390 px.",
};

/** The fixtures' own clock, so the times read as the fixtures meant them. */
const FIXTURE_NOW = Date.parse("2026-11-08T09:41:00Z");

function sessionParts(doc: JsonObject): TrickPart[] {
  return parseTrickDocument(doc, { afterTap: true }).parts.flatMap((p) => (p.place === "session" ? [p.part] : []));
}

function viewOf(part: TrickPart | undefined): ViewNode {
  return part !== undefined && "view" in part ? part.view : { kind: "text", text: "", lines: 1 };
}

const LEGS = sessionParts(LEGS_DOCUMENT)[0];
const TRACKER = sessionParts(TRACKER_DOCUMENT)[0];
const LEGS_BELT = parseTrickDocument(LEGS_DOCUMENT).parts.find((p) => p.place === "belt");

function nodeOf(kind: NodeKind): ViewNode {
  return viewOf(sessionParts(nodeDocument(kind))[0]);
}

const TRICK: WireTrickInfo = { host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"] };

function stored(value: TrickPart | undefined, extra: Partial<WireTrickPart> = {}): WireTrickPart {
  const part = value ?? { at: "session", id: "legs", view: { kind: "text", text: "", lines: 1 } };
  return { host: "bluefin", trick: "legs", part: part.id, rev: 1, value: part, asOf: "2026-11-08T09:41:00Z", fresh: "90s", ...extra };
}

const IGNORE = () => {};

function ctxOf(stale: boolean, tap?: TapState): RenderCtx {
  return { partKey: "bluefin/legs/legs", trickName: TRICK.name, stale, tap, onTap: IGNORE, onDraft: IGNORE, onOpen: IGNORE, now: FIXTURE_NOW };
}

/** The glass: 390 px of the page colour with the page gutter, as a phone draws a trick session's body. */
function Glass({ children }: { children: ReactNode }) {
  return <div className="w-[390px] max-w-full rounded-sm border border-border bg-background px-4 py-3">{children}</div>;
}

function NodeCard({ n, kind }: { n: number; kind: NodeKind }) {
  return (
    <Card state={`trick-node-${kind}`} label={`${n} · ${kind}`}>
      <Glass>{renderView(nodeOf(kind), ctxOf(false))}</Glass>
    </Card>
  );
}

function FramedCard({ n, state, label, part, trick = TRICK, tap, now, retryAt }: { n: number; state: string; label: string; part: WireTrickPart; trick?: WireTrickInfo; tap?: TapState; now: number; retryAt?: string }) {
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <Glass>
        <PartFrame part={part} trick={trick} tap={tap} onDraft={IGNORE} now={now} retryAt={retryAt}>
          {({ stale }) => renderView(viewOf(part.value), ctxOf(stale, tap))}
        </PartFrame>
      </Glass>
    </Card>
  );
}

/** How long the stand-in bridge takes to answer a tap, so the busy state is seen. */
const TAP_MS = 1500;

/** A store over a stand-in bridge that answers every tap with `outcome` after a moment. */
function tapStore(outcome: TapOutcome): TricksStore {
  const part = stored(LEGS);
  let rev = 1;
  return createTricksStore({
    fetchTricks: () => Promise.resolve({ rev: 1, tricks: [TRICK], parts: [part], present: [partKey(part)] }),
    tapTrick: (_host, _trick, body) =>
      new Promise<TrickTapReply>((resolve) => {
        rev += 1;
        const answer: TrickTapReply = { requestId: body.requestId, outcome };
        if (outcome === "applied") answer.parts = [{ ...part, rev, asOf: new Date().toISOString() }];
        setTimeout(() => resolve(answer), TAP_MS);
      }),
    mintRequestId,
  });
}

function TapCard({ n, state, label, outcome }: { n: number; state: string; label: string; outcome: TapOutcome }) {
  const store = useMemo(() => tapStore(outcome), [outcome]);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <Glass>
        <TrickView partKey="bluefin/legs/legs" store={store} onDraft={IGNORE} onOpen={IGNORE} now={FIXTURE_NOW} />
      </Glass>
    </Card>
  );
}

const STALE_NOW = FIXTURE_NOW + 4 * 60_000;
const BELT_MARK = LEGS_BELT?.place === "belt" ? LEGS_BELT.part.mark : { face: "23/34" };

export function TrickRenderSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="Core kinds">
        {CORE_NODE_KINDS.map((kind, i) => (
          <NodeCard key={kind} n={i + 1} kind={kind} />
        ))}
      </Group>
      <Group title="Two tricks">
        <Card state="trick-view-legs" label="12 · legs trick">
          <Glass>{renderView(viewOf(LEGS), ctxOf(false))}</Glass>
        </Card>
        <Card state="trick-view-tracker" label="13 · tracker trick">
          <Glass>{renderView(viewOf(TRACKER), ctxOf(false))}</Glass>
        </Card>
      </Group>
      <Group title="The frame">
        <FramedCard n={14} state="trick-frame-fresh" label="fresh" part={stored(LEGS)} now={FIXTURE_NOW} />
        <FramedCard n={15} state="trick-frame-stale" label="stale, tone gone" part={stored(LEGS)} now={STALE_NOW} />
        <FramedCard n={16} state="trick-frame-failed" label="run failed" part={stored(LEGS, { stale: true, problem: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json" })} now={FIXTURE_NOW + 30_000} />
        <FramedCard n={17} state="trick-frame-paused" label="paused, retry known" part={stored(LEGS)} trick={{ ...TRICK, state: "failing", error: "exit 1" }} now={FIXTURE_NOW} retryAt={new Date(FIXTURE_NOW + 5 * 60_000).toISOString()} />
        <FramedCard n={18} state="trick-frame-stopped" label="stopped" part={stored(LEGS)} trick={{ ...TRICK, state: "stopped", error: "exit 1, five times" }} now={FIXTURE_NOW} />
      </Group>
      <Group title="Taps">
        <TapCard n={19} state="trick-tap-applied" label="tap, then applied" outcome="applied" />
        <TapCard n={20} state="trick-tap-unknown" label="tap, then unknown" outcome="unknown" />
        <TapCard n={21} state="trick-tap-failed" label="tap, then failed" outcome="failed" />
        <FramedCard n={22} state="trick-tap-busy" label="busy, held" part={stored(LEGS)} tap={{ phase: "busy", requestId: "r", control: "v/6", intent: "rerun" }} now={FIXTURE_NOW} />
        <Card state="trick-placeholder" label="23 · placeholder">
          <Glass>
            <Placeholder kind="hologram" />
          </Glass>
        </Card>
      </Group>
      <Group title="The mark">
        <Card state="trick-mark-tones" label="24 · every tone">
          <Glass>
            <div className="flex flex-wrap items-center gap-2">
              {TONES.map((tone) => (
                <TrickMark key={tone} mark={{ ...BELT_MARK, tone }} trickName={TRICK.name} onTap={IGNORE} />
              ))}
            </div>
          </Glass>
        </Card>
        <Card state="trick-mark-states" label="25 · stale, busy, unknown">
          <Glass>
            <div className="flex items-center gap-2">
              <TrickMark mark={BELT_MARK} trickName={TRICK.name} onTap={IGNORE} stale />
              <TrickMark mark={BELT_MARK} trickName={TRICK.name} onTap={IGNORE} busy />
              <TrickMark mark={BELT_MARK} trickName={TRICK.name} onTap={IGNORE} unknown />
              <TrickMark mark={{ icon: "list", count: 3, tone: "warn" }} trickName="Tracker" />
            </div>
          </Glass>
        </Card>
      </Group>
    </Section>
  );
}
