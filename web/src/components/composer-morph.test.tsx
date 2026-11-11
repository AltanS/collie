import { createRef, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import type { MorphRequestNote } from "@/lib/morph/reader";
import { parseMorphView } from "@/lib/morph/wire";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";

import { Composer, type ComposerHandle } from "./composer";
import { MorphView } from "./morph-view";

// Morph's sends ride the composer's own send path: one Send Protocol request with its request id. While
// the agent view shows (`morphView`), the text goes as typed, with a `view` field: `{ trick, session }` for
// typed text, plus `rev` and `control` for a tap. The phone never writes a head or a hint into the text
// (the bridge builds the line); a refusal before the protocol is a 409 that shows the composer's own
// notice. The view is told the plain text when the send starts (`onMorphRequest`), and how it ended.

const HEAD = "[morph] from operator:";
const HINT = "[rules: /bin/collie morph help --session local/w1:p1#ab12]";

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

function bridge(outcome: "sent" | "refused" | "view" = "sent") {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose fields Posted names.
      sends.push((await request.json()) as Posted);
      if (outcome === "view") return HttpResponse.json({ error: "This screen is out of date.", code: "stale_view", view: true }, { status: 409 });
      const receipt = outcome === "sent" ? { outcome: "sent", keys: [] } : { outcome: "refused", keys: [], reason: "dialog" };
      return HttpResponse.json({ receipt, offers: [] });
    }),
  );
  return sends;
}

const VIEW = parseMorphView([{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship", intent: "ship" } }] }]).view;

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
    morphView: VIEW_FIELD,
    ...overrides,
  };
  const element = (
    <>
      <MorphView
        session={SESSION}
        view={{ rev: 1, at: "2026-11-10T10:00:00.000Z", view: VIEW }}
        working={false}
        entries={[]}
        canAct
        onSend={(line, tap) => ref.current?.sendLine(line, tap) ?? Promise.resolve(false)}
        onLink={vi.fn()}
      />
      <Composer ref={ref} {...props} />
    </>
  );
  const router = createMemoryRouter([{ path: "/", element }]);
  render(<RouterProvider router={router} />);
  return ref;
}

describe("Morph sends through the composer", () => {
  it("a tap on a Morph button posts its words plain, with the view field naming the screen's rev and the control", async () => {
    const sends = bridge();
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: 'tapped "Ship"', mode: "send", view: { ...VIEW_FIELD, rev: 1, control: "v/0/0" } });
    expect(sends[0]!.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("typed text posts as typed, with the view field and no rev or control", async () => {
    const user = userEvent.setup();
    const sends = bridge();
    renderScreen();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "show the plan");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.text).toBe("show the plan");
    expect(sends[0]!.view).toEqual(VIEW_FIELD);
  });

  it("the text carries no head and no hint, even when the props still hold the bridge's old ones", async () => {
    const sends = bridge();
    const ref = renderScreen({ morphHead: HEAD, morphHint: HINT });
    await act(async () => {
      await ref.current?.sendLine("show the plan");
    });
    expect(sends[0]!.text).toBe("show the plan");
    expect(sends[0]!.text).not.toContain("[morph");
    expect(sends[0]!.text).not.toContain("[rules");
    expect(sends[0]!.view).toEqual(VIEW_FIELD);
  });

  it("tells the view the plain text when the send starts, then that it was sent", async () => {
    bridge();
    const notes: MorphRequestNote[] = [];
    const ref = renderScreen({ onMorphRequest: (note) => notes.push(note) });
    await act(async () => {
      await ref.current?.sendLine("show the plan");
    });
    expect(notes).toEqual([
      { text: "show the plan", phase: "sending", reason: null },
      { text: "show the plan", phase: "sent", reason: null },
    ]);
  });

  it("tells the view a send failed, with the composer's own refusal words", async () => {
    bridge("refused");
    const notes: MorphRequestNote[] = [];
    const ref = renderScreen({ onMorphRequest: (note) => notes.push(note) });
    await act(async () => {
      await ref.current?.sendLine("show the plan");
    });
    expect(notes.map((note) => note.phase)).toEqual(["sending", "failed"]);
    const words = document.querySelector("[data-slot=composer-refusal]")?.textContent ?? "";
    expect(notes[1]?.reason).not.toBeNull();
    expect(words).toContain(notes[1]!.reason!);
  });

  it("tells the view nothing for a send with no agent view", async () => {
    bridge();
    const notes: MorphRequestNote[] = [];
    const plain = renderScreen({ morphView: undefined, onMorphRequest: (note) => notes.push(note) });
    await act(async () => {
      await plain.current?.sendLine("hello");
    });
    expect(notes).toEqual([]);
  });

  it("a slash command goes as a command, with its text unchanged", async () => {
    const sends = bridge();
    const ref = renderScreen();
    await act(async () => {
      await ref.current?.sendLine("/compact");
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ text: "/compact", mode: "command" });
  });

  it("without the agent view, a send is exactly as before: no view field", async () => {
    const sends = bridge();
    const ref = renderScreen({ morphView: undefined });
    await act(async () => {
      await ref.current?.sendLine("hello");
    });
    expect(sends[0]!.text).toBe("hello");
    expect(sends[0]!.view).toBeUndefined();
  });

  it("a refused tap shows the composer's refusal notice and resolves false", async () => {
    bridge("refused");
    const ref = renderScreen();
    let sent: boolean | undefined;
    await act(async () => {
      sent = await ref.current?.sendLine("Ship it now");
    });
    expect(sent).toBe(false);
    await waitFor(() => expect(document.querySelector("[data-slot=composer-refusal]")).not.toBeNull());
  });

  it("a send the bridge refused before the protocol (409, view) shows the refusal notice, tells the view it failed, and resolves false", async () => {
    bridge("view");
    const notes: MorphRequestNote[] = [];
    const ref = renderScreen({ onMorphRequest: (note) => notes.push(note) });
    let sent: boolean | undefined;
    await act(async () => {
      sent = await ref.current?.sendLine('tapped "Ship"', { rev: 1, control: "v/0/0" });
    });
    expect(sent).toBe(false);
    await waitFor(() => expect(document.querySelector("[data-slot=composer-refusal]")).not.toBeNull());
    expect(notes.map((note) => note.phase)).toEqual(["sending", "failed"]);
  });
});
