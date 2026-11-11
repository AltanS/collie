// The Trick render section of the states playground (M94 slice 02, re-cut 2026-11-08): every node kind of
// the Tree UI vocabulary from the schema's fixtures, the legs and the tracker views, the part frame in
// each of its states, the busy and unknown taps, the placeholder, and the trick mark in every tone. Each card mounts the REAL renderer at 390 px on
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
  NODE_KINDS,
  TAP_REFUSALS,
  TONES,
  parseTrickDocument,
  partKey,
  type TrickPart,
  type TrickTapReply,
  type NodeKind,
  type TapCode,
  type View,
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
  return parseTrickDocument(doc).parts.flatMap((p) => (p.place === "session" ? [p.part] : []));
}

function viewOf(part: TrickPart | undefined): View {
  return part !== undefined && "view" in part ? part.view : [];
}

const LEGS = sessionParts(LEGS_DOCUMENT)[0];
const TRACKER = sessionParts(TRACKER_DOCUMENT)[0];
const LEGS_BELT = parseTrickDocument(LEGS_DOCUMENT).parts.find((p) => p.place === "belt");

function nodeOf(kind: NodeKind): View {
  return viewOf(sessionParts(nodeDocument(kind))[0]);
}

const TRICK: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"] };

function stored(value: TrickPart | undefined, extra: Partial<WireTrickPart> = {}): WireTrickPart {
  const part = value ?? { at: "session", id: "legs", view: [] };
  return { host: "lodge", trick: "legs", part: part.id, rev: 1, value: part, asOf: "2026-11-08T09:41:00Z", fresh: "90s", ...extra };
}

const IGNORE = () => {};

function ctxOf(stale: boolean, tap?: TapState): RenderCtx {
  return { partKey: "lodge/legs/legs", stale, tap, onTap: IGNORE, onLink: IGNORE, now: FIXTURE_NOW };
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
        <PartFrame part={part} trick={trick} tap={tap} now={now} retryAt={retryAt}>
          {({ stale }) => renderView(viewOf(part.value), ctxOf(stale, tap))}
        </PartFrame>
      </Glass>
    </Card>
  );
}

/** How long the stand-in bridge takes to answer a tap, so the busy state is seen. */
const TAP_MS = 1500;

/** A store over a stand-in bridge that answers every tap with `code` after a moment. */
function tapStore(code: TapCode): TricksStore {
  const part = stored(LEGS);
  let rev = 1;
  return createTricksStore({
    fetchTricks: () => Promise.resolve({ rev: 1, tricks: [TRICK], parts: [part], present: [partKey(part)] }),
    tapTrick: (_host, _trick, body) =>
      new Promise<TrickTapReply>((resolve) => {
        rev += 1;
        const answer: TrickTapReply = { rid: body.rid, code };
        if (code === "ok") answer.parts = [{ ...part, rev, asOf: new Date().toISOString() }];
        setTimeout(() => resolve(answer), TAP_MS);
      }),
    mintRequestId,
  });
}

function TapCard({ n, state, label, code }: { n: number; state: string; label: string; code: TapCode }) {
  const store = useMemo(() => tapStore(code), [code]);
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <Glass>
        <TrickView partKey="lodge/legs/legs" store={store} onLink={IGNORE} now={FIXTURE_NOW} />
      </Glass>
    </Card>
  );
}

const STALE_NOW = FIXTURE_NOW + 4 * 60_000;
const BELT_MARK = LEGS_BELT?.place === "belt" ? LEGS_BELT.part.mark : { label: "23/34" };
/** The legs trick's "Rerun red" button: the first node of the last bar, at path `v/5/0`. */
const RERUN_CONTROL = "v/5/0";

export function TrickRenderSection(): ReactNode {
  const kinds = NODE_KINDS.length;
  return (
    <Section def={DEF}>
      <Group title="Every node kind">
        {NODE_KINDS.map((kind, i) => (
          <NodeCard key={kind} n={i + 1} kind={kind} />
        ))}
      </Group>
      <Group title="Two tricks">
        <Card state="trick-view-legs" label={`${kinds + 1} · legs trick`}>
          <Glass>{renderView(viewOf(LEGS), ctxOf(false))}</Glass>
        </Card>
        <Card state="trick-view-tracker" label={`${kinds + 2} · tracker trick`}>
          <Glass>{renderView(viewOf(TRACKER), ctxOf(false))}</Glass>
        </Card>
      </Group>
      <Group title="The frame">
        <FramedCard n={kinds + 3} state="trick-frame-fresh" label="fresh" part={stored(LEGS)} now={FIXTURE_NOW} />
        <FramedCard n={kinds + 4} state="trick-frame-stale" label="stale, tone gone" part={stored(LEGS)} now={STALE_NOW} />
        <FramedCard n={kinds + 5} state="trick-frame-failed" label="run failed" part={stored(LEGS, { stale: true, problem: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json" })} now={FIXTURE_NOW + 30_000} />
        <FramedCard n={kinds + 6} state="trick-frame-paused" label="paused, retry known" part={stored(LEGS)} trick={{ ...TRICK, state: "failing", error: "exit 1" }} now={FIXTURE_NOW} retryAt={new Date(FIXTURE_NOW + 5 * 60_000).toISOString()} />
        <FramedCard n={kinds + 7} state="trick-frame-stopped" label="stopped" part={stored(LEGS)} trick={{ ...TRICK, state: "stopped", error: "exit 1, five times" }} now={FIXTURE_NOW} />
      </Group>
      <Group title="Taps">
        <TapCard n={kinds + 8} state="trick-tap-ok" label="tap, then ok" code="ok" />
        <TapCard n={kinds + 9} state="trick-tap-unknown" label="tap, then unknown" code="unknown" />
        <TapCard n={kinds + 10} state="trick-tap-rejected" label="tap, then rejected" code="rejected" />
        <FramedCard n={kinds + 11} state="trick-tap-busy" label="busy, held" part={stored(LEGS)} tap={{ phase: "busy", rid: "r", control: RERUN_CONTROL, intent: "rerun" }} now={FIXTURE_NOW} />
        <FramedCard n={kinds + 12} state="trick-tap-unknown-held" label="unknown, shown" part={stored(LEGS)} tap={{ phase: "unknown", rid: "r", control: RERUN_CONTROL, intent: "rerun" }} now={FIXTURE_NOW} />
        <FramedCard n={kinds + 13} state="trick-tap-failed-held" label="tap failed, reason" part={stored(LEGS)} tap={{ phase: "failed", rid: "r", control: RERUN_CONTROL, intent: "rerun", message: "legs.sh: exit 1: the log is locked" }} now={FIXTURE_NOW} />
        <Card state="trick-placeholder" label={`${kinds + 14} · placeholder`}>
          <Glass>
            <Placeholder kind="hologram" />
          </Glass>
        </Card>
      </Group>
      <Group title="The mark">
        <Card state="trick-mark-tones" label={`${kinds + 15} · every tone`}>
          <Glass>
            <div className="flex flex-wrap items-center gap-2">
              {TONES.map((tone) => (
                <TrickMark key={tone} mark={{ ...BELT_MARK, tone }} trickName={TRICK.name} onTap={IGNORE} />
              ))}
            </div>
          </Glass>
        </Card>
        <Card state="trick-mark-states" label={`${kinds + 16} · stale, busy, unknown`}>
          <Glass>
            <div className="flex items-center gap-2">
              <TrickMark mark={BELT_MARK} trickName={TRICK.name} onTap={IGNORE} stale />
              <TrickMark mark={BELT_MARK} trickName={TRICK.name} onTap={IGNORE} busy />
              <TrickMark mark={BELT_MARK} trickName={TRICK.name} onTap={IGNORE} unknown />
              <TrickMark mark={{ icon: "flag", badge: "3", tone: "warn" }} trickName="Tracker" />
            </div>
          </Glass>
        </Card>
      </Group>
      {/* Fault A: the bridge refused a tap before anything ran; the frame's reserved line says why, in Collie's words. */}
      <Group title="Taps the bridge refused">
        {TAP_REFUSALS.map((word, i) => (
          <FramedCard
            key={word}
            n={kinds + 17 + i}
            state={`trick-tap-refused-${word}`}
            label={`refused: ${word}`}
            part={stored(LEGS)}
            tap={{ phase: "failed", rid: "r", control: RERUN_CONTROL, intent: "rerun", message: "m", refused: word }}
            now={FIXTURE_NOW}
          />
        ))}
      </Group>
    </Section>
  );
}
