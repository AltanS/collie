import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { recordedWalkyPosts } from "@/test/handlers";
import { server } from "@/test/setup";

import { WalkyBroadcastSheet } from "./walky-broadcast-sheet";

// The Crew page's broadcast sheet on its own (M62): a text past the message limit, and a machine
// that leaves the crew while it is the chosen target. The page around it is covered in
// routes/crew-message.test.tsx.

const MEMBERS = [
  { id: "bluefin", name: "bluefin" },
  { id: "workshop", name: "workshop" },
];
const TARGETS = [
  { address: "bluefin/w1:p1", memberId: "bluefin", machine: "bluefin", harness: "claude", label: "a#b", state: "idle" },
  { address: "workshop/w1:p1", memberId: "workshop", machine: "workshop", harness: "codex", label: "c#d", state: "idle" },
];

beforeEach(() => {
  server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets: TARGETS })));
});

describe("WalkyBroadcastSheet", () => {
  it("turns Send off for a text past the limit and says why, in the message limit's words", async () => {
    render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
    const dialog = await screen.findByRole("dialog");
    const box = within(dialog).getByRole("textbox", { name: "Message" });
    fireEvent.change(box, { target: { value: "x".repeat(4_001) } });
    expect(within(dialog).getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(within(dialog).getByText("A message holds at most 4,000 characters.")).toBeVisible();
    expect(box).toHaveAccessibleDescription("A message holds at most 4,000 characters.");
    expect(box).toHaveAccessibleName("Message");
    fireEvent.change(box, { target: { value: "x".repeat(4_000) } });
    expect(within(dialog).getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(within(dialog).queryByText("A message holds at most 4,000 characters.")).toBeNull();
  });

  it("names a receipt for the bare target `all` as every machine, never the raw word", async () => {
    server.use(
      http.post("/api/walky", () =>
        HttpResponse.json({ receipts: [{ id: "wt_aaaaaaaaaaaa", state: "accepted", verified: "local", at: 1, by: "bluefin", target: "all" }] }),
      ),
    );
    const user = userEvent.setup();
    render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await user.click(await within(dialog).findByRole("button", { name: "Send" }));
    const [row] = await within(dialog).findAllByRole("listitem");
    expect(row).toHaveTextContent(/^every machinequeued · this machine$/);
  });

  it("shows a receipt's bare target with the label of a `who` pane that carries a session token", async () => {
    server.use(
      http.get("/api/walky/who", () =>
        HttpResponse.json({ targets: [{ ...TARGETS[0]!, address: "bluefin/w1:p1#k3f9" }, TARGETS[1]!] }),
      ),
      http.post("/api/walky", () =>
        HttpResponse.json({
          receipts: [
            { id: "wt_aaaaaaaaaaaa", state: "delivered", verified: "local", at: 1, by: "bluefin", target: "bluefin/w1:p1" },
            { id: "wt_aaaaaaaaaaaa", state: "refused", reason: "pane replaced", verified: "local", at: 1, by: "workshop", target: "workshop/w1:p1" },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Agents reached: 2");
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await user.click(await within(dialog).findByRole("button", { name: "Send" }));
    const rows = await within(dialog).findAllByRole("listitem");
    // No live pane is known, so the `who` label names the session, with its machine; the address stays on the wire.
    expect(rows[0]).toHaveTextContent("a#b on bluefin");
    expect(rows[1]).toHaveTextContent("c#d on workshop");
    expect(rows[1]).not.toHaveTextContent("workshop/w1:p1");
    expect(rows[1]).toHaveTextContent("not sent: pane replaced");
  });

  it("names a receipt's target by its live pane when the phone knows the pane (M80 spec 12)", async () => {
    server.use(
      http.post("/api/walky", () =>
        HttpResponse.json({
          receipts: [{ id: "wt_aaaaaaaaaaaa", state: "refused", reason: "turn running", verified: "local", at: 1, by: "workshop", target: "workshop/w1:p1" }],
        }),
      ),
    );
    const user = userEvent.setup();
    const live = {
      panes: [{ paneId: "w1:p1", host: "workshop", workspaceId: "w1", workspaceLabel: "c", workspaceNumber: 1, tabId: "w1:t1", agent: "codex", status: "idle" as const, cwd: "/", focused: false, paneLabel: "release notes" }],
      lead: "bluefin",
    };
    render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} live={live} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Agents reached: 2");
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await user.click(await within(dialog).findByRole("button", { name: "Send" }));
    const [row] = await within(dialog).findAllByRole("listitem");
    expect(row).toHaveTextContent("release notes on workshop");
    expect(row).not.toHaveTextContent("c#d");
    expect(row).not.toHaveTextContent("workshop/w1:p1");
    expect(row).toHaveTextContent("not sent: that session is busy");
  });

  it("does not name a replaced pane by its newcomer: the who address carries the old instance token", async () => {
    server.use(
      http.get("/api/walky/who", () =>
        HttpResponse.json({ targets: [TARGETS[0]!, { ...TARGETS[1]!, address: "workshop/w1:p1#k3f9" }] }),
      ),
      http.post("/api/walky", () =>
        HttpResponse.json({
          receipts: [{ id: "wt_aaaaaaaaaaaa", state: "delivered", verified: "local", at: 1, by: "workshop", target: "workshop/w1:p1" }],
        }),
      ),
    );
    const user = userEvent.setup();
    const live = {
      panes: [{ paneId: "w1:p1", host: "workshop", instance: "n3w1", workspaceId: "w1", workspaceLabel: "c", workspaceNumber: 1, tabId: "w1:t1", agent: "codex", status: "idle" as const, cwd: "/", focused: false, paneLabel: "newcomer" }],
      lead: "bluefin",
    };
    render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} live={live} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Agents reached: 2");
    await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await user.click(await within(dialog).findByRole("button", { name: "Send" }));
    const [row] = await within(dialog).findAllByRole("listitem");
    expect(row).toHaveTextContent("c#d on workshop");
    expect(row).not.toHaveTextContent("newcomer");
  });

  it("drops a chosen machine that left the crew: the picker, the count and the question go back to every machine", async () => {
    const user = userEvent.setup();
    const view = render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Agents reached: 2");
    await user.selectOptions(within(dialog).getByRole("combobox"), "workshop");
    await user.type(within(dialog).getByRole("textbox"), "Pause");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    expect(await within(dialog).findByText("Message 1 agent on 1 machine?")).toBeInTheDocument();
    // workshop leaves the crew while its question stands.
    view.rerender(<WalkyBroadcastSheet open onClose={vi.fn()} members={[MEMBERS[0]!]} />);
    expect(within(dialog).queryByRole("option", { name: "workshop" })).toBeNull();
    expect(within(dialog).getByRole("combobox")).toHaveValue("all");
    // The question for the old target is gone, so it cannot be answered for a target nobody chose.
    expect(within(dialog).queryByText("Message 1 agent on 1 machine?")).toBeNull();
    expect(within(dialog).getByText("Agents reached: 2")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await user.click(await within(dialog).findByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: "all" });
  });

  describe("resting panes (M85)", () => {
    const SKIPPED = [
      { address: "bluefin/w1:p3", memberId: "bluefin", machine: "bluefin", label: "sh#main", reason: "shell" },
      { address: "workshop/w1:p1", memberId: "workshop", machine: "workshop", label: "c#d", reason: "resting" },
    ];
    beforeEach(() => {
      // The who list gives the resting pane's address with its instance token; the skipped row carries the bare one.
      server.use(
        http.get("/api/walky/who", () =>
          HttpResponse.json({ targets: [TARGETS[0]!, { ...TARGETS[1]!, address: "workshop/w1:p1#k3f9" }], skipped: SKIPPED, refusals: null }),
        ),
      );
    });

    it("lists them under their own title with the switch off, and counts only the panes that will be typed into", async () => {
      render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText("Agents reached: 1")).toBeInTheDocument();
      const resting = dialog.querySelector('[data-slot="walky-resting"]') as HTMLElement;
      expect(within(resting).getByText("Resting, not woken")).toBeInTheDocument();
      expect(within(resting).getByText("c#d (workshop/w1:p1): resting")).toBeInTheDocument();
      expect(within(resting).getByRole("switch", { name: "Wake them too" })).toHaveAttribute("aria-checked", "false");
      // The shell keeps its own group, and the resting pane is not in it.
      const shells = dialog.querySelector('[data-slot="walky-skipped"]') as HTMLElement;
      expect(within(shells).getByText("Shell panes, skipped")).toBeInTheDocument();
      expect(within(shells).getByText("sh#main (bluefin/w1:p3): skipped")).toBeInTheDocument();
      expect(within(shells).queryByText(/c#d/)).toBeNull();
    });

    it("posts no wake with the switch off", async () => {
      const user = userEvent.setup();
      render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Agents reached: 1");
      await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message 1 agent on 1 machine?")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
      expect(recordedWalkyPosts()[0]).toEqual(expect.objectContaining({ to: "all" }));
      expect(recordedWalkyPosts()[0]).not.toHaveProperty("wake");
    });

    it("\"Wake them too\" counts the woken set, retitles the group and posts wake: true", async () => {
      const user = userEvent.setup();
      render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Agents reached: 1");
      await user.click(within(dialog).getByRole("switch", { name: "Wake them too" }));
      expect(within(dialog).getByText("Agents reached: 2")).toBeInTheDocument();
      expect(within(dialog).getByText("Resting, woken too")).toBeInTheDocument();
      await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message 2 agents on 2 machines?")).toBeInTheDocument();
      await user.click(within(dialog).getByRole("button", { name: "Send" }));
      await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
      expect(recordedWalkyPosts()[0]).toMatchObject({ to: "all", wake: true });
    });

    it("a machine with no resting pane shows no group, and never sends wake", async () => {
      const user = userEvent.setup();
      render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Agents reached: 1");
      await user.click(within(dialog).getByRole("switch", { name: "Wake them too" }));
      await user.selectOptions(within(dialog).getByRole("combobox"), "bluefin");
      expect(dialog.querySelector('[data-slot="walky-resting"]')).toBeNull();
      await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      await user.click(await within(dialog).findByRole("button", { name: "Send" }));
      await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
      expect(recordedWalkyPosts()[0]).not.toHaveProperty("wake");
    });

    it("words a resting receipt in plain words", async () => {
      server.use(
        http.post("/api/walky", () =>
          HttpResponse.json({ receipts: [{ id: "wt_aaaaaaaaaaaa", state: "inbox-only", reason: "resting", verified: "local", at: 1, by: "workshop", target: "workshop/w1:p1" }] }),
        ),
      );
      const user = userEvent.setup();
      render(<WalkyBroadcastSheet open onClose={vi.fn()} members={MEMBERS} />);
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Agents reached: 1");
      await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      await user.click(await within(dialog).findByRole("button", { name: "Send" }));
      const receipts = dialog.querySelector('[data-slot="walky-receipts"]') as HTMLElement;
      expect(await within(receipts).findByText(/waiting in the inbox, not typed: that session rests/u)).toBeInTheDocument();
    });
  });
});
