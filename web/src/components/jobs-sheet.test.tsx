import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneJob } from "@/lib/types";
import { JobsSheet } from "./jobs-sheet";

// A fixed instant, so an age never crosses a minute boundary on a slow runner.
const NOW = Date.parse("2026-11-03T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const RUNNING: PaneJob = { id: "job-1", label: "suite", command: "bun test --coverage", startedAt: iso(NOW - 5 * 60_000) };
const PASSED: PaneJob = { id: "job-2", label: "", command: "bun run lint", startedAt: iso(NOW - 9 * 60_000), exitCode: 0, endedAt: iso(NOW - 2 * 60_000) };
const FAILED: PaneJob = { id: "job-3", label: "build", command: "bun run build", startedAt: iso(NOW - 8 * 60_000), exitCode: 137, endedAt: iso(NOW - 3 * 60_000) };
const STOPPED: PaneJob = { id: "job-4", label: "watch", command: "tail -f x.log", startedAt: iso(NOW - 7 * 60_000), endedAt: iso(NOW - 4 * 60_000) };

function renderSheet(jobs: readonly PaneJob[]) {
  render(<JobsSheet open onClose={vi.fn()} title="Jobs 1" jobs={jobs} />);
  return screen.getByRole("dialog");
}

describe("JobsSheet", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists the running jobs first with label, command and elapsed time, then the ended ones", () => {
    const sheet = renderSheet([RUNNING, PASSED, FAILED]);
    const running = sheet.querySelector<HTMLElement>('[data-slot="jobs-running"]')!;
    const ended = sheet.querySelector<HTMLElement>('[data-slot="jobs-ended"]')!;
    expect(within(running).getByText("Running")).toBeInTheDocument();
    expect(within(running).getByText("suite")).toBeInTheDocument();
    expect(within(running).getByText("bun test --coverage").tagName.toLowerCase()).toBe("code");
    expect(within(running).getByText("5m")).toBeInTheDocument();
    expect(within(ended).getByText("Ended recently")).toBeInTheDocument();
    expect(within(ended).getAllByRole("listitem")).toHaveLength(2);
    // The order the bridge sent: running, then ended.
    expect(running.compareDocumentPosition(ended) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("gives an ended job its exit code and how long ago it ended; a non-zero code reads as a failure", () => {
    const sheet = renderSheet([PASSED, FAILED, STOPPED]);
    const rows = within(sheet).getAllByRole("listitem");
    expect(within(rows[0]!).getByText("Exit code 0")).not.toHaveClass("text-destructive");
    expect(within(rows[0]!).getByText("2m")).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Exit code 137")).toHaveClass("text-destructive");
    // An end that named no code draws no exit line.
    expect(rows[2]!.querySelector('[data-slot="belt-job-exit"]')).toBeNull();
    // A job with no label draws its command alone.
    expect(within(rows[0]!).getByText("bun run lint")).toBeInTheDocument();
  });

  it("draws no Running group when none runs, and no Ended group when none ended", () => {
    const ended = renderSheet([PASSED]);
    expect(ended.querySelector('[data-slot="jobs-running"]')).toBeNull();
    expect(ended.querySelector('[data-slot="jobs-ended"]')).not.toBeNull();
  });

  it("is closed while not open", () => {
    render(<JobsSheet open={false} onClose={vi.fn()} title="Jobs 1" jobs={[RUNNING]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
