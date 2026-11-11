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
// the Morph view shows (`morphHead`, `morphHint`), every text goes as `<head> <text> <hint>` on one line, a
// tap on a Morph button included; a slash command carries none, and a refused send shows the composer's
// own notice. The view is told the plain text when the send starts (`onMorphRequest`), and how it ended.

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
}

function bridge(outcome: "sent" | "refused" = "sent") {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose fields Posted names.
      sends.push((await request.json()) as Posted);
      const receipt = outcome === "sent" ? { outcome: "sent", keys: [] } : { outcome: "refused", keys: [], reason: "dialog" };
      return HttpResponse.json({ receipt, offers: [] });
    }),
  );
  return sends;
}

const VIEW = parseMorphView([{ kind: "bar", kids: [{ kind: "button", attrs: { label: "Ship", intent: "ship", value: "Ship it now" } }] }]).view;

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
    morphHint: HINT,
    morphHead: HEAD,
    ...overrides,
  };
  const element = (
    <>
      <MorphView
        session="local/w1:p1"
        view={{ rev: 1, at: "2026-11-10T10:00:00.000Z", view: VIEW }}
        working={false}
        entries={[]}
        canAct
        onSend={(line) => ref.current?.sendLine(line) ?? Promise.resolve(false)}
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
  it("a tap on a Morph button posts its words with the head and the hint, as one Send Protocol request", async () => {
    const sends = bridge();
    renderScreen();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    });
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: `${HEAD} tapped "Ship": Ship it now ${HINT}`, mode: "send" });
    expect(sends[0]!.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("a typed send carries the hint while the Morph view shows", async () => {
    const user = userEvent.setup();
    const sends = bridge();
    renderScreen();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "show the plan");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]!.text).toBe(`${HEAD} show the plan ${HINT}`);
  });

  it("an older bridge served no head: the text goes with the hint behind it, exactly as served", async () => {
    const sends = bridge();
    const ref = renderScreen({ morphHead: undefined });
    await act(async () => {
      await ref.current?.sendLine("show the plan");
    });
    expect(sends[0]!.text).toBe(`show the plan ${HINT}`);
  });

  it("a session that holds the rules: the bridge served no tail, so the text goes with the head alone", async () => {
    const sends = bridge();
    const notes: MorphRequestNote[] = [];
    const head = "[morph local/w1:p1#ab12] from operator:";
    const ref = renderScreen({ morphHint: undefined, morphHead: head, onMorphRequest: (note) => notes.push(note) });
    await act(async () => {
      await ref.current?.sendLine("show the plan");
    });
    expect(sends[0]!.text).toBe(`${head} show the plan`);
    expect(notes.map((note) => note.text)).toEqual(["show the plan", "show the plan"]);
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

  it("tells the view nothing for a send that carries no hint, and for a send with no Morph view", async () => {
    bridge();
    const notes: MorphRequestNote[] = [];
    const ref = renderScreen({ onMorphRequest: (note) => notes.push(note) });
    await act(async () => {
      await ref.current?.sendLine("/compact");
    });
    expect(notes).toEqual([]);
    cleanup();
    const plain = renderScreen({ morphHint: undefined, morphHead: undefined, onMorphRequest: (note) => notes.push(note) });
    await act(async () => {
      await plain.current?.sendLine("hello");
    });
    expect(notes).toEqual([]);
  });

  it("a slash command carries no hint", async () => {
    const sends = bridge();
    const ref = renderScreen();
    await act(async () => {
      await ref.current?.sendLine("/compact");
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ text: "/compact", mode: "command" });
  });

  it("without the Morph view, a send is exactly as before", async () => {
    const sends = bridge();
    const ref = renderScreen({ morphHint: undefined, morphHead: undefined });
    await act(async () => {
      await ref.current?.sendLine("hello");
    });
    expect(sends[0]!.text).toBe("hello");
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
});
