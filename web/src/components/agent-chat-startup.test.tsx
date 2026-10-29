import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState, type ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { fixtureAgents, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import { withHeaderHost } from "@/test/header-host";
import { http, HttpResponse } from "msw";
import { paneScopeKey } from "@/lib/scope";
import { UNREAD_SURFACE } from "@/lib/send-slot";
import { readAgentLaunch, type AgentLaunch } from "@/lib/agent-startup";
import type { AgentView } from "@/lib/types";
import type { Surface } from "@/lib/surface/surface";
import { AgentChat } from "./agent-chat";

const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

const TRUST = readFileSync(join(process.cwd(), "src/fixtures/panes/kiro--v3-workspace-trust-continue-w120.txt"), "utf8");
const READY = readFileSync(join(process.cwd(), "src/fixtures/panes/kiro--v3-idle-w120.txt"), "utf8");
const FREE: Surface = { revision: 0, turn: "idle", composer: "empty", modal: "none" };
const ASK: Surface = { revision: 1, turn: "unknown", composer: "unknown", modal: { ask: { id: "trust", kind: "permission", channel: "keys", hash: "abc", options: [{ id: "1", label: "Yes, I trust this folder" }] } } };
const paneId = fixtureAgents[0]!.paneId;
const launch: AgentLaunch = { id: "intent", paneKey: paneScopeKey(undefined, paneId), harness: "kiro" };
const known: AgentView = { ...fixtureAgents[0]!, agent: "kiro", kind: "agent", status: "unknown", surface: UNREAD_SURFACE, sendProtocol: true };
const shell: AgentView = { ...known, agent: "shell", kind: "shell" };

function mount(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  let update = (_props: Partial<ComponentProps<typeof AgentChat>>) => {};
  const onReady = vi.fn();
  function View() {
    const [props, setProps] = useState<ComponentProps<typeof AgentChat>>({ paneId, agent: known, agents: [], shellPanes: [], tabs: [], text: "$ kiro", revision: 0,
      agentLaunch: launch, onBack: vi.fn(), onSelect: vi.fn(), onLaunchReady: onReady, ...overrides });
    update = (next) => setProps((prev) => ({ ...prev, ...next }));
    return withHeaderHost(<AgentChat {...props} />);
  }
  const router = createMemoryRouter([{ path: "/", element: <View /> }, { path: "/pane/:id", element: <span>launched pane</span> }]);
  render(<RouterProvider router={router} />);
  return { router, update: (props: Partial<ComponentProps<typeof AgentChat>>) => act(() => update(props)), onReady };
}

beforeEach(() => {
  liveness.live = true;
  server.use(http.get("/api/sent", () => HttpResponse.json({ rows: [], next: null })));
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

describe("AgentChat: a launch's startup gate", () => {
  it.each([false, true])("keeps the draft on the phone until the bridge reads the agent's first screen (inStrip: %s)", async (inStrip) => {
    const user = userEvent.setup();
    const sent = vi.fn();
    server.use(...sendHandler((request) => { sent(request.text); return sendAnswer(request.id, "sent"); }));
    const view = mount({ agent: shell, inStrip });
    const box = screen.getByRole("textbox");
    expect(box).not.toBeDisabled();
    await user.type(box, "draft survives startup");
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    // The multiplexer names the agent before the bridge has read it: still starting.
    view.update({ agent: known });
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    expect(sent).not.toHaveBeenCalled();
    expect(view.onReady).not.toHaveBeenCalled();
    view.update({ text: READY, agent: { ...known, surface: FREE } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled());
    expect(view.onReady).toHaveBeenCalledOnce();
    expect(box).toHaveValue("draft survives startup");
    view.update({ agentLaunch: undefined });
    expect(sent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledExactlyOnceWith("draft survives startup"));
  });

  it("opens on a dialog the bridge lifted, and the composer's own answer slot takes it", async () => {
    const user = userEvent.setup();
    const view = mount({ agent: shell });
    await user.type(screen.getByRole("textbox"), "kept");
    view.update({ text: TRUST, agent: { ...known, surface: ASK } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Answer the dialog" })).toBeInTheDocument());
    expect(view.onReady).toHaveBeenCalledOnce();
    expect(screen.getByText("Starting…").closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("textbox")).toHaveValue("kept");
  });

  it("does not open on a saved read, and does not unlock a pane whose sending is off", () => {
    const view = mount({ text: READY, agent: { ...known, surface: FREE }, stale: true });
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(view.onReady).not.toHaveBeenCalled();
    view.update({ stale: false, text: "$ kiro", agent: { ...known, sendProtocol: undefined } });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByText("Starting…").closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("button", { name: "Keys" })).not.toBeDisabled();
  });

  it.each([known, shell])("a pane opened without a launch keeps today's Send ($kind)", async (agent) => {
    const user = userEvent.setup();
    const sent = vi.fn();
    server.use(...sendHandler((request) => { sent(request.text); return sendAnswer(request.id, "sent"); }));
    mount({ agentLaunch: undefined, agent });
    await user.type(screen.getByRole("textbox"), "ordinary text");
    expect(screen.queryByText("Starting…")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledExactlyOnceWith("ordinary text"));
  });
});


it.each(["agent", "command"] as const)("switcher carries the launch row's %s metadata", async (kind) => {
  server.use(
    http.get("/api/launchers", () => HttpResponse.json({ home: "/home", launchers: [{ command: "kiro", label: "Launch Kiro", kind, harness: "kiro" }] })),
    http.post("/api/launch", () => HttpResponse.json({ ok: true, pane: { paneId: "new:p1", workspaceId: "new", workspaceLabel: "Kiro", tabId: "new:t1", cwd: "/home" } })),
  );
  const { router } = mount({ agentLaunch: undefined });
  await userEvent.click(await screen.findByRole("button", { name: "Switch pane" }));
  await userEvent.click(await screen.findByText("Launch Kiro"));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pane/new%3Ap1"));
  expect(readAgentLaunch(router.state.location.state, "new:p1")?.harness).toBe(kind === "agent" ? "kiro" : undefined);
});
