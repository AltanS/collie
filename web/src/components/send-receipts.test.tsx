import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import type { SendReceiptRow } from "@/lib/surface/send";
import { SendReceipts, SendReceiptsView } from "./send-receipts";

// The session page's list of recent sends (M56 spec 09): outcome, reason, time, the line the bridge
// kept of the text (when Sent's rule kept one), and on tap the whole line, the keys by name and the
// measured gaps. A receipt holds no screen row, and the list shows none, even when a body carries a
// field it should not; of the text it shows `line` and nothing else.

const NOW = 1_000_000_000;
const rows: readonly SendReceiptRow[] = [
  { requestId: "req00001", at: NOW - 30_000, mode: "send", outcome: "sent", keys: ["probe", "Backspace", "Enter"], gapsMs: { s0: 123, probe: 166, s1: 83, s2: 82 }, harness: "agent", version: "2.1.301" },
  { requestId: "req00002", at: NOW - 5 * 60_000, mode: "send", outcome: "refused", reason: "not_free", keys: [], gapsMs: { s0: 240 }, harness: "agent", version: "2.1.301" },
  { requestId: "req00003", at: NOW - 2 * 3_600_000, mode: "command", outcome: "typed_not_submitted", reason: "modal_cue", keys: ["Enter"], gapsMs: {}, harness: "agent", version: null },
];

describe("SendReceiptsView", () => {
  it("says under the heading how long Collie keeps the line of a send, and which lines it does not keep", () => {
    render(<SendReceiptsView rows={rows} now={NOW} />);
    expect(screen.getByText("Collie keeps the line of a send on this machine for seven days. A line that looks like a secret is not kept.")).toBeInTheDocument();
  });

  it("lists each receipt with its outcome, its reason and how long ago, newest first as given", () => {
    render(<SendReceiptsView rows={rows} now={NOW} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Sent");
    expect(items[0]).toHaveTextContent(/just now/i);
    expect(items[1]).toHaveTextContent("Refused");
    expect(items[1]).toHaveTextContent("The input box is not free. Nothing was typed.");
    expect(items[1]).toHaveTextContent("5m ago");
    expect(items[2]).toHaveTextContent("Typed, not sent");
    expect(items[2]).toHaveTextContent("Your text is in the box, but Enter was not pressed. Submit it or discard it.");
  });

  it("shows steered as its own outcome word, and a refused steer with its sentence (M69)", () => {
    const steer: readonly SendReceiptRow[] = [
      { requestId: "req00010", at: NOW, mode: "send", outcome: "steered", keys: ["Enter"], gapsMs: {}, harness: "pi", version: "1.3.0" },
      { requestId: "req00011", at: NOW, mode: "send", outcome: "refused", reason: "steer_unsupported", keys: [], gapsMs: {}, harness: "pi", version: null },
    ];
    render(<SendReceiptsView rows={steer} now={NOW} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]?.querySelector(".font-medium")).toHaveTextContent(/^Steered$/u);
    expect(items[0]).not.toHaveTextContent("the agent takes it after its current step");
    expect(items[1]).toHaveTextContent("Steer is not available on this pane. Nothing was sent.");
  });

  it("says a reason with the composer's sentence and keeps the raw code in the title only", () => {
    const more: readonly SendReceiptRow[] = [
      { requestId: "req00004", at: NOW, mode: "command", outcome: "typed_not_submitted", reason: "changed", keys: ["probe", "Backspace"], gapsMs: {}, harness: "agent", version: "2.1.301" },
      { requestId: "req00005", at: NOW, mode: "send", outcome: "refused", reason: "multiline", keys: [], gapsMs: {}, harness: "agent", version: null },
      { requestId: "req00006", at: NOW, mode: "send", outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"], gapsMs: {}, harness: "agent", version: null },
    ];
    render(<SendReceiptsView rows={[...rows, ...more]} now={NOW} />);
    const items = screen.getAllByRole("listitem");
    expect(screen.getByTitle("not_free")).toHaveTextContent("The input box is not free. Nothing was typed.");
    expect(screen.getByTitle("changed")).toHaveTextContent("Your text is in the box, but Enter was not pressed. Submit it or discard it.");
    expect(screen.getByTitle("multiline")).toHaveTextContent("The send was refused. Nothing was typed.");
    expect(screen.getByTitle("probe_failed")).toHaveTextContent("Typing did not land in the input box, so nothing was typed. Check the pane.");
    for (const item of items) expect(item.textContent).not.toMatch(/not_free|modal cue|modal_cue|\bchanged\b|multiline|probe_failed|probe failed/u);
  });

  it("a discard is listed as Discard with its own sentence, not as Sent (send drill 3, 7e)", () => {
    const discard: SendReceiptRow = { requestId: "req00007", at: NOW, mode: "discard", outcome: "discarded", keys: ["Backspace"], gapsMs: {}, harness: "codex", version: null };
    render(<SendReceiptsView rows={[discard]} now={NOW} />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("Discard");
    expect(item).toHaveTextContent("The text was removed from the box. Your draft is still here.");
    expect(item).not.toHaveTextContent("Sent");
  });

  it("a send queued behind the agent's turn is listed as Sent with the detail that it was queued", () => {
    const queued: SendReceiptRow = { requestId: "req00010", at: NOW, mode: "send", outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"], gapsMs: {}, harness: "claude", version: "2.1.301" };
    render(<SendReceiptsView rows={[queued]} now={NOW} />);
    const item = screen.getByRole("listitem");
    expect(item).toHaveTextContent("Sent");
    expect(item).toHaveTextContent("Queued behind the agent's turn");
  });

  it("the cap's refusal reads as the cap's sentence with the receipt's numbers, and names the harness alone without a version (send drill 3, 2)", () => {
    const refused: SendReceiptRow = { requestId: "req00008", at: NOW, mode: "send", outcome: "refused", reason: "unconfirmed", keys: [], gapsMs: {}, harness: "codex", version: null };
    const withVersion: SendReceiptRow = { ...refused, requestId: "req00009", cap: { count: 5, limit: 5, harness: "codex", version: "0.163.0" } };
    const noVersion: SendReceiptRow = { ...refused, requestId: "req00010", cap: { count: 5, limit: 5, harness: "codex", version: "-" } };
    render(<SendReceiptsView rows={[refused, withVersion, noVersion]} now={NOW} />);
    const [plain, versioned, bare] = screen.getAllByRole("listitem");
    expect(plain).toHaveTextContent("Collie cannot read this screen. Check the pane, then tap Type here.");
    expect(versioned).toHaveTextContent("Collie could not read this screen on codex 0.163.0 5 times today. Check the screen, then tap Confirm and type.");
    expect(bare).toHaveTextContent("Collie could not read this screen on codex 5 times today. Check the screen, then tap Confirm and type.");
    expect(bare.textContent).not.toMatch(/codex -|\s{2}/u);
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

  it("prints the line under a row cut to one line, the whole line once the row is open, and nothing under a row without one (2026-10-21)", async () => {
    const user = userEvent.setup();
    const long = "ok check please it's past 2pm and the Launchpad waiter stays armed until the report lands";
    const withLine: SendReceiptRow = { ...rows[0]!, line: long };
    const bare: SendReceiptRow = { ...rows[1]!, requestId: "req00011" };
    const { container } = render(<SendReceiptsView rows={[withLine, bare]} now={NOW} />);
    const lines = container.querySelectorAll('[data-slot="send-receipt-line"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(long);
    expect(lines[0]).toHaveClass("truncate");
    expect(lines[0]).not.toHaveClass("whitespace-pre-wrap");
    const [first] = screen.getAllByRole("button");
    await user.click(first!);
    const opened = container.querySelector('[data-slot="send-receipt-line"]');
    expect(opened).toHaveClass("whitespace-pre-wrap");
    expect(opened).not.toHaveClass("truncate");
    expect(screen.getByText("Keys: probe, Backspace, Enter")).toBeInTheDocument();
  });

  it("says so when there is nothing to list", () => {
    render(<SendReceiptsView rows={[]} now={NOW} />);
    expect(screen.getByText("No sends to this pane yet.")).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});

describe("SendReceipts", () => {
  it("reads the bridge's list and draws its line, and no other text or screen row, even if the body carries one", async () => {
    server.use(
      http.get("/api/send/receipts", ({ request }) => {
        expect(new URL(request.url).searchParams.get("pane")).toBe("w1:p1");
        return HttpResponse.json({
          receipts: [{ ...rows[0]!, line: "git status", text: "sk-live-secret-text", rows: ["a row with a password hunter2"], textHash: "deadbeef" }],
        });
      }),
    );
    const { container } = render(<SendReceipts paneId="w1:p1" />);
    await waitFor(() => expect(screen.getByText("Sent")).toBeInTheDocument());
    expect(container).toHaveTextContent("git status");
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
