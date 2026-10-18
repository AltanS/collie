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
});
