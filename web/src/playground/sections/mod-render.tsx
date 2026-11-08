// The Mod render section of the states playground (M94 slice 02): every core node kind from the schema's
// fixtures, the legs and the tracker views, the part frame in each of its states, the busy and unknown
// taps, the placeholder, and the mod mark in every tone. Each card mounts the REAL renderer at 390 px on
// the page colour. The two tap cards run a store of their own over a stand-in transport, so a tap shows
// Collie's busy state for a moment and then the receipt.
//
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import { useEffect, useMemo, type ReactNode } from "react";

import { LEGS_DOCUMENT, TRACKER_DOCUMENT, nodeDocument } from "@/lib/mods/fixtures";
import { ModMark } from "@/lib/mods/mark";
import { ModView, PartFrame } from "@/lib/mods/part-frame";
import { Placeholder, renderView, type RenderCtx } from "@/lib/mods/render";
import {
  CORE_NODE_KINDS,
  TONES,
  parseModDocument,
  partKey,
  type ModPart,
  type ModTapReply,
  type NodeKind,
  type TapOutcome,
  type ViewNode,
  type WireModInfo,
  type WireModPart,
} from "@/lib/mods/schema";
import { createModsStore, type ModsStore, type TapState } from "@/lib/mods/store";
import type { JsonObject } from "@/lib/json";
import { mintRequestId } from "@/lib/worktree-name";

import { Card, Group, Section, type SectionDef } from "../layout";

export const DEF: SectionDef = {
  id: "mod-render",
  title: "Mod render",
  intent: "Every core node, two mods, the frame and the mark, at 390 px.",
};

/** The fixtures' own clock, so the times read as the fixtures meant them. */
const FIXTURE_NOW = Date.parse("2026-11-08T09:41:00Z");

function sessionParts(doc: JsonObject): ModPart[] {
  return parseModDocument(doc, { afterTap: true }).parts.flatMap((p) => (p.place === "session" ? [p.part] : []));
}

function viewOf(part: ModPart | undefined): ViewNode {
  return part !== undefined && "view" in part ? part.view : { kind: "text", text: "", lines: 1 };
}

const LEGS = sessionParts(LEGS_DOCUMENT)[0];
const TRACKER = sessionParts(TRACKER_DOCUMENT)[0];
const LEGS_BELT = parseModDocument(LEGS_DOCUMENT).parts.find((p) => p.place === "belt");

function nodeOf(kind: NodeKind): ViewNode {
  return viewOf(sessionParts(nodeDocument(kind))[0]);
}

const MOD: WireModInfo = { host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt", "session"] };

function stored(value: ModPart | undefined, extra: Partial<WireModPart> = {}): WireModPart {
  const part = value ?? { at: "session", id: "legs", view: { kind: "text", text: "", lines: 1 } };
  return { host: "bluefin", mod: "legs", part: part.id, rev: 1, value: part, asOf: "2026-11-08T09:41:00Z", fresh: "90s", ...extra };
}

const IGNORE = () => {};

function ctxOf(stale: boolean, tap?: TapState): RenderCtx {
  return { partKey: "bluefin/legs/legs", modName: MOD.name, stale, tap, onTap: IGNORE, onDraft: IGNORE, onOpen: IGNORE, now: FIXTURE_NOW };
}

/** The glass: 390 px of the page colour with the page gutter, as a phone draws a mod session's body. */
function Glass({ children }: { children: ReactNode }) {
  return <div className="w-[390px] max-w-full rounded-sm border border-border bg-background px-4 py-3">{children}</div>;
}

function NodeCard({ n, kind }: { n: number; kind: NodeKind }) {
  return (
    <Card state={`mod-node-${kind}`} label={`${n} · ${kind}`}>
      <Glass>{renderView(nodeOf(kind), ctxOf(false))}</Glass>
    </Card>
  );
}

function FramedCard({ n, state, label, part, mod = MOD, tap, now, retryAt }: { n: number; state: string; label: string; part: WireModPart; mod?: WireModInfo; tap?: TapState; now: number; retryAt?: string }) {
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <Glass>
        <PartFrame part={part} mod={mod} tap={tap} onDraft={IGNORE} now={now} retryAt={retryAt}>
          {({ stale }) => renderView(viewOf(part.value), ctxOf(stale, tap))}
        </PartFrame>
      </Glass>
    </Card>
  );
}

/** How long the stand-in bridge takes to answer a tap, so the busy state is seen. */
const TAP_MS = 1500;

/** A store over a stand-in bridge that answers every tap with `outcome` after a moment. */
function tapStore(outcome: TapOutcome): ModsStore {
  const part = stored(LEGS);
  let rev = 1;
  return createModsStore({
    fetchMods: () => Promise.resolve({ rev: 1, mods: [MOD], parts: [part], present: [partKey(part)] }),
    tapMod: (_host, _mod, body) =>
      new Promise<ModTapReply>((resolve) => {
        rev += 1;
        const answer: ModTapReply = { requestId: body.requestId, outcome };
        if (outcome === "applied") answer.parts = [{ ...part, rev, asOf: new Date().toISOString() }];
        setTimeout(() => resolve(answer), TAP_MS);
      }),
    mintRequestId,
  });
}

function TapCard({ n, state, label, outcome }: { n: number; state: string; label: string; outcome: TapOutcome }) {
  const store = useMemo(() => tapStore(outcome), [outcome]);
  useEffect(() => {
    void store.syncMods(1);
  }, [store]);
  return (
    <Card state={state} label={`${n} · ${label}`}>
      <Glass>
        <ModView partKey="bluefin/legs/legs" store={store} onDraft={IGNORE} onOpen={IGNORE} now={FIXTURE_NOW} />
      </Glass>
    </Card>
  );
}

const STALE_NOW = FIXTURE_NOW + 4 * 60_000;
const BELT_MARK = LEGS_BELT?.place === "belt" ? LEGS_BELT.part.mark : { face: "23/34" };

export function ModRenderSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="Core kinds">
        {CORE_NODE_KINDS.map((kind, i) => (
          <NodeCard key={kind} n={i + 1} kind={kind} />
        ))}
      </Group>
      <Group title="Two mods">
        <Card state="mod-view-legs" label="12 · legs mod">
          <Glass>{renderView(viewOf(LEGS), ctxOf(false))}</Glass>
        </Card>
        <Card state="mod-view-tracker" label="13 · tracker mod">
          <Glass>{renderView(viewOf(TRACKER), ctxOf(false))}</Glass>
        </Card>
      </Group>
      <Group title="The frame">
        <FramedCard n={14} state="mod-frame-fresh" label="fresh" part={stored(LEGS)} now={FIXTURE_NOW} />
        <FramedCard n={15} state="mod-frame-stale" label="stale, tone gone" part={stored(LEGS)} now={STALE_NOW} />
        <FramedCard n={16} state="mod-frame-failed" label="run failed" part={stored(LEGS, { stale: true, problem: "legs.sh: exit 2: no such file ~/.cache/collie-lab/browser-leg/last.json" })} now={FIXTURE_NOW + 30_000} />
        <FramedCard n={17} state="mod-frame-paused" label="paused, retry known" part={stored(LEGS)} mod={{ ...MOD, state: "failing", error: "exit 1" }} now={FIXTURE_NOW} retryAt={new Date(FIXTURE_NOW + 5 * 60_000).toISOString()} />
        <FramedCard n={18} state="mod-frame-stopped" label="stopped" part={stored(LEGS)} mod={{ ...MOD, state: "stopped", error: "exit 1, five times" }} now={FIXTURE_NOW} />
      </Group>
      <Group title="Taps">
        <TapCard n={19} state="mod-tap-applied" label="tap, then applied" outcome="applied" />
        <TapCard n={20} state="mod-tap-unknown" label="tap, then unknown" outcome="unknown" />
        <TapCard n={21} state="mod-tap-failed" label="tap, then failed" outcome="failed" />
        <FramedCard n={22} state="mod-tap-busy" label="busy, held" part={stored(LEGS)} tap={{ phase: "busy", requestId: "r", control: "v/6", intent: "rerun" }} now={FIXTURE_NOW} />
        <Card state="mod-placeholder" label="23 · placeholder">
          <Glass>
            <Placeholder kind="hologram" />
          </Glass>
        </Card>
      </Group>
      <Group title="The mark">
        <Card state="mod-mark-tones" label="24 · every tone">
          <Glass>
            <div className="flex flex-wrap items-center gap-2">
              {TONES.map((tone) => (
                <ModMark key={tone} mark={{ ...BELT_MARK, tone }} modName={MOD.name} onTap={IGNORE} />
              ))}
            </div>
          </Glass>
        </Card>
        <Card state="mod-mark-states" label="25 · stale, busy, unknown">
          <Glass>
            <div className="flex items-center gap-2">
              <ModMark mark={BELT_MARK} modName={MOD.name} onTap={IGNORE} stale />
              <ModMark mark={BELT_MARK} modName={MOD.name} onTap={IGNORE} busy />
              <ModMark mark={BELT_MARK} modName={MOD.name} onTap={IGNORE} unknown />
              <ModMark mark={{ icon: "list", count: 3, tone: "warn" }} modName="Tracker" />
            </div>
          </Glass>
        </Card>
      </Group>
    </Section>
  );
}
