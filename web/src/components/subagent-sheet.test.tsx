import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolCard } from "@/components/chat-cards";
import { SubagentSheet } from "@/components/subagent-sheet";
import { server } from "@/test/setup";
import type { TranscriptEntry } from "@/lib/types";

afterEach(cleanup);

const SUBAGENT_ENTRIES: TranscriptEntry[] = [
  {
    uuid: "sub-u1",
    ts: "2026-10-18T01:00:00.000Z",
    role: "user",
    parts: [{ kind: "text", text: "Please inspect bridge/solo-baseline.test.ts and report missing routes." }],
  },
  {
    uuid: "sub-a1",
    ts: "2026-10-18T01:00:02.000Z",
    role: "assistant",
    parts: [
      {
        kind: "tool",
        id: "toolu_read1",
        name: "Read",
        summary: "bridge/solo-baseline.test.ts",
        call: { kind: "read", path: "bridge/solo-baseline.test.ts", range: [1, 90] },
        result: { text: "1\t// route list" },
      },
    ],
  },
  {
    uuid: "sub-a2",
    ts: "2026-10-18T01:00:05.000Z",
    role: "assistant",
    parts: [{ kind: "text", text: "The route `/api/pane/:id/chat` is missing from **SOLO_ROUTES**." }],
  },
];

describe("SubagentSheet", () => {
  it("opens a bottom sheet on tapping a task card, fetches the subagent log, toggles the prompt, and renders steps and report", async () => {
    server.use(
      http.get("/api/pane/w1%3Ap1/subagent/af52a45b4a25847ac", () =>
        HttpResponse.json({
          paneId: "w1:p1",
          agentId: "af52a45b4a25847ac",
          available: true,
          entries: SUBAGENT_ENTRIES,
          fileTruncated: false,
        }),
      ),
    );

    render(
      <SubagentSheet paneId="w1:p1">
        <ToolCard
          tool={{
            kind: "task",
            agent: "Explore",
            summary: "Check CI route allowlist",
            agentId: "af52a45b4a25847ac",
            output: "The route `/api/pane/:id/chat` is missing from **SOLO_ROUTES**.",
          }}
          status="done"
        />
      </SubagentSheet>,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Explore/i }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("solo-baseline.test.ts")).toBeTruthy();
    });
    expect(screen.getByText("SOLO_ROUTES")).toBeTruthy();

    // Prompt starts collapsed (preview only) and expands on tap
    const promptBtn = screen.getByRole("button", { name: /Prompt|派工指令/i });
    expect(promptBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(promptBtn);
    expect(promptBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("falls back to rendering the task output when no subagent log is available", async () => {
    server.use(
      http.get("/api/pane/w1%3Ap1/subagent/a0000000000000000", () =>
        HttpResponse.json({
          paneId: "w1:p1",
          agentId: "a0000000000000000",
          available: false,
        }),
      ),
    );

    render(
      <SubagentSheet paneId="w1:p1">
        <ToolCard
          tool={{
            kind: "task",
            agent: "Plan",
            summary: "Review bundle",
            agentId: "a0000000000000000",
            output: "All 23 routes verified against the table.",
          }}
          status="done"
        />
      </SubagentSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Plan/i }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText(/All 23 routes verified/)).toBeTruthy();
    });
  });

  it("keeps intermediate assistant commentary in steps without marking a running subagent finished", async () => {
    const midRunEntries: TranscriptEntry[] = [
      SUBAGENT_ENTRIES[0]!,
      {
        uuid: "sub-mid-text",
        ts: "2026-10-18T01:00:01.000Z",
        role: "assistant",
        parts: [{ kind: "text", text: "I will check bridge/solo-baseline.test.ts first." }],
      },
      SUBAGENT_ENTRIES[1]!,
    ];
    server.use(
      http.get("/api/pane/w1%3Ap1/subagent/af52a45b4a25847ac", () =>
        HttpResponse.json({
          paneId: "w1:p1",
          agentId: "af52a45b4a25847ac",
          available: true,
          entries: midRunEntries,
          fileTruncated: false,
        }),
      ),
    );

    render(
      <SubagentSheet paneId="w1:p1">
        <ToolCard
          tool={{
            kind: "task",
            agent: "general-purpose",
            summary: "Demo subagent phone test",
            agentId: "af52a45b4a25847ac",
          }}
          status="running"
        />
      </SubagentSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: /general-purpose/i }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getByText(/I will check bridge\/solo-baseline\.test\.ts first\./)).toBeTruthy();
    });
    expect(within(dialog).queryByText("Report")).toBeNull();
    expect(within(dialog).getByRole("img", { name: /Running|執行中/i })).toBeTruthy();
  });

  it("syncs live card updates (agentId arrival and completion status) into an already-open sheet, and closes on pane switch", async () => {
    server.use(
      http.get("/api/pane/w1%3Ap1/subagent/af52a45b4a25847ac", () =>
        HttpResponse.json({
          paneId: "w1:p1",
          agentId: "af52a45b4a25847ac",
          available: true,
          entries: SUBAGENT_ENTRIES,
          fileTruncated: false,
        }),
      ),
    );

    const { rerender } = render(
      <SubagentSheet paneId="w1:p1">
        <ToolCard
          tool={{
            kind: "task",
            agent: "general-purpose",
            summary: "Demo subagent phone test",
          }}
          status="running"
        />
      </SubagentSheet>,
    );

    fireEvent.click(screen.getByRole("button", { name: /general-purpose/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("img", { name: /Running|執行中/i })).toBeTruthy();

    rerender(
      <SubagentSheet paneId="w1:p1">
        <ToolCard
          tool={{
            kind: "task",
            agent: "general-purpose",
            summary: "Demo subagent phone test",
            agentId: "af52a45b4a25847ac",
            output: "The route `/api/pane/:id/chat` is missing from **SOLO_ROUTES**.",
          }}
          status="done"
        />
      </SubagentSheet>,
    );

    await waitFor(() => {
      expect(within(dialog).getByText("SOLO_ROUTES")).toBeTruthy();
    });
    expect(within(dialog).queryByRole("img", { name: /Running|執行中/i })).toBeNull();

    rerender(
      <SubagentSheet paneId="w1:p2">
        <ToolCard
          tool={{
            kind: "task",
            agent: "general-purpose",
            summary: "Demo subagent phone test",
            agentId: "af52a45b4a25847ac",
          }}
          status="done"
        />
      </SubagentSheet>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks a crew member's pane once: after the lead's 501 it stops polling and does not ask again on reopen", async () => {
    let asked = 0;
    server.use(
      http.get("/api/pane/w1%3Ap1/subagent/af52a45b4a25847ac", () => {
        asked++;
        return HttpResponse.json(
          { error: "route /api/pane/w1:p1/subagent/af52a45b4a25847ac is not available across a crew link", code: "route_not_federated" },
          { status: 501 },
        );
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(
        <SubagentSheet paneId="w1:p1" scope={{ host: "laptop" }}>
          <ToolCard
            tool={{ kind: "task", agent: "Explore", summary: "Remote subagent", agentId: "af52a45b4a25847ac" }}
            status="running"
          />
        </SubagentSheet>,
      );
      fireEvent.click(screen.getByRole("button", { name: /Explore/i }));
      await screen.findByRole("dialog");
      await waitFor(() => expect(asked).toBe(1));
      // Running, sheet open: the 2 s poll would ask four more times here.
      await vi.advanceTimersByTimeAsync(9_000);
      expect(asked).toBe(1);
      // Close and reopen: the pane is remembered as not federated, so no new request.
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: /Explore/i }));
      await screen.findByRole("dialog");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(asked).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
