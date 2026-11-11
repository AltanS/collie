// Chapter 4 of the tricks explainer, example 1: a program trick. A tiny program trick, "Disk space", from its folder
// to the tile on the phone. The tile and the chip are the REAL trick place components, fed the document
// the program prints after the REAL parser has read it.
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useMemo, type ReactNode } from "react";

import { ModelTag } from "@/components/model-tag";
import { TrickDashboardStrip } from "@/components/trick-place-items";
import { statusItemsOf } from "@/components/trick-status-item";
import { parseTrickDocument, partKey, type WireTrickInfo, type WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { JsonObject } from "@/lib/json";
import { cn } from "@/lib/utils";

import { Chapter, P, Sub, Term } from "./chapter";
import { CodeBlock, Num, W, type Seg } from "./hues";
import { PROGRAM_FLOW } from "./flows";
import { TricksMap } from "./map";
import { Uses } from "./uses";
import { Steps, type Step } from "./steps";

const NOW = Date.now();
const IGNORE = () => {};

/** The manifest, coloured: the trick's own words in its hue, the keys that matter numbered. */
const MANIFEST: Seg[] = [
  { t: 'id = "disk-space"\nname = "Disk space"\n' },
  { t: 'run = "./program.sh"', hue: "trick", n: 1 },
  { t: "\n" },
  { t: 'every = "5m"', hue: "bridge", n: 2 },
  { t: '\nicon = "archive"\n' },
  { t: 'places = ["dashboard", "status"]', hue: "phone", n: 3 },
  { t: '\ndescription = "Room left in your home folder."\n' },
];

const PROGRAM: Seg[] = [
  { t: "#!/bin/sh\n# Disk space: how much room is left in your home folder.\n" },
  { t: "cat > /dev/null", hue: "bridge" },
  { t: "   # the facts on stdin; this trick needs none\n" },
  { t: "kb=$(df -Pk \"$HOME\" | awk 'NR==2 {print $4}')\n" },
  { t: "gb=$((kb / 1048576))\n" },
  { t: "tone=plain\n" },
  { t: "[ \"$gb\" -lt 10 ] && tone=warn\n" },
  { t: "tile='{\"icon\":\"archive\",\"label\":\"Disk\",\"badge\":\"'$gb' GB\",\"tone\":\"'$tone'\"}'\n" },
  { t: "chip='{\"icon\":\"archive\",\"text\":\"'$gb' GB free\",\"tone\":\"'$tone'\"}'\n" },
  { t: "echo", hue: "trick", n: 4 },
  { t: " '{\"v\":1,\"fresh\":\"15m\",\"parts\":['\n" },
  { t: "echo ' {\"at\":\"dashboard\",\"id\":\"dashboard\",\"item\":'\"$tile\"'},'\n" },
  { t: "echo ' {\"at\":\"status\",\"id\":\"status\",\"chip\":'\"$chip\"'}]}'\n" },
];

/** What the program prints on a machine with 38 GB free. */
const PRINTED: JsonObject = {
  v: 1,
  fresh: "15m",
  parts: [
    { at: "dashboard", id: "dashboard", item: { icon: "archive", label: "Disk", badge: "38 GB", tone: "plain" } },
    { at: "status", id: "status", chip: { text: "38 GB free", icon: "archive", tone: "plain" } },
  ],
};

const PRINTED_SEGS: Seg[] = [
  { t: '{ "v": 1, "fresh": "15m",\n  "parts": [\n    { ' },
  { t: '"at": "dashboard"', hue: "phone", n: 5 },
  { t: ', "id": "dashboard",\n      "item": { "icon": "archive",\n        ' },
  { t: '"label": "Disk", "badge": "38 GB"', hue: "phone" },
  { t: ',\n        "tone": "plain" } },\n    { ' },
  { t: '"at": "status"', hue: "phone", n: 6 },
  { t: ', "id": "status",\n      "chip": { "icon": "archive",\n        ' },
  { t: '"text": "38 GB free"', hue: "phone" },
  { t: ', "tone": "plain" } } ] }' },
];

/** The same document with one part in a place this Collie does not know: the parser leaves it out. */
const WITH_UNKNOWN: JsonObject = {
  ...PRINTED,
  parts: [
    { at: "dashboard", id: "dashboard", item: { icon: "archive", label: "Disk", badge: "38 GB", tone: "plain" } },
    { at: "status", id: "status", chip: { text: "38 GB free", icon: "archive", tone: "plain" } },
    { at: "popup", id: "popup", text: "Disk almost full!" },
  ],
};

const DISK: WireTrickInfo = { host: "workshop", id: "disk-space", name: "Disk space", icon: "archive", on: true, state: "ok", places: ["dashboard", "status"] };

/** The parts the bridge keeps, as the phone receives them: the real parser's output, wrapped for the wire. */
function wireParts(): WireTrickPart[] {
  const parsed = parseTrickDocument(PRINTED);
  return parsed.parts.map(({ part }) => ({ host: "workshop", trick: "disk-space", part: part.id, rev: 1, value: part, asOf: new Date(NOW - 30_000).toISOString(), fresh: "15m" }));
}

/** The disk trick's store, and the parts it holds. */
interface DiskStore {
  store: TricksStore;
  parts: WireTrickPart[];
}

function useDiskStore(): DiskStore {
  const parts = useMemo(wireParts, []);
  const store = useMemo(
    () =>
      createTricksStore({
        fetchTricks: () => Promise.resolve({ rev: 1, tricks: [DISK], parts, present: parts.map(partKey) }),
        tapTrick: () => Promise.reject(new Error("no taps here")),
        mintRequestId: () => "explainer",
      }),
    [parts],
  );
  useEffect(() => {
    void store.syncTricks(1);
  }, [store]);
  return { store, parts };
}

/** The phone's two places this trick draws in: the Dashboard's strip of tiles and the status line. */
function DiskOnPhone({ drawn }: { drawn: boolean }) {
  const { store, parts } = useDiskStore();
  const status = useMemo(() => statusItemsOf({ parts: parts.filter((p) => p.value.at === "status"), sessions: [], onOpenSession: IGNORE, store }), [parts, store]);
  // Both places keep their room before the parts are drawn, so nothing moves when they appear.
  const fade = cn("transition-opacity duration-700 motion-reduce:transition-none", drawn ? "opacity-100" : "opacity-0");
  return (
    <div className="w-full max-w-[390px] rounded-sm border border-rule bg-background">
      <p className="border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">phone · Dashboard</p>
      <div className={cn("min-h-[88px] px-3", fade)} aria-hidden={!drawn}>
        <TrickDashboardStrip sessions={[]} onOpenSession={IGNORE} store={store} />
      </div>
      <p className="border-t border-border px-3 pt-2 font-mono text-[11px] text-muted-foreground">phone · a session's status line</p>
      <div className={cn("relative h-10 overflow-hidden", fade)} aria-hidden={!drawn}>
        <ModelTag model={undefined} trailing={status} />
      </div>
    </div>
  );
}

const RUN_STEPS: Step[] = [
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W>'s timer fires, five minutes after the last run. It runs a trick on a timer only while a phone is looking.</> },
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> starts <code className="font-mono text-[13px]">program.sh</code> on your machine and hands it the facts on stdin: your sessions, your spaces, why it runs.</> },
  { hue: "trick", text: <>The <W hue="trick">program</W> prints one JSON document and exits. It has 10 seconds and 64 KiB.</> },
  { hue: "bridge", text: <>The <W hue="bridge">bridge</W> reads the document against Collie's closed list of places and parts. Anything it does not know is left out, with a note.</> },
  { hue: "phone", text: <>The <W hue="phone">phone</W> draws a tile and a chip with Collie's own parts. No code from the trick reaches the phone.</> },
];



/** The check, as the real parser reports it on a document with one part it does not know. */
function CheckReport() {
  const parsed = useMemo(() => parseTrickDocument(WITH_UNKNOWN), []);
  return (
    <figure className="rounded-sm border border-border bg-card">
      <figcaption className="border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
        the bridge's check, on a document with a third part in an unknown place
      </figcaption>
      <ul className="space-y-1 px-3 py-2 text-sm">
        {parsed.parts.map(({ place, part }) => (
          <li key={part.id} className="flex gap-2">
            <span className="font-semibold text-status-done">kept</span>
            <span className="font-mono text-[13px]">{place}</span>
          </li>
        ))}
        {parsed.refusals.map((r) => (
          <li key={r.path} className="flex gap-2">
            <span className="font-semibold text-muted-foreground">left out</span>
            <span className="min-w-0">
              <span className="font-mono text-[13px]">{r.path}</span> {r.reason}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Panel({ n, title, children }: { n: number; title: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-2">
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span className="font-mono text-muted-foreground">{n}</span>
        {title}
      </p>
      {children}
    </div>
  );
}

export function SimpleChapter() {
  return (
    <Chapter at="simple" lead="A trick prints data. The phone draws it with Collie's own parts.">
      <P>
        Here is a whole trick, <Term>Disk space</Term>. It shows how much room is left in your home folder, as a tile on the Dashboard (Collie's home screen) and
        as a chip in the status line of each session. It is one folder with two files.
      </P>
      <Uses places={["dashboard", "status"]} parts={["item", "chip"]} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel n={1} title="trick.toml, the manifest">
          <CodeBlock title="~/.config/collie/tricks/disk-space/trick.toml" segs={MANIFEST} />
        </Panel>
        <ul className="space-y-2 text-[15px] lg:pt-9">
          <li className="flex gap-2"><Num n={1} hue="trick" /> <span>What to run. The <W hue="trick">trick author</W> wrote it.</span></li>
          <li className="flex gap-2"><Num n={2} hue="bridge" /> <span>How often. The <W hue="bridge">bridge</W> keeps the timer.</span></li>
          <li className="flex gap-2"><Num n={3} hue="phone" /> <span>Where it may draw on the <W hue="phone">phone</W>. Nowhere else.</span></li>
        </ul>
        <div className="lg:col-span-2">
          <Panel n={2} title="program.sh, the program">
            <CodeBlock title="program.sh" segs={PROGRAM} />
            <p className="flex gap-2 text-[15px]"><Num n={4} hue="trick" /> <span>It prints its answer and exits. That is all a program does. The first line throws away the facts the <W hue="bridge">bridge</W> handed it, because this trick needs none.</span></p>
          </Panel>
        </div>
        <Panel n={3} title="What it prints">
          <CodeBlock title="stdout" segs={PRINTED_SEGS} />
          <ul className="space-y-1 text-[15px]">
            <li className="flex gap-2"><Num n={5} hue="phone" /> <span>A tile on the Dashboard, with a label and a badge.</span></li>
            <li className="flex gap-2"><Num n={6} hue="phone" /> <span>A chip in the status line.</span></li>
          </ul>
        </Panel>
        <Panel n={4} title="What the phone draws">
          <DiskOnPhone drawn />
          <p className="text-sm text-muted-foreground">The real tile and the real chip, drawn from the document beside it after the real check.</p>
        </Panel>
      </div>

      <Sub>One run, step by step</Sub>
      <Steps label="One run of a trick" steps={RUN_STEPS} renderAside={(step, all) => <DiskOnPhone drawn={all || step >= 4} />}>
        {(step, all) => <TricksMap label="The map, lit for one run of a trick" focus={all ? { lit: ["bridge", "trick", "phone"] } : (PROGRAM_FLOW[step] ?? {})} />}
      </Steps>

      <CheckReport />

      <P>
        The <Term>bridge</Term> is Collie's own program on your machine. The phone talks to it and to nothing else. It runs the trick, reads what it prints, and keeps
        only what fits Collie's closed list of parts. The phone then draws those parts itself. So <strong>no code from a trick ever runs on your phone</strong>, and a
        trick cannot change how Collie looks.
      </P>
      <P>
        A trick can be this small, or it can be bigger. Real ones list your open pull requests, or the builds that run in your sessions now. They all work the same
        way: a program prints data, and Collie draws it.
      </P>
    </Chapter>
  );
}
