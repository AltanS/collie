// The five hues of the tricks explainer: one hue per idea, the same in the drawing, the JSON keys, the
// callouts and the prose. Each is an existing theme token, so it follows the theme in light and dark.
// DEV-ONLY, like the rest of `src/playground/`.

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type Hue = "you" | "phone" | "bridge" | "agent" | "trick";

export const HUES: readonly Hue[] = ["you", "phone", "bridge", "agent", "trick"];

/** The CSS colour of a hue, for SVG strokes and fills. */
export const HUE_VAR = {
  you: "var(--syntax-keyword)",
  phone: "var(--syntax-string)",
  bridge: "var(--status-done)",
  agent: "var(--syntax-entity)",
  trick: "var(--syntax-constant)",
} as const satisfies Record<Hue, string>;

/** The text class of a hue. Literal strings, so Tailwind sees each one. */
export const HUE_TEXT = {
  you: "text-syntax-keyword",
  phone: "text-syntax-string",
  bridge: "text-status-done",
  agent: "text-syntax-entity",
  trick: "text-syntax-constant",
} as const satisfies Record<Hue, string>;

export const HUE_BORDER = {
  you: "border-syntax-keyword",
  phone: "border-syntax-string",
  bridge: "border-status-done",
  agent: "border-syntax-entity",
  trick: "border-syntax-constant",
} as const satisfies Record<Hue, string>;

export const HUE_BG = {
  you: "bg-syntax-keyword",
  phone: "bg-syntax-string",
  bridge: "bg-status-done",
  agent: "bg-syntax-entity",
  trick: "bg-syntax-constant",
} as const satisfies Record<Hue, string>;

/** A soft wash of a hue over the page, for a lit region. */
export function wash(hue: Hue, percent = 12): string {
  return `color-mix(in oklab, ${HUE_VAR[hue]} ${percent}%, var(--background))`;
}

/** What each hue stands for, as the colour key says it. */
export const HUE_WORDS = {
  you: { name: "You", line: "you and your tap" },
  phone: { name: "Phone", line: "the phone draws Collie's own parts" },
  bridge: { name: "Bridge", line: "Collie on your machine checks, stores and writes" },
  agent: { name: "Agent", line: "an agent session, where a model thinks" },
  trick: { name: "Trick", line: "a trick author's code and words" },
} as const satisfies Record<Hue, { name: string; line: string }>;

/** A word in the prose that carries a hue: bold, in the hue's colour. */
export function W({ hue, children }: { hue: Hue; children: ReactNode }) {
  return <strong className={cn("font-semibold", HUE_TEXT[hue])}>{children}</strong>;
}

/** A numbered callout: a small circle with the number, in the hue. Round because it is as wide as tall. */
export function Num({ n, hue, className }: { n: number; hue: Hue; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold", HUE_BORDER[hue], HUE_TEXT[hue], className)}
    >
      {n}
    </span>
  );
}

/** The colour key: one row per hue, each with a swatch, its name and what it means. */
export function ColourKey() {
  return (
    <ul aria-label="Colour key" className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
      {HUES.map((hue) => (
        <li key={hue} className="flex min-h-8 items-center gap-2 text-sm">
          <span aria-hidden="true" className={cn("size-3 shrink-0 rounded-sm", HUE_BG[hue])} />
          <span className={cn("font-semibold", HUE_TEXT[hue])}>{HUE_WORDS[hue].name}</span>
          <span className="text-muted-foreground">{HUE_WORDS[hue].line}</span>
        </li>
      ))}
    </ul>
  );
}

/** One run of a code block: its text, and the hue of whoever wrote it (none: plain). */
export interface Seg {
  readonly t: string;
  readonly hue?: Hue;
  /** A callout number drawn just before the run. */
  readonly n?: number;
}

/** A verbatim block (a file, a command, a line that is sent), its runs coloured by who wrote them. */
/** `wrap` breaks a long line at its spaces, for a line that is sent rather than a file that is read. */
export function CodeBlock({ title, segs, className, wrap = false }: { title?: string; segs: readonly Seg[]; className?: string; wrap?: boolean }) {
  return (
    <figure className={cn("min-w-0 rounded-sm border border-border bg-card", className)}>
      {title !== undefined && (
        <figcaption className="border-b border-border px-3 py-1.5 font-mono text-[11px] text-muted-foreground">{title}</figcaption>
      )}
      <pre className={cn("px-3 py-2 font-mono text-[12px] leading-relaxed", wrap ? "break-words whitespace-pre-wrap" : "overflow-x-auto whitespace-pre")}>
        {segs.map((s, i) => (
          <span key={i} className={s.hue === undefined ? undefined : cn("font-semibold", HUE_TEXT[s.hue])}>
            {s.n !== undefined && s.hue !== undefined && <Num n={s.n} hue={s.hue} className="mr-1 size-4 align-[-2px] text-[10px]" />}
            {s.t}
          </span>
        ))}
      </pre>
    </figure>
  );
}

/** Plain text as one uncoloured run. */
export function plain(text: string): Seg[] {
  return [{ t: text }];
}
