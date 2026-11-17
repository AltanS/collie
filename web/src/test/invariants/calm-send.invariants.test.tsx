// M104 spec 01, the text-safety half of "one move at the tap": a send of the box lets go of the box at the tap and puts
// the person's line in Chat at once (lib/durable-pending.ts). Whatever the bridge answers, the sent text then stands in
// EXACTLY ONE place: the chat (its pending line), the box, or the card beside the notice (Put back). Never none (lost),
// never two (doubled). And a text the person typed while the send was on its way is never overwritten or merged.
//
//   I2  every end of a box send leaves the sent text in one place a person can see.
//
// The answers walk the product's own closed list (`SEND_OUTCOMES`, each with no reason, plus a seeded sample of
// outcome and reason pairs), a lost answer, and a refusal from the phone itself, so an outcome added to the list is
// walked here without a new line.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { Composer } from "@/components/composer";
import { __resetPending, pendingLines } from "@/lib/durable-pending";
import { markLive, resetLiveness } from "@/lib/liveness";
import { forgetAllUnknownSends } from "@/lib/send-again";
import { forgetAllSendIntents } from "@/lib/send-intent";
import { paneScopeKey } from "@/lib/scope";
import { clearStatus } from "@/lib/status";
import { SEND_OUTCOMES, SEND_REASONS } from "@/lib/surface/send";
import type { JsonObject } from "@/lib/json";
import { sendAnswer } from "@/test/handlers";
import { server } from "@/test/setup";

import { replayHint, rngOf, runSeeds, sample } from "./seed";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  __resetPending();
  forgetAllUnknownSends();
  forgetAllSendIntents();
  localStorage.clear();
});
afterEach(() => cleanup());

const PANE = "inv:p1";
const TEXT = "please carry on with the plan";
const NEW_WORDS = "and one more thing";
const PREFS = { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false } as const;

function mount() {
  markLive(PANE, Date.now() - 500);
  const props: ComponentProps<typeof Composer> = {
    paneId: PANE,
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    stale: false,
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

function field(): HTMLTextAreaElement {
  // SAFETY: the composer's field is a textarea.
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

/** One way a box send can end: an answer of the bridge, a lost answer, or the phone's own refusal. */
interface End {
  readonly label: string;
  readonly answer: (id: string) => Response | "network";
}

const ok = (body: JsonObject): Response => HttpResponse.json(body);

function outcomeEnd(outcome: string, reason: string | undefined): End {
  return { label: `${outcome}(${reason ?? "-"})`, answer: (id) => ok(sendAnswer(id, outcome, reason, outcome === "refused" ? { offers: ["keys"] } : {})) };
}

const NAMED: readonly End[] = [
  ...SEND_OUTCOMES.map((outcome) => outcomeEnd(outcome, undefined)),
  { label: "sent, queued behind the turn", answer: (id) => ok(sendAnswer(id, "sent", undefined, { queued: true })) },
  { label: "lost answer (500)", answer: () => HttpResponse.json({ error: "boom" }, { status: 500 }) },
  { label: "lost answer (network)", answer: () => "network" },
  { label: "an older bridge with no receipt", answer: () => ok({ offers: [] }) },
];
const PAIRS: readonly End[] = SEND_OUTCOMES.flatMap((outcome) => SEND_REASONS.map((reason) => outcomeEnd(outcome, reason)));
const SEEDS = runSeeds();
const SAMPLED = SEEDS.flatMap((seed) => sample(PAIRS, 2, rngOf(seed)).map((end) => ({ seed, end })));

/** The fake bridge, held until the test lets it answer. */
function holdBridge(end: End) {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let asked = false;
  server.use(
    http.post("/api/send", async ({ request }) => {
      asked = true;
      // SAFETY: the composer posts a SendRequestBody, which has an id.
      const body = (await request.json()) as { id: string };
      await opened;
      const answer = end.answer(body.id);
      return answer === "network" ? HttpResponse.error() : answer;
    }),
  );
  return { release: open, asked: () => asked };
}

/** Where the sent text stands now: each place a person sees it. */
function placesOf(text: string): string[] {
  const places: string[] = [];
  const lines = pendingLines(paneScopeKey(undefined, PANE)).filter((line) => line.text === text && line.state !== "notSent");
  for (const _ of lines) places.push("chat");
  if (field().value.trim() === text) places.push("box");
  const kept = document.querySelector("[data-slot='composer-held-back']");
  if (kept !== null && (kept.textContent ?? "").includes(text)) places.push("card");
  return places;
}

async function sendEndsWith(end: End, typeMeanwhile: boolean): Promise<string | null> {
  const bridge = holdBridge(end);
  mount();
  const user = userEvent.setup();
  fireEvent.change(field(), { target: { value: TEXT } });
  await user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(bridge.asked()).toBe(true));
  // At the tap: the box is empty and the line stands in Chat, once.
  if (field().value !== "") return `the box still holds ${JSON.stringify(field().value)} after the tap`;
  const atTap = placesOf(TEXT);
  if (atTap.join() !== "chat") return `at the tap the text stands in [${atTap.join(", ")}]`;
  if (typeMeanwhile) fireEvent.change(field(), { target: { value: NEW_WORDS } });
  await act(async () => {
    bridge.release();
  });
  try {
    await waitFor(() => expect(document.querySelector("[data-slot='composer-primary'] .animate-spin")).toBeNull(), { timeout: 2000 });
  } catch {
    return "the send never ended";
  }
  const places = placesOf(TEXT);
  if (places.length !== 1) return `after the end the text stands in [${places.join(", ")}]`;
  if (typeMeanwhile && field().value !== NEW_WORDS) return `the words typed meanwhile became ${JSON.stringify(field().value)}`;
  return null;
}

describe("M104-01: after any end of a box send, the sent text stands in exactly one place", () => {
  for (const end of NAMED) {
    it(`I2: ${end.label}, the box empty at the end`, async () => {
      expect(await sendEndsWith(end, false)).toBeNull();
    });
    it(`I2: ${end.label}, a new text typed meanwhile`, async () => {
      expect(await sendEndsWith(end, true)).toBeNull();
    });
  }
  for (const { seed, end } of SAMPLED) {
    it(`I2: ${end.label}, a new text typed meanwhile (${replayHint(seed, end.label)})`, async () => {
      expect(await sendEndsWith(end, true)).toBeNull();
    });
  }
});
