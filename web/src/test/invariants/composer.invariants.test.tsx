// M102 spec 15, part 1a on the phone, the rendered half: the REAL Composer mounted on generated
// Surfaces. The pure suite (send-slot.invariants.test.ts) covers the whole product; this one proves the
// rendered controls keep what the slot promises, on a seeded sample plus named cases.
//
//   I1  online and writable: the Keys button is enabled and its pad sends; offline: words say why.
//   I4  a person who sees a screen Collie cannot read gets, after the bridge's first answer, a button
//       that sends the override (`override: true` with the rows hash). The fake bridge answers the first
//       tap the way today's bridge does: `unconfirmed` with the hash where the manual Send is open, else
//       `not_free` WITH the hash (spec 12's wire carries it on a refusal).

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { Composer } from "@/components/composer";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { takesManualSend } from "@/lib/surface/send";
import type { Surface } from "@/lib/surface/surface";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";

import { replayHint, rngOf, runSeeds, sample } from "./seed";
import { allSurfaces, overrideReaches, surfaceId } from "./surfaces";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
});
afterEach(() => cleanup());

const PANE = "inv:p1";
const HASH = "0f00ba";
const PREFS = { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false } as const;

function mount(surface: Surface, offline = false) {
  if (!offline) markLive(PANE, Date.now() - 500);
  const props: ComponentProps<typeof Composer> = {
    paneId: PANE,
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface,
    stale: offline,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: PREFS,
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    screen: { on: false, onToggle: vi.fn() },
  };
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Composer {...props} /> }])} />);
}

/** The fake bridge of today: the manual Send's `unconfirmed` where it is open, else `not_free` with the hash. */
function todaysBridge(surface: Surface) {
  server.use(
    ...sendHandler((request) => {
      if (request.rowsHash !== undefined) return sendAnswer(request.id, "typed_not_submitted", "mismatch", { offers: ["keys"] });
      if (takesManualSend(surface)) return sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: HASH, surface, detail: "Check the pane, then tap Send anyway." });
      return sendAnswer(request.id, "refused", "not_free", { offers: ["keys"], rowsHash: HASH, surface, detail: "The input box is not free." });
    }),
  );
}

const OVERRIDE_BUTTON = /^(send anyway|send past this screen|send it now)$/i;

/** The person's road to the override from a fresh mount: type, Send, then the override button. Null when it got through. */
async function overrideRoad(surface: Surface): Promise<string | null> {
  todaysBridge(surface);
  mount(surface);
  const user = userEvent.setup();
  const box = screen.getByRole("textbox");
  await user.type(box, "carry on please");
  const send = screen.queryByRole("button", { name: "Send" });
  if (send === null) return "no Send button";
  await user.click(send);
  try {
    await waitFor(() => expect(recordedSends().length).toBeGreaterThan(0), { timeout: 1500 });
  } catch {
    return "the Send tap made no request";
  }
  let button: HTMLElement;
  try {
    button = await screen.findByRole("button", { name: OVERRIDE_BUTTON }, { timeout: 1500 });
  } catch {
    return "no button sends the override after the first answer";
  }
  await user.click(button);
  try {
    await waitFor(() => expect(recordedSends().some((r) => r.override === true && r.rowsHash === HASH)).toBe(true), { timeout: 1500 });
  } catch {
    return "the override button sent no override with the rows hash";
  }
  return null;
}

const SEEDS = runSeeds();
const SAMPLED = SEEDS.flatMap((seed) => sample(allSurfaces(), 3, rngOf(seed)).map((c) => ({ seed, c })));

describe("M102-15 part 1a, the rendered composer", () => {
  for (const { seed, c } of SAMPLED) {
    it(`I1: the Keys pad sends on ${c.id} (${replayHint(seed, c.id)})`, async () => {
      mount(c.surface);
      const user = userEvent.setup();
      const keys = screen.getByRole("button", { name: "Keys" });
      expect(keys).toBeEnabled();
      await user.click(keys);
      expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    });
  }

  it("I1: offline, the pad waits and words on the composer say why", async () => {
    mount({ revision: 1, turn: "idle", modal: "none", composer: "empty" }, true);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeDisabled();
    // The reason rides on the send button, as its name and title.
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toHaveAttribute("title", "Reconnect to send");
  });

  const reachToday: readonly Surface[] = [
    { revision: 3, turn: "idle", modal: "unreadable", composer: "unknown" },
    { revision: 3, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" },
  ];
  for (const surface of reachToday) {
    it(`I4: the override goes out from the phone on ${surfaceId(surface)}`, async () => {
      expect(await overrideRoad(surface)).toBeNull();
    });
  }

  const reachNot: readonly Surface[] = [
    { revision: 3, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" },
    { revision: 3, turn: "unknown", modal: "unknown", composer: "unknown", reason: "torn" },
    { revision: 3, turn: "unknown", modal: "unknown", composer: "unknown", reason: "contested" },
    { revision: 3, turn: "unknown", modal: "none", composer: "unknown" },
    { revision: 3, turn: "idle", modal: "none", composer: "unreachable" },
  ];
  for (const surface of reachNot) {
    if (!overrideReaches(surface)) throw new Error(`${surfaceId(surface)} is outside I4`);
    it(`I4: the override goes out from the phone on ${surfaceId(surface)}`, async () => {
      expect(await overrideRoad(surface)).toBeNull();
    });
  }
});
