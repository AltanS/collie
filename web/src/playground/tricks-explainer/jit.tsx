// Chapter 3 of the tricks explainer: just-in-time UI. What it means, why data in a closed vocabulary
// makes it safe, and the vocabulary itself as a catalogue: every node kind with a sample drawn by the
// REAL renderer from the tricks' own fixtures.
// DEV-ONLY, like the rest of `src/playground/`.

import { useMemo } from "react";

import { nodeDocument } from "@/lib/tricks/fixtures";
import { renderView, type RenderCtx } from "@/lib/tricks/render";
import { NODE_KINDS, parseTrickDocument, type NodeKind, type View } from "@/lib/tricks/schema";
import { cn } from "@/lib/utils";

import { FigureSlot } from "../explainer-figures";
import { Chapter, P, Sub, Term } from "./chapter";
import { CodeBlock, HUE_BORDER, HUE_TEXT, W } from "./hues";

const NOW = Date.parse("2026-11-11T09:41:00Z");
const CTX: RenderCtx = { partKey: "workshop/catalogue/view", stale: false, onTap: () => {}, onLink: () => {}, now: NOW };

/** The view of a kind's own fixture document, read by the real parser. */
/** The shared fixtures' links carry a machine and an account; this page shows fictional ones, by shape. */
const FICTIONAL: readonly (readonly [RegExp, string])[] = [
  [/\/\/[a-z0-9-]+:(\d+)\//g, "//workshop:$1/"],
  [/github\.com\/[A-Za-z0-9-]+\//g, "github.com/example/"],
];

function fictional(text: string): string {
  return FICTIONAL.reduce((acc, [from, to]) => acc.replace(from, to), text);
}

function sampleOf(kind: NodeKind): View {
  // JSON.parse of the fixture's own JSON text: the same document with the names swapped.
  const parsed = parseTrickDocument(JSON.parse(fictional(JSON.stringify(nodeDocument(kind)))));
  for (const { part } of parsed.parts) {
    if ("view" in part && part.view !== undefined) return part.view;
  }
  return [];
}

const GROUPS: readonly { title: string; line: string; kinds: readonly NodeKind[] }[] = [
  { title: "Words", line: "Text, in Collie's own type.", kinds: ["para", "line", "run", "code", "link"] },
  { title: "Lists and frames", line: "Rows to scan, groups to fold.", kinds: ["list", "row", "group", "card", "spacer"] },
  { title: "Facts", line: "Numbers, bars, tables, changes.", kinds: ["number", "meter", "spark", "table", "col", "cell", "diff", "chip"] },
  { title: "Pictures", line: "From the trick's own folder, read with Collie's checks.", kinds: ["image", "compare"] },
  { title: "Controls", line: "Collie draws every button. A tap goes to the bridge.", kinds: ["button", "bar"] },
];

const NOT_KINDS = ["html", "script", "iframe", "stack", "grid", "progress"];
const COLLIE_ONLY = ["prompt", "composer", "sheet", "toast", "form", "field", "chat"];

function KindTile({ kind }: { kind: NodeKind }) {
  const view = useMemo(() => sampleOf(kind), [kind]);
  return (
    <figure className="flex min-w-0 flex-col rounded-sm border border-border bg-background">
      <figcaption className="border-b border-border px-3 py-1.5 font-mono text-[12px] font-semibold">{kind}</figcaption>
      <div className="max-h-56 min-h-16 overflow-hidden px-3 py-2">{renderView(view, CTX)}</div>
    </figure>
  );
}

/** One lane: what an agent sends, and what becomes of it. */
function Lane({ ok, from, sample, result }: { ok: boolean; from: string; sample: string; result: string }) {
  return (
    <div className={cn("grid min-w-0 grid-cols-1 gap-2 rounded-sm border bg-card p-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center", ok ? HUE_BORDER.bridge : "border-border")}>
      <div className="min-w-0">
        <p className={cn("text-xs font-semibold", HUE_TEXT.agent)}>{from}</p>
        <p className="mt-1 truncate font-mono text-[12px]">{sample}</p>
      </div>
      <p aria-hidden="true" className="text-center font-mono text-lg text-muted-foreground">
        →
      </p>
      <p className={cn("text-sm font-semibold", ok ? "text-status-done" : "text-muted-foreground line-through")}>{result}</p>
    </div>
  );
}

/** The two lanes: code finds no door, data in the closed list is drawn by Collie. */
function Lanes() {
  return (
    <div className="space-y-2">
      <Lane ok={false} from="An agent sends code" sample={'<button onclick="deploy()">Approve</button>'} result="No door takes it. Nothing is drawn." />
      <Lane ok from="An agent sends data" sample={'{ "kind": "button", "attrs": { "label": "Fix both" } }'} result="The bridge checks it. The phone draws Collie's own button." />
    </div>
  );
}

export function JitChapter() {
  return (
    <Chapter at="parts" lead="A trick sends parts, not code. So a screen can be made for one moment and still be Collie's.">
      <P>
        Every trick draws with the same <Term>parts</Term>: a row, a number, a chip, a button, a diff, and a few more. A part is a small piece of data that names
        what to show. The phone has one drawing for each.
      </P>
      <P>
        That makes <Term>just-in-time UI</Term> possible: a screen made for one situation, at the moment it comes up, and gone after. Nobody designed it in advance. A
        program or an agent put it together from what it knew right then.
      </P>
      <FigureSlot name="parts" className="mx-auto max-w-[560px]" />
      <Lanes />
      <P>
        What makes this safe is the form it takes. <strong>The agent does not send code or HTML. It sends data</strong>, in a closed list of parts. The bridge refuses
        any part that is not on the list, and Collie's own renderer draws the rest. So a screen can be new every time, and still look and behave like Collie.
      </P>
      <Sub>The vocabulary: 22 kinds, each drawn by Collie</Sub>
      <div className="space-y-6">
        {GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title} className="space-y-2">
            <p className="text-sm">
              <span className="font-semibold">{g.title}.</span> <span className="text-muted-foreground">{g.line}</span>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {g.kinds.map((k) => (
                <KindTile key={k} kind={k} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        That is all {NODE_KINDS.length} kinds. Each sample above is the real renderer, drawing the tricks' own test fixture for that kind.
      </p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <CodeBlock wrap title="not a kind: left out, with a note" segs={[{ t: NOT_KINDS.join("   ") }]} />
        <CodeBlock wrap title="kinds only Collie draws: refused" segs={[{ t: COLLIE_ONLY.join("   ") }]} />
      </div>
      <P>
        A kind outside the list is never drawn, and neither is a kind only Collie draws, such as its own questions or its reply box. A <W hue="trick">trick</W> or an{" "}
        <W hue="agent">agent</W> can choose what to show. Only Collie decides how it looks.
      </P>
    </Chapter>
  );
}
