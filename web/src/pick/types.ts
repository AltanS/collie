// The contract a design round is written to: what a feature branch declares so the workspace's design
// app can build it into a proposal (`design propose <worktree> <round id>`). DEV-ONLY, never imported
// by the app. The page that draws a round, its case switch, its phone frames and its Pick controls
// live in the design app, not here; a round file only says what to draw.
//
// A round is one decision: a title, numbered options of at most five words, and the cases one switch
// drives for every option at once. It is written on its feature branch, registered in `rounds.ts`,
// and deleted (file and line) before that branch merges; the chosen state becomes a design reference
// entry instead.

import type { ReactNode } from "react";

export interface PickOption {
  readonly n: number;
  /** At most five words. */
  readonly label: string;
  /** The component this option is drawn with, named in a pick record (`data-state` or component name). */
  readonly state?: string;
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
