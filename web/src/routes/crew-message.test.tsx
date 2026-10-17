import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { asJsonString, parseJsonObject } from "@/lib/json";
import { type CrewData } from "@/lib/loaders";
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

describe("Message all agents", () => {
  it("posts to all with a minted id and lists one receipt row per target", async () => {
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    await user.type(within(dialog).getByRole("textbox"), "Pause and report status");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(recordedWalkyPosts()).toHaveLength(1));
    const [posted] = recordedWalkyPosts();
    expect(posted).toMatchObject({ to: "all", body: "Pause and report status" });
    expect(posted?.id).toMatch(/^wt_[a-z0-9]{12}$/);
    const rows = await within(dialog).findAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "bluefin/w1:p1Logged, not typed yet · local",
      "minibuch/w2:p1Logged, not typed yet · local",
    ]);
    // The text left with the message.
    expect(within(dialog).getByRole("textbox")).toHaveValue("");
  });

  it("aims at one machine as <memberId>/all", async () => {
    const user = userEvent.setup();
    renderCrew();
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByRole("combobox"), "workshop");
    await user.type(within(dialog).getByRole("textbox"), "Hello workshop");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
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
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Message not sent:");
    expect(within(dialog).getByRole("textbox")).toHaveValue("Once only");
    await user.click(within(dialog).getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(ids).toHaveLength(2));
    expect(ids[1]).toBe(ids[0]);
  });

  it("is not offered on a solo install, where the page has no crew to message", async () => {
    renderCrew({ status: null, error: false });
    await screen.findByRole("heading", { name: /crew/i });
    expect(screen.queryByRole("button", { name: "Message all agents" })).toBeNull();
  });
});
