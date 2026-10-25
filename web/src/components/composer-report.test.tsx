import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { useReportTarget } from "@/lib/report/store";
import type { Scope } from "@/lib/scope";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// Report a problem on the composer (ADR 0123): three sends in a row that fail for a reason that points
// at Collie float a card above the box; Report opens the one sheet with the streak's ids; the cross
// keeps it quiet. Nothing is resent, and a member's pane and a phone that turned it off get no card.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

let opened: ReturnType<typeof useReportTarget> = null;
function TargetProbe() {
  opened = useReportTarget();
  return null;
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <Composer {...props} />
          <TargetProbe />
        </>
      ),
    },
  ]);
  return render(<RouterProvider router={router} />);
}

/** Answers every send with the next receipt, and records the ids. */
function bridge(answers: { outcome: string; reason?: string }[]) {
  const ids: string[] = [];
  const answer = ({ id }: { id: string }) => {
    ids.push(id);
    const next = answers.shift() ?? { outcome: "sent" };
    return HttpResponse.json({ receipt: { ...next, keys: [] }, offers: next.outcome === "sent" ? [] : ["keys"] });
  };
  server.use(
    // SAFETY: the composer under test is the only poster, and its body carries the request id.
    http.post(/\/api\/send$/, async ({ request }) => answer((await request.json()) as { id: string })),
    // A member's pane goes through the pane's reply route; the answer rides under `send`.
    http.post(/\/api\/pane\/[^/]+\/reply/, async ({ request }) => {
      // SAFETY: as above, the composer's own reply body.
      const reply = answer((await request.json()) as { id: string });
      return HttpResponse.json({ send: await reply.json() });
    }),
  );
  return ids;
}

async function sendTimes(user: ReturnType<typeof userEvent.setup>, n: number, ids: string[]) {
  const before = ids.length;
  for (let i = 0; i < n; i++) {
    await user.type(screen.getByPlaceholderText(/type a reply/i), `try ${String(i)}`);
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(ids).toHaveLength(before + i + 1));
    // Clear the kept draft so the next send is a new intent with a new id.
    await user.clear(screen.getByPlaceholderText(/type a reply/i));
  }
}

const CARD = '[data-slot="report-card"]';

describe("Composer: Report a problem (ADR 0123)", () => {
  it("three failed sends in a row float the card; Report opens the sheet with the streak's ids", async () => {
    const user = userEvent.setup();
    const ids = bridge([{ outcome: "refused", reason: "probe_failed" }, { outcome: "typed_not_submitted", reason: "mismatch" }, { outcome: "unknown", reason: "no_evidence" }]);
    const { container } = renderComposer();
    await sendTimes(user, 2, ids);
    expect(container.querySelector(CARD)).toBeNull();
    await sendTimes(user, 1, ids);
    await waitFor(() => expect(container.querySelector(CARD)).toHaveTextContent("Sending failed 3 times. This may be a bug."));
    // The card floats in the column that holds no space.
    expect(container.querySelector(CARD)?.closest('[data-slot="floating-cards"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Report this problem" }));
    expect(opened).toEqual({ paneId: "w1:p1", scope: undefined, requestIds: ids });
    // The card never sends: three requests, no more.
    expect(ids).toHaveLength(3);
  });

  it("the cross closes it until a send works, and a held or draft refusal does not count", async () => {
    const user = userEvent.setup();
    const ids = bridge([
      { outcome: "refused", reason: "not_free" },
      { outcome: "refused", reason: "draft_present" },
      { outcome: "held", reason: "turn_running" },
      { outcome: "refused", reason: "not_free" },
      { outcome: "refused", reason: "not_free" },
      { outcome: "refused", reason: "not_free" },
    ]);
    const { container } = renderComposer();
    await sendTimes(user, 4, ids);
    expect(container.querySelector(CARD)).toBeNull();
    await sendTimes(user, 1, ids);
    await waitFor(() => expect(container.querySelector(CARD)).not.toBeNull());
    await user.click(screen.getByRole("button", { name: "Close the report offer" }));
    expect(container.querySelector(CARD)).toBeNull();
    await sendTimes(user, 1, ids);
    expect(container.querySelector(CARD)).toBeNull();
  });

  it("offers nothing when Settings turned it off", async () => {
    const user = userEvent.setup();
    const ids = bridge([{ outcome: "unknown", reason: "crash" }, { outcome: "unknown", reason: "crash" }, { outcome: "unknown", reason: "crash" }]);
    const { container } = renderComposer({
      prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false, reportOffer: false },
    });
    await sendTimes(user, 3, ids);
    expect(container.querySelector(CARD)).toBeNull();
  });

  it("offers nothing on a crew member's pane (the next slice)", async () => {
    const user = userEvent.setup();
    const scope: Scope = { host: "laptop" };
    markLive("w1:p1", Date.now(), scope);
    const ids = bridge([{ outcome: "unknown", reason: "crash" }, { outcome: "unknown", reason: "crash" }, { outcome: "unknown", reason: "crash" }]);
    const { container } = renderComposer({ scope });
    await sendTimes(user, 3, ids);
    expect(container.querySelector(CARD)).toBeNull();
  });
});
