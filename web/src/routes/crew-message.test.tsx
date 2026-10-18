import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { asJsonString, parseJsonObject } from "@/lib/json";
import { ROOT_ROUTE_ID, type CrewData, type HomeData } from "@/lib/loaders";
import { markNotPaired } from "@/lib/pairing";
import { fixtureCrewStatus, fixtureServers, recordedWalkyPosts } from "@/test/handlers";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { CrewRoute } from "./crew";

// "Message all agents" on the Crew page (M62 spec 05): a sheet with a text field and a target picker,
// one post to `POST /api/walky`, and one receipt row per target the bridge answers.

function renderCrew(data: CrewData = { status: fixtureCrewStatus, error: false }) {
  const router = createMemoryRouter(
    [{ path: "/crew", loader: () => data, element: withHeaderHost(<CrewProvider servers={fixtureServers}><CrewRoute /></CrewProvider>) }],
    { initialEntries: ["/crew"] },
  );
  render(<RouterProvider router={router} />);
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Message all agents" }));
  return screen.findByRole("dialog");
}

/** Tap "Send message", then the confirm step's "Send": the two taps a message now takes. */
async function sendAndConfirm(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("button", { name: "Send message" }));
  await user.click(await within(dialog).findByRole("button", { name: "Send" }));
}

const WHO_TARGETS = [
  { address: "bluefin/w1:p1", memberId: "bluefin", machine: "bluefin", harness: "claude", label: "a#b", state: "idle" },
  { address: "workshop/w1:p1", memberId: "workshop", machine: "workshop", harness: "codex", label: "c#d", state: "idle" },
  { address: "workshop/w2:p1", memberId: "workshop", machine: "workshop", harness: "pi", label: "e#f", state: "idle" },
];

describe("Message all agents", () => {
  it("posts to all with a minted id and lists one receipt row per target", async () => {
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox"), "Pause and report status");
    await sendAndConfirm(user, dialog);
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    const [posted] = recordedWalkyPosts();
    expect(posted).toMatchObject({ to: "all", body: "Pause and report status" });
    expect(posted?.id).toMatch(/^wt_[a-z0-9]{12}$/);
    const rows = await within(dialog).findAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "bluefin/w1:p1queued · this machine",
      "minibuch/w2:p1queued · this machine",
    ]);
    // The text left with the message.
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
  });

  it("names each receipt's target by its label when the who list knows it", async () => {
    server.use(
      http.get("/api/walky/who", () =>
        HttpResponse.json({
          targets: [{ address: "bluefin/w1:p1", memberId: "bluefin", machine: "bluefin", harness: "claude", label: "collie#main", state: "idle" }],
        }),
      ),
    );
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    await within(dialog).findByText("Agents reached: 1");
    await user.type(within(dialog).getByRole("textbox"), "hi");
    await sendAndConfirm(user, dialog);
    expect(await within(dialog).findByText("collie#main (bluefin/w1:p1)")).toBeInTheDocument();
    expect(within(dialog).getByText("minibuch/w2:p1")).toBeInTheDocument();
  });

  it("aims at one machine as <memberId>/all", async () => {
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByRole("combobox"), "workshop");
    await user.type(within(dialog).getByRole("textbox"), "Hello workshop");
    await sendAndConfirm(user, dialog);
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    expect(recordedWalkyPosts()[0]).toMatchObject({ to: "workshop/all", body: "Hello workshop" });
    expect(await within(dialog).findAllByRole("listitem")).toHaveLength(1);
  });

  it("counts the agents the target reaches, from the who list", async () => {
    server.use(
      http.get("/api/walky/who", () =>
        HttpResponse.json({
          targets: [
            { address: "bluefin/w1:p1", memberId: "bluefin", machine: "bluefin", harness: "claude", label: "a#b", state: "idle" },
            { address: "workshop/w1:p1", memberId: "workshop", machine: "workshop", harness: "codex", label: "c#d", state: "idle" },
            { address: "workshop/w2:p1", memberId: "workshop", machine: "workshop", harness: "pi", label: "e#f", state: "idle" },
          ],
        }),
      ),
    );
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    expect(await within(dialog).findByText("Agents reached: 3")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByRole("combobox"), "workshop");
    expect(within(dialog).getByText("Agents reached: 2")).toBeInTheDocument();
  });

  describe("the confirm step", () => {
    const whoWith = () => server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets: WHO_TARGETS })));

    it("asks with the count of agents and machines, and posts nothing until Send", async () => {
      whoWith();
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message 3 agents on 2 machines?")).toBeInTheDocument();
      expect(recordedWalkyPosts()).toHaveLength(0);
      // The first button of the question is the safe answer, and it holds focus.
      expect(within(dialog).getByRole("button", { name: "Back" })).toHaveFocus();
    });

    it("counts only the machine chosen", async () => {
      whoWith();
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.selectOptions(within(dialog).getByRole("combobox"), "workshop");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message 2 agents on 1 machine?")).toBeInTheDocument();
    });

    it("says 1 agent on 1 machine in the singular", async () => {
      server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets: [WHO_TARGETS[0]] })));
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 1");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message 1 agent on 1 machine?")).toBeInTheDocument();
    });

    it("Back returns to the form without posting, and keeps the text", async () => {
      whoWith();
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      await user.click(await within(dialog).findByRole("button", { name: "Back" }));
      expect(within(dialog).getByRole("button", { name: "Send message" })).toBeInTheDocument();
      expect(within(dialog).queryByText(/^Message \d+ agents?/)).toBeNull();
      expect(within(dialog).getByRole("textbox")).toHaveValue("Pause");
      expect(recordedWalkyPosts()).toHaveLength(0);
    });

    it("Back hands focus to Send message, so the keyboard path does not fall out of the sheet", async () => {
      whoWith();
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      await user.click(await within(dialog).findByRole("button", { name: "Back" }));
      expect(within(dialog).getByRole("button", { name: "Send message" })).toHaveFocus();
    });

    it("hands focus to the receipts once Send is answered, inside the sheet", async () => {
      whoWith();
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await sendAndConfirm(user, dialog);
      await within(dialog).findAllByRole("listitem");
      const receipts = dialog.querySelector('[data-slot="walky-receipts"]');
      await waitFor(() => expect(receipts).toHaveFocus());
    });

    it("hands focus to the error when no answer came", async () => {
      whoWith();
      server.use(http.post("/api/walky", () => HttpResponse.error()));
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await sendAndConfirm(user, dialog);
      const alert = await within(dialog).findByRole("alert");
      await waitFor(() => expect(alert).toHaveFocus());
    });

    it("posts once on Send", async () => {
      whoWith();
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await within(dialog).findByText("Agents reached: 3");
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await sendAndConfirm(user, dialog);
      await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
      expect(recordedWalkyPosts()[0]).toMatchObject({ to: "all", body: "Pause" });
      expect(within(dialog).queryByText(/^Message \d+ agents?/)).toBeNull();
    });

    it("leaves out the panes of a machine the lead cannot reach right now, from the count and the question", async () => {
      // The lead's who keeps an unreachable member's last panes, each with the state `unreachable`.
      const targets = WHO_TARGETS.map((target) => (target.memberId === "workshop" ? { ...target, state: "unreachable" } : target));
      server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets })));
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      expect(await within(dialog).findByText("Agents reached: 1")).toBeInTheDocument();
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message 1 agent on 1 machine?")).toBeInTheDocument();
    });

    it("says the count is not known when the who list could not be read, and still asks", async () => {
      server.use(http.get("/api/walky/who", () => new HttpResponse(null, { status: 500 })));
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      await user.type(within(dialog).getByRole("textbox"), "Pause");
      await user.click(within(dialog).getByRole("button", { name: "Send message" }));
      expect(await within(dialog).findByText("Message every agent? The count is not known.")).toBeInTheDocument();
      expect(recordedWalkyPosts()).toHaveLength(0);
    });
  });

  describe("what the who answer adds", () => {
    const SKIPPED = [
      { address: "bluefin/w1:p2", memberId: "bluefin", machine: "bluefin", label: "zsh" },
      { address: "workshop/w3:p1", memberId: "workshop", machine: "workshop", label: "bash" },
    ];

    it("lists the skipped shell panes the target covers, under a small heading", async () => {
      server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets: WHO_TARGETS, skipped: SKIPPED })));
      const user = userEvent.setup();
      renderCrew();
      const dialog = await open(user);
      expect(await within(dialog).findByText("Shell panes, skipped")).toBeInTheDocument();
      expect(within(dialog).getByText("zsh (bluefin/w1:p2): skipped")).toBeInTheDocument();
      expect(within(dialog).getByText("bash (workshop/w3:p1): skipped")).toBeInTheDocument();
      await user.selectOptions(within(dialog).getByRole("combobox"), "workshop");
      expect(within(dialog).queryByText("zsh (bluefin/w1:p2): skipped")).toBeNull();
      expect(within(dialog).getByText("bash (workshop/w3:p1): skipped")).toBeInTheDocument();
    });

    it("draws nothing about shell panes when there are none", async () => {
      server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets: WHO_TARGETS })));
      renderCrew();
      const dialog = await open(userEvent.setup());
      await within(dialog).findByText("Agents reached: 3");
      expect(within(dialog).queryByText("Shell panes, skipped")).toBeNull();
    });

    it("shows what this bridge refused, as reason and count in the bridge's words", async () => {
      server.use(
        http.get("/api/walky/who", () =>
          HttpResponse.json({ targets: WHO_TARGETS, refusals: { counts: { "rate limit": 3, "pair limit": 1, off: 0 }, since: 1_700_000_000_000 } }),
        ),
      );
      renderCrew();
      const dialog = await open(userEvent.setup());
      expect(await within(dialog).findByText("Not sent on this machine: rate limit 3, pair limit 1")).toBeInTheDocument();
    });

    it("draws no refusals line when the counts are empty or absent", async () => {
      server.use(http.get("/api/walky/who", () => HttpResponse.json({ targets: WHO_TARGETS, refusals: { counts: {}, since: null } })));
      renderCrew();
      const dialog = await open(userEvent.setup());
      await within(dialog).findByText("Agents reached: 3");
      expect(within(dialog).queryByText(/Not sent on this machine/)).toBeNull();
    });
  });

  it("keeps the text and reuses the id when the answer is lost, so a retry types nothing twice", async () => {
    const ids: string[] = [];
    server.use(
      http.post("/api/walky", async ({ request }) => {
        ids.push(asJsonString(parseJsonObject(await request.text())?.id) ?? "");
        return ids.length === 1 ? HttpResponse.error() : HttpResponse.json({ receipts: [] });
      }),
    );
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox"), "Once only");
    await sendAndConfirm(user, dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Message not sent:");
    expect(within(dialog).getByRole("textbox")).toHaveValue("Once only");
    await sendAndConfirm(user, dialog);
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
  });

  describe("a device that may not send", () => {
    /** The Crew page under a root route whose device the bridge does not let write. */
    function renderReadOnlyCrew() {
      const root: HomeData = {
        bridge: "connected",
        device: { enforced: true, device: "kiosk", authorized: false },
        agents: [],
        shellPanes: [],
        workspaces: [],
        tabs: [],
        sessions: [],
        servers: [],
        ts: 0,
        scope: {},
        viewAll: false,
        snoozedUntil: null,
        update: undefined,
        error: false,
        authError: false,
      };
      const router = createMemoryRouter(
        [
          {
            id: ROOT_ROUTE_ID,
            path: "/",
            loader: () => root,
            children: [
              {
                path: "crew",
                loader: () => ({ status: fixtureCrewStatus, error: false }),
                element: withHeaderHost(<CrewProvider servers={fixtureServers}><CrewRoute /></CrewProvider>),
              },
            ],
          },
        ],
        { initialEntries: ["/crew"] },
      );
      render(<RouterProvider router={router} />);
    }

    it("shows why the button is off in words a touch screen can read, not only in a tooltip", async () => {
      renderReadOnlyCrew();
      const button = await screen.findByRole("button", { name: "Message all agents" });
      expect(button).toBeDisabled();
      expect(screen.getByText("This device may not send messages.")).toBeVisible();
      expect(button).toHaveAccessibleDescription("This device may not send messages.");
    });

    it("treats a device the bridge refused for want of pairing the same way", async () => {
      markNotPaired();
      renderCrew();
      const button = await screen.findByRole("button", { name: "Message all agents" });
      expect(button).toBeDisabled();
      expect(screen.getByText("This device may not send messages.")).toBeVisible();
    });

    it("says nothing about it on a device that may send", async () => {
      renderCrew();
      expect(await screen.findByRole("button", { name: "Message all agents" })).toBeEnabled();
      expect(screen.queryByText("This device may not send messages.")).toBeNull();
    });
  });

  it("is not offered on a solo install, where the page has no crew to message", async () => {
    renderCrew({ status: null, error: false });
    await screen.findByRole("heading", { name: /crew/i });
    expect(screen.queryByRole("button", { name: "Message all agents" })).toBeNull();
  });
});
