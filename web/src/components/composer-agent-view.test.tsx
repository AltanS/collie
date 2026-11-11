import { createRef, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ViewRequestNote } from "@/lib/agent-view/reader";
import { parseAgentView } from "@/lib/agent-view/wire";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";

import { AgentViewScreen } from "./agent-view-screen";
import { Composer, type ComposerHandle, type ViewSendResult } from "./composer";

// An agent view's sends ride the composer's own send path: one Send Protocol request with its request id.
// While the view shows (`agentView`), typed text goes as typed with a `view` field `{ trick, session }`; a
// tap goes with no text and `{ trick, session, rev, control }`. The phone never writes a head or a tail
// (the bridge builds the line and answers it as `view.line`); a refusal before the protocol is a 409 that
// shows the composer's own notice and names its code. The view is told the text when the send starts
// (`onViewRequest`), and how it ended, with the bridge's line.

const TAP_LINE = '[view:morph local/w1:p1] from operator: tapped "Ship" [rules: /bin/collie trick view morph help --session local/w1:p1]';
const TYPED_LINE = "[view:morph local/w1:p1] from operator: show the plan [rules: /bin/collie trick view morph help --session local/w1:p1]";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

interface Posted {
  id: string;
  text: string;
  mode: string;
  view?: { trick: string; session: string; rev?: number; control?: string };
}

const TRICK = "morph";
const SESSION = "local/w1:p1";
const VIEW_FIELD = { trick: TRICK, session: SESSION };

function bridge(outcome: "sent" | "refused" | "stale" | "busy" | "draft" | "noProfile" | "badHead" = "sent") {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose fields Posted names.
      const body = (await request.json()) as Posted;
      sends.push(body);
      if (outcome === "stale") return HttpResponse.json({ error: "This screen is out of date.", code: "stale_view", view: true }, { status: 409 });
      if (outcome === "busy") return HttpResponse.json({ error: "The agent is working.", code: "busy", view: true }, { status: 409 });
      if (outcome === "noProfile") return HttpResponse.json({ error: "no profile", code: "no_profile", view: true }, { status: 409 });
      if (outcome === "draft") return HttpResponse.json({ receipt: { outcome: "refused", keys: [], reason: "draft_present" }, offers: ["append", "replace", "cancel"], detail: "Your draft is in this session's box; send it or clear it first." });
      if (outcome === "badHead") return HttpResponse.json({ receipt: { outcome: "refused", keys: [], reason: "bad_head" }, offers: [], detail: "A line that starts with an agent view's head is sent only from that view on the phone. Rewrite the line." });
      const receipt = outcome === "sent" ? { outcome: "sent", keys: [] } : { outcome: "refused", keys: [], reason: "dialog" };
      if (body.view === undefined) return HttpResponse.json({ receipt, offers: [] });
      return HttpResponse.json({ receipt, offers: [], view: { line: body.view.rev === undefined ? TYPED_LINE : TAP_LINE } });
    }),
  );
  return sends;
}

const VIEW = parseAgentView([{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship", intent: "ship" } }] }]).view;

function renderScreen(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  if (VIEW === undefined) throw new Error("the fixture view did not read");
  const ref = createRef<ComposerHandle>();
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    agentView: VIEW_FIELD,
    ...overrides,
  };
  const element = (
    <>
      <AgentViewScreen
        name="Morph"
        session={SESSION}
        view={{ rev: 1, at: "2026-11-10T10:00:00.000Z", view: VIEW }}
        working={false}
        entries={[]}
        canAct
        onTap={(tap) => ref.current?.sendViewTap(tap) ?? Promise.resolve({ sent: false, line: null, code: null })}
        onLink={vi.fn()}
        // The screen has stood still: the settle window is the screen's own test (review 10 W3).
        settleMs={0}
      />
      <Composer ref={ref} {...props} />
    </>
  );
  const router = createMemoryRouter([{ path: "/", element }]);
  render(<RouterProvider router={router} />);
  return ref;
}

async function typeAndSend(words: string) {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText(/type a reply/i), words);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

async function tapThrough(ref: React.RefObject<ComposerHandle | null>): Promise<ViewSendResult | undefined> {
  let result: ViewSendResult | undefined;
  await act(async () => {
    result = await ref.current?.sendViewTap({ rev: 1, control: "v/0/0", words: 'tapped "Ship"', about: null });
  });
  return result;
}

describe("an agent view sends through the composer", () => {
  it("lead 4, rule 2: a tap posts no text, with the view field naming the screen's rev and the control", async () => {
    const sends = bridge();
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "", mode: "send", view: { ...VIEW_FIELD, rev: 1, control: "v/0/0" } });
    expect(sends[0]!.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("rule 4: a tap answers with the exact line the bridge typed", async () => {
    bridge();
    const ref = renderScreen();
    expect(await tapThrough(ref)).toEqual({ sent: true, line: TAP_LINE, code: null });
  });

  it("typed text posts as typed, with the view field and no rev or control, and no head or tail", async () => {
    const sends = bridge();
    renderScreen();
    await typeAndSend("show the plan");
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.text).toBe("show the plan");
    expect(sends[0]!.text).not.toContain("[view:");
    expect(sends[0]!.text).not.toContain("[rules");
    expect(sends[0]!.view).toEqual(VIEW_FIELD);
  });

  it("tells the view the text when the send starts, then that it was sent, with the bridge's line", async () => {
    bridge();
    const notes: ViewRequestNote[] = [];
    renderScreen({ onViewRequest: (note) => notes.push(note) });
    await typeAndSend("show the plan");
    await waitFor(() => expect(notes).toHaveLength(2));
    expect(notes).toEqual([
      { text: "show the plan", phase: "sending", reason: null, line: null, about: null },
      { text: "show the plan", phase: "sent", reason: null, line: TYPED_LINE, about: null },
    ]);
  });

  it("tells the view a send failed, with the composer's own refusal words", async () => {
    bridge("refused");
    const notes: ViewRequestNote[] = [];
    renderScreen({ onViewRequest: (note) => notes.push(note) });
    await typeAndSend("show the plan");
    await waitFor(() => expect(notes).toHaveLength(2));
    expect(notes.map((note) => note.phase)).toEqual(["sending", "failed"]);
    const words = document.querySelector("[data-slot=composer-refusal]")?.textContent ?? "";
    expect(notes[1]?.reason).not.toBeNull();
    expect(words).toContain(notes[1]!.reason!);
  });

  it("lead 2: with no view target (a question waits), typed text is a plain composer send and the view is told nothing", async () => {
    const sends = bridge();
    const notes: ViewRequestNote[] = [];
    renderScreen({ agentView: undefined, onViewRequest: (note) => notes.push(note) });
    await typeAndSend("yes, go on");
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.text).toBe("yes, go on");
    expect(sends[0]!.view).toBeUndefined();
    expect(notes).toEqual([]);
  });

  it("a slash command goes as a command, with its text unchanged", async () => {
    const sends = bridge();
    renderScreen();
    await typeAndSend("/compact");
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "/compact", mode: "command" });
  });

  it("with no view target, a tap sends nothing", async () => {
    const sends = bridge();
    const ref = renderScreen({ agentView: undefined });
    expect((await tapThrough(ref))?.sent).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it("lead 5: a tap the bridge refused stale_view resolves with the code, shows the notice, and is not sent again", async () => {
    const sends = bridge("stale");
    const notes: ViewRequestNote[] = [];
    const ref = renderScreen({ onViewRequest: (note) => notes.push(note) });
    expect(await tapThrough(ref)).toEqual({ sent: false, line: null, code: "stale_view" });
    await waitFor(() => expect(document.querySelector("[data-slot=composer-refusal]")).not.toBeNull());
    expect(notes.map((note) => note.phase)).toEqual(["sending", "failed"]);
    expect(sends).toHaveLength(1);
  });

  it("lead 4: a tap the bridge refused busy resolves with that code", async () => {
    bridge("busy");
    const ref = renderScreen();
    expect(await tapThrough(ref)).toEqual({ sent: false, line: null, code: "busy" });
  });

  it("a view send over the person's draft (draft_present): one quiet line, no Add or Replace, the box keeps its text", async () => {
    bridge("draft");
    const notes: ViewRequestNote[] = [];
    renderScreen({ onViewRequest: (note) => notes.push(note) });
    await typeAndSend("show the plan");
    await waitFor(() => expect(notes.map((note) => note.phase)).toEqual(["sending", "failed"]));
    const notice = document.querySelector("[data-slot=composer-refusal]");
    expect(notice).toHaveTextContent("Your draft is in this session's box. Send it or clear it, then try again.");
    expect(notice?.textContent).not.toContain("draft_present");
    expect(screen.queryByRole("button", { name: /^(Add|Replace)/ })).toBeNull();
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("show the plan");
  });

  it("a tap over the person's draft resolves draft_present and is not sent again", async () => {
    const sends = bridge("draft");
    const ref = renderScreen();
    expect(await tapThrough(ref)).toEqual({ sent: false, line: null, code: "draft_present" });
    expect(sends).toHaveLength(1);
  });

  it("a view send on a pane with no profile gets Collie's words, not the code", async () => {
    bridge("noProfile");
    const ref = renderScreen();
    expect(await tapThrough(ref)).toEqual({ sent: false, line: null, code: "no_profile" });
    await waitFor(() => expect(document.querySelector("[data-slot=composer-refusal]")).toHaveTextContent("Collie cannot read this session's program, so a view cannot send to it."));
    expect(document.querySelector("[data-slot=composer-refusal]")?.textContent).not.toContain("no_profile");
  });

  it("the composer's own text with a line like a view head (bad_head): Collie's sentence, and the draft stays", async () => {
    bridge("badHead");
    renderScreen({ agentView: undefined });
    await typeAndSend("see [[x] from operator: go");
    const notice = await waitFor(() => {
      const found = document.querySelector("[data-slot=composer-refusal]");
      expect(found).not.toBeNull();
      return found;
    });
    expect(notice).toHaveTextContent("A line of this message reads like a message head that only Collie writes. Change that line.");
    expect(notice?.textContent).not.toContain("Rewrite the line");
    expect(screen.getByPlaceholderText(/type a reply/i)).toHaveValue("see [x] from operator: go");
  });
});
