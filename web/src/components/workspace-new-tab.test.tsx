import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import type { NewTabTarget } from "@/hooks/use-new-tab-or-sheet";
import { useStatus } from "@/lib/status";
import type { MuxConfig, ServerSummary } from "@/lib/types";
import { server } from "@/test/msw";
import { CrewProvider } from "./crew-provider";
import { WorkspaceNewTab } from "./workspace-new-tab";

// The heading "+" (M40/03) after M91: its own refusals come first, and past them it hands the caller a
// whole target, the workspace, its machine and the pane to open the tab beside, which the caller's
// `useNewTabOrSheet` turns into the New tab sheet or the shell.

const LEAD = "bluefin";
const PEER = "workshop";
const BESIDE = { paneId: "w1:p1", workspaceId: "w1", cwd: "/home/you/moonward" };

function declaresCreateTab(): void {
  const mux: MuxConfig = { name: "reference", capabilities: { createTab: true }, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

function StatusText() {
  return <output aria-label="status">{useStatus()?.text ?? ""}</output>;
}

function mount(servers: ServerSummary[], beside: typeof BESIDE | undefined) {
  declaresCreateTab();
  const taps: NewTabTarget[] = [];
  const { container } = render(
    <CrewProvider servers={servers} sessions={[]} ts={60_000} pollMs={1500}>
      <WorkspaceNewTab
        workspaceId="w1"
        label="moonward"
        at={{ host: PEER }}
        host={PEER}
        beside={beside}
        busy={false}
        onNewTab={(t) => taps.push(t)}
      />
      <StatusText />
    </CrewProvider>,
  );
  return { taps, container };
}

const crew = (peerReachable: boolean): ServerSummary[] => [
  { id: LEAD, name: LEAD, isLead: true, reachable: true, protocol: "ok", lastSeenAt: 60_000 },
  { id: PEER, name: PEER, isLead: false, reachable: peerReachable, protocol: "ok", lastSeenAt: peerReachable ? 59_000 : 1_000 },
];

describe("WorkspaceNewTab", () => {
  it("hands the caller the workspace, its machine and the pane to open the tab beside", async () => {
    const { taps } = mount(crew(true), BESIDE);
    await userEvent.click(await screen.findByRole("button", { name: "New tab in moonward" }));
    expect(taps).toEqual([{ workspaceId: "w1", label: "moonward", at: { host: PEER }, beside: BESIDE }]);
  });

  it("names no pane when the group holds none of the workspace's own", async () => {
    const { taps } = mount(crew(true), undefined);
    await userEvent.click(await screen.findByRole("button", { name: "New tab in moonward" }));
    expect(taps).toHaveLength(1);
    expect(taps[0]).not.toHaveProperty("beside");
  });

  it("refuses first on a machine not taking writes: the caller hears nothing, so no sheet opens", async () => {
    const { taps, container } = mount(crew(false), BESIDE);
    await userEvent.click(await screen.findByRole("button", { name: "New tab in moonward" }));
    expect(taps).toEqual([]);
    expect(within(container).getByRole("status", { name: "status" })).toHaveTextContent(/workshop/);
  });
});
