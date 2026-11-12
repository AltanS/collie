import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAgentViewPane } from "@/hooks/use-agent-view-pane";
import type { JsonObject } from "@/lib/json";
import { __resetAgentViews } from "@/lib/agent-view/store";
import type { MenuRow, TrickTapReply, TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { tricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { paneAddress } from "@/lib/walky";
import { server } from "@/test/setup";
import { PaneActionsSheet } from "./pane-actions-sheet";

// A SWITCH IN THE SESSION SHEET SETTLES TO THE BRIDGE'S ANSWER. The real sheet (PaneActionsSheet) hosted
// as the app hosts it (the agent view hook feeding `agentViews`, the tricks store as the groups' source),
// over MSW at the network seam. The rows freeze at the open for labels, order and presence, never for a
// switch's state after the person's own tap.

// The phone's clock when the file loads: a part drawn "as of" 10 s before it is inside its 10 minute window.
const NOW = Date.now();
const PANE: AgentView = { paneId: "w6X:3", workspaceId: "w6X", workspaceLabel: "collie", workspaceNumber: 1, tabId: "w6X:t1", agent: "claude", status: "idle", cwd: "/work", focused: false, kind: "agent", instance: "ab12" };
const ADDRESS = paneAddress(PANE.paneId, undefined, undefined, PANE.instance);
const WATCH: MenuRow = { id: "watch", kind: "switch", label: "Watch branch", icon: "flag", intent: "watch", on: true };

function trickInfo(id: string, over: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "lodge", id, name: id.toUpperCase(), icon: "flask", on: true, state: "ok", places: [], ...over };
}
function menuPart(trick: string, rows: MenuRow[], rev: number): WireTrickPart {
  return { host: "lodge", trick, part: trick, rev, asOf: new Date(NOW - 10_000).toISOString(), fresh: "10m", value: { at: "menu", id: trick, rows } };
}

interface Posted {
  readonly body: JsonObject;
  readonly answer: (reply: JsonObject | TrickTapReply) => void;
}

/** The bridge: its views and tricks are the test's, and every write waits for the test to answer it. */
function bridge(opts: { views: JsonObject[]; tricks: WireTrickInfo[]; parts: WireTrickPart[]; rev: number }) {
  const switches: Posted[] = [];
  const taps: Posted[] = [];
  const state = { views: opts.views };
  const doc = { rev: opts.rev, parts: opts.parts };
  const wait = (into: Posted[], request: Request): Promise<Response> =>
    request.json().then(
      (body) =>
        new Promise<Response>((resolve) => {
          into.push({ body, answer: (reply) => resolve(HttpResponse.json(reply)) });
        }),
    );
  const reply = (): TricksReply => ({ rev: doc.rev, tricks: opts.tricks, parts: doc.parts, present: doc.parts.map((p) => `${p.host}/${p.trick}/${p.part}`) });
  server.use(
    http.get("/api/tricks", () => HttpResponse.json({ ...reply() })),
    http.get("/api/trick-views", () => HttpResponse.json({ rev: 1, views: state.views })),
    http.post("/api/trick-views/switch", ({ request }) => wait(switches, request)),
    http.post("/api/tricks/:host/:trick/tap", ({ request }) => wait(taps, request)),
  );
  return { switches, taps, state, doc };
}

/** What the app's session screen does with the sheet: the hook's rows and write go into `agentViews`. */
function Host({ open }: { open: boolean }) {
  const agentView = useAgentViewPane({ address: ADDRESS, eligible: true, onChanged: () => undefined });
  return (
    <>
      <span data-testid="available">{String(agentView.available)}</span>
      <PaneActionsSheet
        open={open}
        onClose={() => undefined}
        pane={PANE}
        onRenamed={() => undefined}
        onClosed={() => undefined}
        agentViews={agentView.available ? { rows: agentView.rows, label: agentView.label, on: agentView.on, showing: agentView.showing, onShow: () => agentView.setAside(null), onSwitch: agentView.setOn } : undefined}
      />
    </>
  );
}

/** Open the sheet once the bridge's lists are held, as a person does: the groups freeze at that open. */
async function openSheet(rev: number, offersView = true) {
  const view = render(<Host open={false} />);
  await act(async () => {
    await tricksStore.syncTricks(rev);
  });
  await waitFor(() => expect(screen.getByTestId("available").textContent).toBe(String(offersView)));
  view.rerender(<Host open />);
  return view;
}

/** The switch of the Morph view row, or of one trick menu row. */
const morphSwitch = () => screen.getByRole("switch", { name: "Morph" });
const watchSwitch = () => screen.getByRole("switch", { name: "Watch branch" });
const checked = (el: HTMLElement) => el.getAttribute("aria-checked");

beforeEach(() => {
  __resetAgentViews();
  // Only the clock: the settle window reads Date.now() at the tap.
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a switch in the session sheet settles to the bridge's answer", () => {
  it("the Morph view switch shows on after the answer, and the next tap asks for off", async () => {
    const session = { trick: "morph", session: ADDRESS };
    const { switches } = bridge({ views: [{ ...session, on: false }], tricks: [trickInfo("morph", { agentView: true, name: "Morph" })], parts: [], rev: 11 });
    await openSheet(11);
    expect(checked(morphSwitch())).toBe("false");
    vi.setSystemTime(NOW + 1_000);

    fireEvent.click(morphSwitch());
    await waitFor(() => expect(switches).toHaveLength(1));
    expect(switches[0]?.body).toEqual({ ...session, on: true });
    await act(async () => switches[0]?.answer({ ...session, on: true }));
    await waitFor(() => expect(morphSwitch()).not.toBeDisabled());
    expect(checked(morphSwitch())).toBe("true");

    vi.setSystemTime(NOW + 3_000);
    fireEvent.click(morphSwitch());
    await waitFor(() => expect(switches).toHaveLength(2));
    expect(switches[1]?.body).toEqual({ ...session, on: false });
    await act(async () => switches[1]?.answer({ ...session, on: false }));
    await waitFor(() => expect(morphSwitch()).not.toBeDisabled());
    expect(checked(morphSwitch())).toBe("false");
  });

  it("a refused Morph tap leaves the old state and says why under the row", async () => {
    const session = { trick: "morph", session: ADDRESS };
    const { switches } = bridge({ views: [{ ...session, on: false }], tricks: [trickInfo("morph", { agentView: true, name: "Morph" })], parts: [], rev: 12 });
    server.use(http.post("/api/trick-views/switch", () => HttpResponse.json({ error: "no", code: "view_trick_off" }, { status: 409 })));
    await openSheet(12);
    vi.setSystemTime(NOW + 1_000);
    fireEvent.click(morphSwitch());
    await waitFor(() => expect(document.querySelector('[data-slot="switch-row-note"]')).not.toBeNull());
    expect(checked(morphSwitch())).toBe("false");
    expect(switches).toHaveLength(0);
  });

  it("a trick's own menu switch shows the answer's state, and the next tap sends the opposite", async () => {
    const { taps } = bridge({ views: [], tricks: [trickInfo("ci")], parts: [menuPart("ci", [WATCH], 1)], rev: 13 });
    await openSheet(13, false);
    expect(checked(watchSwitch())).toBe("true");
    vi.setSystemTime(NOW + 1_000);

    fireEvent.click(watchSwitch());
    await waitFor(() => expect(taps).toHaveLength(1));
    expect(taps[0]?.body).toMatchObject({ node: "ci", intent: "watch", value: "off", rev: 1 });
    // Not flipped while the tap waits.
    expect(checked(watchSwitch())).toBe("true");
    expect(watchSwitch()).toBeDisabled();
    await act(async () => taps[0]?.answer({ rid: String(taps[0]?.body.rid), code: "ok", rev: 14, parts: [menuPart("ci", [{ ...WATCH, on: false }], 2)], present: ["lodge/ci/ci"] }));
    await waitFor(() => expect(watchSwitch()).not.toBeDisabled());
    expect(checked(watchSwitch())).toBe("false");

    vi.setSystemTime(NOW + 3_000);
    fireEvent.click(watchSwitch());
    await waitFor(() => expect(taps).toHaveLength(2));
    expect(taps[1]?.body).toMatchObject({ node: "ci", intent: "watch", value: "on", rev: 2 });
    await act(async () => taps[1]?.answer({ rid: String(taps[1]?.body.rid), code: "ok", rev: 15, parts: [menuPart("ci", [WATCH], 3)], present: ["lodge/ci/ci"] }));
    await waitFor(() => expect(watchSwitch()).not.toBeDisabled());
    expect(checked(watchSwitch())).toBe("true");
  });

  it("a menu switch whose answer carries no parts takes the state of the next document, sheet still open", async () => {
    const { taps, doc } = bridge({ views: [], tricks: [trickInfo("gate")], parts: [menuPart("gate", [WATCH], 1)], rev: 16 });
    await openSheet(16, false);
    vi.setSystemTime(NOW + 1_000);
    fireEvent.click(watchSwitch());
    await waitFor(() => expect(taps).toHaveLength(1));
    await act(async () => taps[0]?.answer({ rid: String(taps[0]?.body.rid), code: "ok" }));
    await waitFor(() => expect(watchSwitch()).not.toBeDisabled());
    expect(checked(watchSwitch())).toBe("true");
    doc.parts = [menuPart("gate", [{ ...WATCH, on: false }], 2)];
    doc.rev = 17;
    await act(async () => {
      await tricksStore.syncTricks(17);
    });
    expect(checked(watchSwitch())).toBe("false");
    vi.setSystemTime(NOW + 3_000);
    fireEvent.click(watchSwitch());
    await waitFor(() => expect(taps).toHaveLength(2));
    expect(taps[1]?.body).toMatchObject({ intent: "watch", value: "on", rev: 2 });
  });
});
