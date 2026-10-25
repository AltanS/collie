// ── WHAT A "REPORT A PROBLEM" SHEET READS OFF THIS MACHINE (ADR 0123) ──────────────────────────
//
// The phone builds an issue body when a person taps Report a problem. Most of what it holds the phone
// already has: the receipts of the failing sends (`GET /api/send/receipts`). This module holds the
// rest, for the one read route `GET /api/report/context`: which Collie this is, on which line, OS and
// multiplexer, and, only when the person turned "Include the screen" on, the pane's last rows.
//
// THE SCREEN IS ALWAYS MASKED. The mirror masks secret shapes only while `COLLIE_REDACT` is on, because
// the mirror goes to the operator's own phone. A report is meant for a public issue, so its screen
// goes through the same mask (`redactText`, bridge/redact.ts) whatever that switch says. The phone
// shows this exact text in the preview before anything leaves, and nothing here is stored.
//
// Pure: no mux, no disk, no clock. The route in server.ts reads the grid and strips its escapes.

import type { ReleaseLine } from "./update-line.ts";
import { redactText } from "./redact.ts";

/** The most rows of a pane's screen a report carries: the bottom of the screen, where the box is. */
export const REPORT_SCREEN_ROWS = 40;

/** What `GET /api/report/context` answers. Every field is a fact about this machine or this pane. */
export interface ReportContext {
  /** This bridge's version, as `/api/health` answers it. */
  readonly collie: string;
  /** The release line this machine follows, or null when it keeps no record. */
  readonly line: ReleaseLine | null;
  /** The host's platform and `process.arch`, as the route's caller read them. */
  readonly os: string;
  readonly arch: string;
  /** The multiplexer's registry name. Said, never branched on. */
  readonly mux: string;
  /** The pane's agent string, `""` for a bare shell, null when no pane was named. */
  readonly harness: string | null;
  /** Whether this pane has a screen to include (a program session has none). */
  readonly screenable: boolean;
  /** On `screen=1` only: the last {@link REPORT_SCREEN_ROWS} rows, escapes stripped, masked. */
  readonly screen?: string;
}

/**
 * The screen as a report carries it: the visible text (escapes already stripped), each row's trailing
 * blanks cut, the blank rows at the bottom dropped, the last `rows` rows kept, and every secret shape
 * masked by `redactText`, always.
 */
export function reportScreen(visibleText: string, rows = REPORT_SCREEN_ROWS): string {
  const lines = visibleText.split(/\r?\n/u).map((row) => row.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return redactText(lines.slice(-rows).join("\n"));
}
