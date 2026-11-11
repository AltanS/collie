// The frame of the tricks explainer: one numbered chapter, its bold line, the prose sizes, and the
// sticky table of contents (a rail on a wide screen, a strip of numbered chips on a phone).
// DEV-ONLY, like the rest of `src/playground/`.

import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The chapters, in page order. `site` marks the eight the website page /tricks/how-it-works keeps
 * (WEBSITE-CUT, round 3); the rest are docs only, kept here as the workshop. `figure` is the chapter's
 * figure slot in explainer-figures.tsx.
 */
const ORDER = [
  { key: "top", title: "What a trick is", site: true, figure: "what-a-trick-is" },
  { key: "places", title: "Where a trick can show", site: true, figure: "where-a-trick-can-show" },
  { key: "kinds", title: "Two kinds of trick", site: true, figure: "two-kinds" },
  { key: "parts", title: "The parts", site: false, figure: "parts" },
  { key: "simple", title: "Example 1: a program trick", site: true, figure: "example-program-trick" },
  { key: "hill", title: "Example 2: a trick that asks", site: true, figure: "example-hill" },
  { key: "morph", title: "Example 3: Morph, an agent view", site: true, figure: "example-agent-view" },
  { key: "thinking", title: "Where the thinking comes from", site: false, figure: "thinking" },
  { key: "rules", title: "How an agent learns the rules", site: false, figure: "agent-rules" },
  { key: "trust", title: "Who is trusted with what", site: true, figure: "trust" },
  { key: "write", title: "Write your own", site: true, figure: "write-your-own" },
] as const;

export type ChapterKey = (typeof ORDER)[number]["key"];

export interface ChapterDef {
  readonly n: number;
  readonly key: ChapterKey;
  readonly id: string;
  readonly title: string;
  /** On the website page, or in the docs only. */
  readonly site: boolean;
  readonly figure: string;
}

/** The chapters in page order. A chapter's number is its place in this list, so a reorder renumbers every one. */
export const CHAPTERS: readonly ChapterDef[] = ORDER.map((c, n) => ({ n, key: c.key, id: `te-${c.key}`, title: c.title, site: c.site, figure: c.figure }));

/** A chapter's number, by its key. */
export function chapterNumber(key: ChapterKey): number {
  return CHAPTERS.findIndex((c) => c.key === key);
}

/**
 * A chapter's card handle, the playground's own deep link: `#tricks-explainer/chapter-3` opens this
 * section and scrolls to chapter 3 (`ScrollToCard` in app.tsx finds the `data-state`). Only a grid's
 * direct children are cards to the handle test, so a chapter's handle is not counted as one.
 */
export function chapterHandle(n: number): string {
  return `chapter-${n}`;
}

export function chapterHref(n: number): string {
  return `#tricks-explainer/${chapterHandle(n)}`;
}

/** Room above a chapter's heading when the contents jump to it: the playground's own top bar and the strip. */
const SCROLL_MARGIN = "scroll-mt-[calc(var(--pg-top,0px)+4rem)] xl:scroll-mt-6";

export function Chapter({ at, lead, children }: { at: ChapterKey; lead: ReactNode; children: ReactNode }) {
  const def = CHAPTERS.find((c) => c.key === at);
  if (def === undefined) return null;
  const { n } = def;
  return (
    <section id={def.id} data-state={chapterHandle(n)} aria-labelledby={`${def.id}-h`} className={cn("border-t border-rule pt-10 first:border-t-0 first:pt-2", SCROLL_MARGIN)}>
      <div className="flex items-baseline gap-3">
        <span aria-hidden="true" className="font-mono text-4xl font-semibold text-muted-foreground">
          {n}
        </span>
        <h3 id={`${def.id}-h`} className="text-2xl font-semibold tracking-tight">
          <span className="sr-only">{n}. </span>
          {def.title}
        </h3>
        <span className={cn("self-center rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wide whitespace-nowrap uppercase", def.site ? "border-foreground/40 text-foreground" : "border-border text-muted-foreground")}>
          {def.site ? "on the website" : "docs only"}
        </span>
        <a
          href={chapterHref(n)}
          aria-label={`Link to chapter ${n}`}
          title="Link to this chapter"
          className="ml-auto inline-flex size-11 shrink-0 items-center justify-center self-center rounded-sm font-mono text-lg text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          #
        </a>
      </div>
      <p className="mt-3 max-w-[44ch] text-lg leading-snug font-semibold">{lead}</p>
      <div className="mt-6 space-y-6">{children}</div>
    </section>
  );
}

/** A paragraph of the explainer: plain words, a line length that reads well. */
export function P({ children }: { children: ReactNode }) {
  return <p className="max-w-[66ch] text-[15px] leading-relaxed">{children}</p>;
}

/** A small heading inside a chapter, over one part of it. */
export function Sub({ children }: { children: ReactNode }) {
  return <h4 className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">{children}</h4>;
}

/** A Collie word, explained right where it first appears. */
export function Term({ children }: { children: ReactNode }) {
  return <dfn className="font-semibold not-italic">{children}</dfn>;
}

/** Marks a drawing as a mockup: what it stands for is designed, and the real renderer cannot draw it on this base. */
export function MockupTag() {
  return <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">mockup</span>;
}

/** The chapter in view: the last one whose top has passed a third of the way down the screen. */
function useCurrentChapter(): string {
  const [current, setCurrent] = useState(CHAPTERS[0]?.id ?? "");
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line = window.innerHeight / 3;
      let found = CHAPTERS[0]?.id ?? "";
      for (const c of CHAPTERS) {
        const el = document.getElementById(c.id);
        if (el !== null && el.getBoundingClientRect().top <= line) found = c.id;
      }
      setCurrent(found);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);
  return current;
}

/** Scroll to a chapter and put its deep link in the address bar, without a new history entry or a hashchange. */
function jump(c: ChapterDef) {
  window.history.replaceState(window.history.state, "", chapterHref(c.n));
  document.getElementById(c.id)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
}

/** The contents: a sticky rail at `xl`, a sticky strip of numbers under it. Both jump without touching the URL. */
export function Contents() {
  const current = useCurrentChapter();
  const strip = useRef<HTMLOListElement>(null);
  // Keep the current chip in sight in the phone strip, by moving the strip alone, never the page.
  useEffect(() => {
    const ol = strip.current;
    const chip = ol?.querySelector<HTMLElement>("a[aria-current]");
    if (ol === null || chip === null || chip === undefined) return;
    const left = chip.offsetLeft - ol.offsetLeft;
    if (left < ol.scrollLeft || left + chip.offsetWidth > ol.scrollLeft + ol.clientWidth) ol.scrollLeft = left - (ol.clientWidth - chip.offsetWidth) / 2;
  }, [current]);
  return (
    <>
      <nav aria-label="Contents" className="sticky top-[var(--pg-top,0px)] z-10 -mx-1 border-b border-rule bg-background px-1 py-2 xl:hidden">
        <ol ref={strip} className="flex gap-1 overflow-x-auto">
          {CHAPTERS.map((c) => (
            <li key={c.id} className="shrink-0">
              <a
                href={chapterHref(c.n)}
                aria-current={current === c.id ? "location" : undefined}
                aria-label={`${c.n}. ${c.title}`}
                title={c.title}
                onClick={(e) => {
                  e.preventDefault();
                  jump(c);
                }}
                className={cn(
                  "flex size-11 items-center justify-center rounded-sm border font-mono text-sm font-semibold transition-colors",
                  current === c.id ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {c.n}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <nav aria-label="Contents" className="hidden xl:block">
        <ol className="sticky top-6 space-y-0.5 border-l border-rule">
          {CHAPTERS.map((c) => (
            <li key={c.id}>
              <a
                href={chapterHref(c.n)}
                aria-current={current === c.id ? "location" : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  jump(c);
                }}
                className={cn(
                  "-ml-px flex min-h-9 items-baseline gap-2 border-l-2 py-1.5 pr-2 pl-3 text-sm transition-colors",
                  current === c.id ? "border-foreground font-semibold text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="w-4 shrink-0 font-mono text-xs">{c.n}</span>
                <span>{c.title}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}
