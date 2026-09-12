// Cache section of the states playground: the prompt-cache chip and its sheet. Split out of
// app.tsx; see that file's header comment for the whole page's rules.
//
// Every card mounts the real `CacheChip` (and, for one card, the real `CacheSheet`) with real
// `PaneCache` fixtures — never a picture of one. `fixtures.ts`'s `paneCache()` and `cacheNow` are
// what make that possible under a fixed clock: see that helper's own comment for why `expiresAt`
// is measured from the module's load time rather than a hardcoded epoch.

import { useState } from "react";

import { CacheChip } from "@/components/cache-chip";
import { CacheSheet } from "@/components/cache-sheet";
import type { PaneCache } from "@/lib/types";
import { cacheNow, homeCrew, paneCache } from "../fixtures";
import { Card, Group, PackedRootRouter, Section, Stage, type SectionDef } from "../harness";

export const DEF: SectionDef = {
  id: "cache",
  title: "Cache",
  intent:
    "The prompt-cache chip's readings — warm, expiring, cold and the empty slot — plus how " +
    "confidence, an operator override and a peer's own ink change what it wears, and the sheet " +
    "it opens into.",
};

const MIN = 60_000;

function ChipStage({ cache, host }: { cache: PaneCache | undefined; host?: string }) {
  return (
    <Stage height={72}>
      <div className="flex h-full items-center p-4">
        <CacheChip cache={cache} host={host} />
      </div>
    </Stage>
  );
}

export function CacheSection() {
  return (
    <Section def={DEF}>
      <Group title="Readings">
        <Card
          state="cache-warm"
          label="cache chip, warm"
          reach="open a pane whose harness just took a turn — the header chip counts down the minutes
            left on the cache window."
        >
          <ChipStage cache={paneCache({ state: "warm", expiresAt: cacheNow + 8 * MIN })} />
        </Card>

        <Card
          state="cache-expiring"
          label="cache chip, expiring"
          reach="wait most of the way through a pane's cache window without another turn — inside the
            last quarter of the TTL the chip's tone turns to the app's amber."
          note="10-minute rule, 2 minutes left — inside the 2.5-minute (last-quarter) mark
            `lib/cache-view.ts` switches the tone on."
        >
          <ChipStage cache={paneCache({ state: "expiring", ttlSeconds: 600, expiresAt: cacheNow + 2 * MIN })} />
        </Card>

        <Card
          state="cache-cold"
          label="cache chip, cold"
          reach="come back to a pane after its cache window has lapsed, or after a turn the bridge saw
            miss the cache outright."
        >
          <ChipStage cache={paneCache({ state: "cold" })} />
        </Card>

        <Card
          state="cache-unknown"
          label="cache chip, no reading — nothing renders"
          reach="a pane whose harness has no journal adapter, that never named a session, or whose
            agent has not taken a turn yet. There is no placeholder for this: the chip returns
            `null` (ADR 0041), so the empty slot below IS the state, not a gap in the fixture."
        >
          <ChipStage cache={undefined} />
        </Card>
      </Group>

      <Group title="Confidence and overrides">
        <Card
          state="cache-measured"
          label="cache chip, an observed reading"
          reach="the sheet's confidence row, on a rule whose number came from a run someone actually
            measured rather than a vendor's documentation."
        >
          <ChipStage
            cache={paneCache({
              state: "warm",
              expiresAt: cacheNow + 8 * MIN,
              confidence: "observed",
              measuredAt: cacheNow - 4 * MIN,
            })}
          />
        </Card>

        <Card
          state="cache-overridden"
          label="cache chip, an operator override"
          reach="an operator who set their own TTL in `cache-rules.toml`. The small dot beside the
            number is the house pattern for a qualifying mark; a screen reader gets the word instead."
        >
          <ChipStage
            cache={paneCache({ state: "warm", expiresAt: cacheNow + 8 * MIN, overridden: true })}
          />
        </Card>
      </Group>

      <Group title="A peer's ink, and the sheet">
        <Card
          state="cache-peer"
          label="cache chip, on a peer's pane"
          reach="a crew dashboard, a pane hosted on another machine. The number is computed on that
            machine with its own rules; the chip wears that machine's ink instead of a coloured dot
            of its own."
        >
          <PackedRootRouter data={homeCrew}>
            <ChipStage cache={paneCache({ state: "warm", expiresAt: cacheNow + 8 * MIN })} host="attic" />
          </PackedRootRouter>
        </Card>

        <Card
          state="cache-sheet"
          label="cache sheet, the short form"
          reach="tap the header chip. The sheet asks `GET /api/cache-rules` once per document for the
            source citation; here, with no bridge behind the playground, that fetch fails and the
            sheet is left with the short form it always falls back to."
        >
          <CacheSheetCard />
        </Card>
      </Group>
    </Section>
  );
}

function CacheSheetCard() {
  const [open, setOpen] = useState(true);
  const cache = paneCache({ state: "warm", expiresAt: cacheNow + 8 * MIN });
  return (
    <Stage height={280}>
      <div className="flex h-full flex-col">
        <div className="flex items-center p-4">
          <CacheChip cache={cache} variant="button" onOpen={() => setOpen(true)} />
        </div>
        <CacheSheet open={open} onClose={() => setOpen(false)} cache={cache} />
      </div>
    </Stage>
  );
}
