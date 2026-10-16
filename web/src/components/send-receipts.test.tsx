import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import type { SendReceiptRow } from "@/lib/surface/send";
import { SendReceipts, SendReceiptsView } from "./send-receipts";

// The session page's list of recent sends (M56 spec 09): outcome, reason, time, and on tap the keys by
// name and the measured gaps. A receipt holds no text and no screen row, and the list shows neither,
// even when a body carries a field it should not.

const NOW = 1_000_000_000;
const rows: readonly SendReceiptRow[] = [
  { requestId: "req00001", at: NOW - 30_000, mode: "send", outcome: "sent", keys: ["probe", "Backspace", "Enter"], gapsMs: { s0: 123, probe: 166, s1: 83, s2: 82 }, harness: "agent", version: "2.1.301" },
  { requestId: "req00002", at: NOW - 5 * 60_000, mode: "send", outcome: "refused", reason: "not_free", keys: [], gapsMs: { s0: 240 }, harness: "agent", version: "2.1.301" },
  { requestId: "req00003", at: NOW - 2 * 3_600_000, mode: "command", outcome: "typed_not_submitted", reason: "modal_cue", keys: ["Enter"], gapsMs: {}, harness: "agent", version: null },
];

describe("SendReceiptsView", () => {
  it("lists each receipt with its outcome, its reason and how long ago, newest first as given", () => {
    render(<SendReceiptsView rows={rows} now={NOW} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Sent");
    expect(items[0]).toHaveTextContent(/just now/i);
    expect(items[1]).toHaveTextContent("Refused");
    expect(items[1]).toHaveTextContent("not free");
    expect(items[1]).toHaveTextContent("5m ago");
    expect(items[2]).toHaveTextContent("Typed, not sent");
    expect(items[2]).toHaveTextContent("modal cue");
  });

  it("a tap opens the keys by name and the gaps, and a second tap closes them", async () => {
    const user = userEvent.setup();
    render(<SendReceiptsView rows={rows} now={NOW} />);
    expect(screen.queryByText(/Keys: /)).toBeNull();
    const [first, second] = screen.getAllByRole("button");
    await user.click(first!);
    expect(screen.getByText("Keys: probe, Backspace, Enter")).toBeInTheDocument();
    expect(screen.getByText("Waited: s0 123 ms, probe 166 ms, s1 83 ms, s2 82 ms")).toBeInTheDocument();
    expect(first).toHaveAttribute("aria-expanded", "true");
    await user.click(second!);
    // One row open at a time.
    expect(screen.queryByText("Keys: probe, Backspace, Enter")).toBeNull();
    expect(screen.getByText("No keys were sent.")).toBeInTheDocument();
    await user.click(second!);
    expect(screen.queryByText("No keys were sent.")).toBeNull();
  });

  it("says so when there is nothing to list", () => {
    render(<SendReceiptsView rows={[]} now={NOW} />);
    expect(screen.getByText("No sends to this pane yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("SendReceipts", () => {
  it("reads the bridge's list and draws it without any text or screen row, even if the body carries one", async () => {
    server.use(
      http.get("/api/send/receipts", ({ request }) => {
        expect(new URL(request.url).searchParams.get("pane")).toBe("w1:p1");
        return HttpResponse.json({
          receipts: [{ ...rows[0]!, text: "sk-live-secret-text", rows: ["a row with a password hunter2"], textHash: "deadbeef" }],
        });
      }),
    );
    const { container } = render(<SendReceipts paneId="w1:p1" />);
    await waitFor(() => expect(screen.getByText("Sent")).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole("button"));
    expect(container).not.toHaveTextContent(/sk-live-secret-text|hunter2|deadbeef/);
  });

  it("shows the empty line for a pane with no sends, and for a bridge that has no such route", async () => {
    server.use(http.get("/api/send/receipts", () => HttpResponse.json({ receipts: [] })));
    const first = render(<SendReceipts paneId="w1:p1" />);
    await waitFor(() => expect(screen.getByText("No sends to this pane yet.")).toBeInTheDocument());
    first.unmount();
    server.use(http.get("/api/send/receipts", () => new HttpResponse("not found", { status: 404 })));
    render(<SendReceipts paneId="w1:p1" />);
    await waitFor(() => expect(screen.getByText("No sends to this pane yet.")).toBeInTheDocument());
  });

  it("asks nothing for a pane on a crew member, which the bridge's route does not cross", async () => {
    let asked = 0;
    server.use(
      http.get("/api/send/receipts", () => {
        asked++;
        return HttpResponse.json({ receipts: [] });
      }),
    );
    render(<SendReceipts paneId="w1:p1" scope={{ host: "member-1" }} />);
    await waitFor(() => expect(screen.getByText("No sends to this pane yet.")).toBeInTheDocument());
    expect(asked).toBe(0);
  });
});
