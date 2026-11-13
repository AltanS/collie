// The one-pager shell for a design round where the operator picks (DEV-ONLY, see ../../pick.html).
//
// A round is ONE page with ONE decision: a title, numbered option cards, and one case switch that drives
// every option at once. An option card is a number and at most five words, no prose. Each option draws in
// a phone frame, side by side on a wide screen and stacked on a phone. The chosen case lives in the URL
// (`?round=<id>&case=<id>`) so a link opens the same state. The shell knows nothing of what a round shows.

import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";

import { PhoneFrame, Segmented } from "../playground/layout";

export interface PickOption {
  readonly n: number;
  /** At most five words. */
  readonly label: string;
  readonly render: (caseId: string) => ReactNode;
}

export interface PickCase {
  readonly id: string;
  readonly label: string;
}

export interface PickRoundDef {
  readonly title: string;
  readonly options: readonly PickOption[];
  readonly cases: readonly PickCase[];
  /** Height of each phone frame in px. Default 760. */
  readonly frameHeight?: number;
}

export const MAX_LABEL_WORDS = 5;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter((word) => word !== "").length;
}

/** The case named by the URL's `case` word when the round has it, else the round's first. */
export function caseFromSearch(search: string, cases: readonly PickCase[]): string {
  const wanted = new URLSearchParams(search).get("case");
  return cases.find((c) => c.id === wanted)?.id ?? cases[0]?.id ?? "";
}

function writeCase(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("case", id);
  window.history.replaceState(null, "", url);
}

export function PickPage({ title, options, cases, frameHeight = 760 }: PickRoundDef) {
  for (const option of options) {
    if (wordCount(option.label) > MAX_LABEL_WORDS) throw new Error(`Option ${option.n} has a label of more than ${MAX_LABEL_WORDS} words: "${option.label}"`);
  }
  const [caseId, setCaseId] = useState(() => caseFromSearch(window.location.search, cases));
  const [replay, setReplay] = useState(0);
  const pick = (next: string) => {
    setCaseId(next);
    writeCase(next);
  };
  return (
    <main className="min-h-dvh bg-background px-4 pb-16 text-foreground">
      <h1 className="pt-4 text-lg font-semibold">{title}</h1>
      <div className="sticky top-0 z-20 -mx-4 mt-3 border-b border-rule bg-background/95 px-4 py-2 backdrop-blur">
        <div className="pg-scroll-row items-center gap-x-4">
          <Segmented name="Case" value={caseId} options={cases.map((c) => ({ value: c.id, label: c.label }))} onChange={pick} />
          <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => setReplay((n) => n + 1)}>
            Replay
          </Button>
        </div>
      </div>
      <div className="mt-4 flex flex-col items-center gap-8 lg:flex-row lg:flex-wrap lg:items-start lg:justify-center">
        {options.map((option) => (
          <section key={option.n} data-option={option.n} className="w-[390px] max-w-full">
            <div className="mb-2 flex items-baseline gap-3">
              <span className="text-2xl font-semibold tabular-nums leading-none">{option.n}</span>
              <span className="min-w-0 truncate text-sm text-muted-foreground">{option.label}</span>
            </div>
            <PhoneFrame height={frameHeight}>
              {/* Keyed by the case and by Replay: a new case, or Replay, starts every option fresh. */}
              <div key={`${caseId}:${replay}`} className="flex min-h-full flex-1 flex-col">
                {option.render(caseId)}
              </div>
            </PhoneFrame>
          </section>
        ))}
      </div>
    </main>
  );
}
