import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneBody } from "@/lib/chat-gate";
import { fixtureAgents, paneTextWithDraft } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// THE ZOOM PILL BY VIEW (1.26.2). The pill zooms the terminal screen, so the belt carries it only while
// the pane view shows the Screen, never in Chat. The body the Chat gate chose decides which view that is
// (`paneBody`, lib/chat-gate.ts); here the gate is held to the body each case names, and the rest of the
// pane is the ordinary fixture. The device setting (`zoomPill` in the dash prefs) and the theme's `zoom`
// word can turn the pill off; a device choice wins over the theme.

interface Gate {
  body: PaneBody;
}
interface ThemeWord {
  zoom: "screen" | "none" | undefined;
}
const gate = vi.hoisted((): Gate => ({ body: "terminal" }));
vi.mock("@/lib/chat-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-gate")>()),
  paneBody: (): PaneBody => gate.body,
}));

const theme = vi.hoisted((): ThemeWord => ({ zoom: undefined }));
vi.mock("@/lib/theme/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/theme/store")>();
  return {
    ...original,
    useActiveTheme: () => ({
      ...original.useActiveTheme(),
      theme: { ...original.useActiveTheme().theme, surface: theme.zoom === undefined ? undefined : { zoom: theme.zoom } },
    }),
  };
});

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

beforeEach(() => {
  gate.body = "terminal";
  theme.zoom = undefined;
});
afterEach(() => localStorage.clear());

function mount() {
  const agent = fixtureAgents[0]!;
  const element = withHeaderHost(
    <AgentChat
      paneId={agent.paneId}
      agent={agent}
      agents={fixtureAgents}
      shellPanes={[]}
      tabs={[]}
      text={paneTextWithDraft("recent pane output")}
      onBack={vi.fn()}
      onSelect={vi.fn()}
      zoom={{ open: false, onOpen: vi.fn(), onClose: vi.fn() }}
    />,
  );
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element }])} />);
}

const pill = () => screen.queryByRole("button", { name: "Zoom output" });
const choose = (zoomPill: "screen" | "off") =>
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ zoomPill }));

describe("AgentChat, the Zoom pill by view", () => {
  it("is on the belt in the Screen view", () => {
    mount();
    expect(pill()).toBeInTheDocument();
  });

  it.each(["chat", "start"] as const)("is not on the belt in the Chat view (%s)", (body) => {
    gate.body = body;
    mount();
    expect(pill()).toBeNull();
  });

  it("is not on the belt in the Screen view when the setting is Off", () => {
    choose("off");
    mount();
    expect(pill()).toBeNull();
  });

  it("is not on the belt when the theme says zoom none and the device has not chosen", () => {
    theme.zoom = "none";
    mount();
    expect(pill()).toBeNull();
  });

  it("is on the belt when the theme says zoom screen", () => {
    theme.zoom = "screen";
    mount();
    expect(pill()).toBeInTheDocument();
  });

  it("follows the device choice over the theme, both ways", () => {
    theme.zoom = "none";
    choose("screen");
    mount();
    expect(pill()).toBeInTheDocument();
  });

  it("follows an Off device choice over a theme that says screen", () => {
    theme.zoom = "screen";
    choose("off");
    mount();
    expect(pill()).toBeNull();
  });

  it("stays out of the Chat view whatever the device chose", () => {
    gate.body = "chat";
    choose("screen");
    mount();
    expect(pill()).toBeNull();
  });
});
