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
import { submitPromptOption } from "@/lib/prompt-action";
import { AgentChat } from "./agent-chat";

vi.mock("@/lib/prompt-action", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/prompt-action")>()),
  submitPromptOption: vi.fn(async () => ({ status: "changed" })),
}));

const liveness = vi.hoisted(() => ({ live: true }));
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => liveness.live,
  useLive: () => liveness.live,
}));

const TRUST = readFileSync(join(process.cwd(), "src/fixtures/panes/kiro--v3-workspace-trust-continue-w120.txt"), "utf8");
const READY = readFileSync(join(process.cwd(), "src/fixtures/panes/kiro--v3-idle-w120.txt"), "utf8");
const FREE: Surface = { revision: 0, turn: "idle", composer: "empty", modal: "none" };
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

describe("AgentChat startup readiness", () => {
  it("keeps the fabricated shell draft local until trust, then normal readiness never sends it", async () => {
    const user = userEvent.setup();
    const sent = vi.fn();
    server.use(...sendHandler((request) => { sent(request.text); return sendAnswer(request.id, "sent"); }));
    const bootstrap: AgentView = { ...shell, surface: undefined, sendProtocol: undefined };
    const view = mount({ agent: bootstrap, bootstrap: true });
    const box = screen.getByRole("textbox");
    expect(box).not.toBeDisabled();
    await user.type(box, "draft survives startup");
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    expect(sent).not.toHaveBeenCalled();
    view.update({ text: TRUST });
    await waitFor(() => expect(screen.getByRole("button", { name: "Answer the dialog" })).toBeInTheDocument());
    expect(view.onReady).not.toHaveBeenCalled();
    expect(screen.getByText(/trust this folder/i)).toBeInTheDocument();
    expect(box).toHaveValue("draft survives startup");
    expect(screen.queryByRole("button", { name: /^Send$/ })).toBeNull();
    // Retiring navigation state cannot lose the in-progress initial dialog.
    view.update({ agent: known, bootstrap: false });
    expect(screen.getByRole("button", { name: "Answer the dialog" })).toBeInTheDocument();
    // After Trust the CLI can redraw before its composer exists. That gap is still startup.
    view.update({ text: "", agent: known });
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(box).toHaveValue("draft survives startup");
    expect(view.onReady).not.toHaveBeenCalled();
    view.update({ text: READY, agent: { ...known, surface: FREE } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled());
    expect(box).toHaveValue("draft survives startup");
    expect(view.onReady).toHaveBeenCalledOnce();
    view.update({ agentLaunch: undefined });
    expect(sent).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await waitFor(() => expect(sent).toHaveBeenCalledExactlyOnceWith("draft survives startup"));
  });

  it("recognizes trust without a draft and binds its guarded tap to the launch adapter", async () => {
    mount({ text: TRUST, agent: { ...shell, surface: undefined, sendProtocol: undefined }, bootstrap: true });
    expect(screen.getByRole("button", { name: "Answer the dialog" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Send$/ })).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: /trust.*continue/i }));
    expect(submitPromptOption).toHaveBeenCalledWith(expect.objectContaining({ paneId, agent: "kiro", detectedRevision: 0 }));
  });

  it("snapshot appearance does not retire the startup latch or require nonzero revision", async () => {
    const user = userEvent.setup();
    const view = mount({ agent: { ...shell, surface: undefined, sendProtocol: undefined }, bootstrap: true });
    await user.type(screen.getByRole("textbox"), "kept");
    view.update({ agent: known, bootstrap: false });
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    view.update({ text: READY, agent: { ...known, surface: FREE }, revision: 0 });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled());
    expect(screen.getByRole("textbox")).toHaveValue("kept");
  });

  it("does not release on a saved or failed read, and does not unlock real send-off metadata", () => {
    const view = mount({ text: READY, stale: true });
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reconnect to send/i })).toBeDisabled();
    view.update({ stale: false, text: "$ kiro", agent: { ...known, sendProtocol: undefined } });
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByText("Starting…").closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("button", { name: "Keys" })).not.toBeDisabled();
  });

  it("an initial unknown screen locks only a known launch; a later unknown retains manual Type here", async () => {
    const user = userEvent.setup();
    const view = mount();
    await user.type(screen.getByRole("textbox"), "manual draft");
    expect(screen.getByText("Starting…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Send$/ })).toBeDisabled();
    view.update({ text: READY, agent: { ...known, surface: FREE } });
    await waitFor(() => expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled());
    view.update({ text: "unknown screen", agentLaunch: undefined, agent: known });
    expect(screen.getByText("Starting…").closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "closed");
    expect(screen.getByRole("button", { name: /^Send$/ })).not.toBeDisabled();
    const sent = vi.fn();
    server.use(...sendHandler((request) => { sent(request.mode); return sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit"], rowsHash: "abc", surface: UNREAD_SURFACE }); }));
    await user.click(screen.getByRole("button", { name: /^Send$/ }));
    await screen.findByRole("button", { name: "Type here" });
    expect(sent).toHaveBeenCalledExactlyOnceWith("send");
  });

  it.each([known, shell])("direct unknown and shell opens leave Send unchanged ($kind)", async (agent) => {
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
