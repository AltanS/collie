// The tricks explainer: ONE long page that explains Collie tricks to an outsider. Generic first: what a
// trick is, every place it can show, the two kinds, the parts. Then three examples (a program trick, a
// trick that asks on the Hill, Morph as an agent view), where the thinking happens, how an agent learns
// the rules, who is trusted with what, and how to write one. Every chapter draws the same map and lights the part it talks about.
// The cards, tiles and views are the REAL components fed fixtures; a drawing marked "mockup" stands in
// where this base has no renderer.
//
// The whole page sits in one Group with one full-width Card, so the playground's handle test holds.
// DEV-ONLY, unreachable from the app entry: see ../app.tsx and web/playground.html.

import type { ReactNode } from "react";

import { FIGURE_NAMES, FigureSlot } from "../explainer-figures";
import { Card, Group, Section, type SectionDef } from "../layout";
import { Contents } from "../tricks-explainer/chapter";
import { HillChapter } from "../tricks-explainer/hill";
import { JitChapter } from "../tricks-explainer/jit";
import { KindsChapter } from "../tricks-explainer/kinds";
import { MorphChapter } from "../tricks-explainer/morph";
import { PlacesChapter } from "../tricks-explainer/places";
import { RulesChapter } from "../tricks-explainer/rules";
import { SimpleChapter } from "../tricks-explainer/simple";
import { ThinkingChapter } from "../tricks-explainer/thinking";
import { TopChapter } from "../tricks-explainer/top";
import { TrustChapter } from "../tricks-explainer/trust";
import { WriteChapter } from "../tricks-explainer/write";

export const DEF: SectionDef = {
  id: "tricks-explainer",
  title: "Tricks explained",
  intent: "One long page for an outsider: what a trick is, where it can show, its two kinds and its parts, three examples, inference, rules and trust, on one shared map.",
};

export function TricksExplainerSection(): ReactNode {
  return (
    <Section def={DEF}>
      <Group title="The page">
        <Card state="tricks-explainer-page" label="0 · Collie tricks, explained" span="all">
          <div className="grid grid-cols-1 gap-8 xl:grid-cols-[13rem_minmax(0,1fr)]">
            <Contents />
            <div className="min-w-0 space-y-14 pb-24">
              <TopChapter />
              <PlacesChapter />
              <KindsChapter />
              <JitChapter />
              <SimpleChapter />
              <HillChapter />
              <MorphChapter />
              <ThinkingChapter />
              <RulesChapter />
              <TrustChapter />
              <WriteChapter />
            </div>
          </div>
        </Card>
      </Group>
      <Group title="The figures at 342 px">
        {FIGURE_NAMES.map((name, i) => (
          <Card key={name} state={`figure-${name}`} label={`${String(i + 1)} · ${name}`}>
            {/* The site's box at its narrowest. A check measures that the drawing fills it, with no band. */}
            <div data-figure={name} className="w-[342px] max-w-full">
              <FigureSlot name={name} playing={false} />
            </div>
          </Card>
        ))}
      </Group>
    </Section>
  );
}

