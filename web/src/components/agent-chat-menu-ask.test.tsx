import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import type { JsonValue } from "@/lib/json";
import { useStatus } from "@/lib/status";
import { askOfLift, liftDialog, readerBlocks } from "@/lib/surface/lift";
import type { Ask } from "@/lib/surface/surface";
import type { AgentView } from "@/lib/types";
import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// This suite never polls first, so it pins the pane live; the gating has its own suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

// A menu card is drawn from the mirror text (the pane poll); the ask it answers rides the Surface
// (the snapshot, filled by the bridge's own poll). After Move down the mirror shows the new highlight
// before the Surface does, and a footer key commits the highlighted row. Found on the /model picker
// on 2026-10-17: the first commit after a move posted the ask of the row before, and the bridge
// refused it `ask_changed` (6 rounds in 8). A commit must go out only under an ask of the card the
// person saw.

const PANE_ID = fixtureAgents[0]!.paneId;
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const screenOf = (name: string): string => readFileSync(join(PANES_DIR, `${name}.txt`), "utf8");
/** The /model picker with `❯` on row 1, and the same picker after the highlight moved to row 3. */
const PICKER = screenOf("claude--menu-model-picker");
const MOVED = screenOf("claude--menu-model-picker-moved");
const TITLE = "Select model";
const SESSION_ONLY = "Use this session only";

/** The ask the bridge mints for a screen: its dialog lifted the way the bridge lifts a read. */
function askFor(text: string, id: string): Ask {
  const dialog = liftDialog(readerBlocks(splitLines(parseAnsi(text)), "claude"));
  if (dialog === null) throw new Error("the fixture lifts no dialog");
  return askOfLift(dialog, id);
}

const ASK_PICKER = askFor(PICKER, "ask-0a0a0a0a0a0a0a");
const ASK_MOVED = askFor(MOVED, "ask-0b0b0b0b0b0b0b");

interface Posted {
  readonly path: string;
  readonly body: JsonValue;
}

interface World {
  /** The screen the pane shows when the chat mounts. */
  readonly start: string;
  /** The ask the Surface carries, for the whole test: the bridge's poll has not read the move yet. */
  readonly held: Ask;
  /** The ask one fresh read of the bridge (`prepare`) answers, from the screen it reads. */
  readonly fresh: (screenNow: string) => Ask | null;
}

/** The header status line, mounted beside the pane so a test can read it. */
function StatusLine() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

/**
 * Mount Chat on a Claude pane that shows `world.start`. A Down key moves the picker to MOVED and the
 * chat is handed the new text, as the route's poll would; the Surface stays on `world.held`.
 */
function mountWorld(world: World) {
  const prepares: Posted[] = [];
  const answers: Posted[] = [];
  const keys: string[][] = [];
  let showing = world.start;
  let revision = 1;
  let push: (text: string, rev: number) => void = () => {
    throw new Error("chat not mounted");
  };

  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: PANE_ID, text: showing, truncated: false, revision })),
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      // SAFETY: `sendKeys` in lib/api.ts is the only caller and posts `{ keys, expected_prompt? }`.
      const body = (await request.json()) as { keys: string[] };
      keys.push(body.keys);
      if (showing === PICKER && body.keys.join("+") === "Down") {
        showing = MOVED;
        revision += 1;
        queueMicrotask(() => act(() => push(MOVED, revision)));
      }
      return HttpResponse.json({ ok: true });
    }),
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the phone's own JSON.stringify body is JSON, a JsonValue.
      prepares.push({ path: "/api/send", body: (await request.json()) as JsonValue });
      const ask = world.fresh(showing);
      const modal = ask === null ? "none" : { ask };
      return HttpResponse.json({ offers: [], surface: { revision: 0, turn: "unknown", modal, composer: "unknown" } });
    }),
    http.post(/\/api\/ask\/[^/]+$/, async ({ request }) => {
      const path = decodeURIComponent(new URL(request.url).pathname);
      // SAFETY: as above.
      answers.push({ path, body: (await request.json()) as JsonValue });
      return HttpResponse.json({ receipt: { askId: path.split("/").at(-1), outcome: "sent", keys: ["s"] } });
    }),
  );

  const agent: AgentView = { ...fixtureAgents[0]!, surface: { revision: 0, turn: "idle", modal: { ask: world.held }, composer: "unknown" } };
  function Harness() {
    const [pane, setPane] = useState({ text: world.start, revision });
    push = (text, rev) => setPane({ text, revision: rev });
    return (
      <>
        <StatusLine />
        <AgentChat
          paneId={PANE_ID}
          agent={agent}
          agents={[agent]}
          shellPanes={[]}
          tabs={[]}
          text={pane.text}
          revision={pane.revision}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      </>
    );
  }
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<Harness />) }]);
  render(<RouterProvider router={router} />);
  return { prepares, answers, keys };
}

async function tap(user: ReturnType<typeof userEvent.setup>, name: string) {
  const button = within(await screen.findByRole("group", { name: TITLE })).getByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

/** The card shows the moved highlight: Move down went out and the mirror drew its result. */
async function moveDown(user: ReturnType<typeof userEvent.setup>, sent: { keys: string[][] }) {
  await tap(user, "Move down");
  await waitFor(() => expect(sent.keys).toEqual([["Down"]]));
  await waitFor(() => expect(screen.getByRole("group", { name: TITLE })).toHaveTextContent(/❯ 3\. Fable/));
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

describe("AgentChat: a menu commit answers the ask of the card the person saw", () => {
  it("the fixtures are two states of one picker, with two hashes", () => {
    expect(ASK_PICKER.kind).toBe("menu");
    expect(ASK_PICKER.options.map((o) => o.label)).toEqual(ASK_MOVED.options.map((o) => o.label));
    expect(ASK_PICKER.hash).not.toBe(ASK_MOVED.hash);
  });

  it("after Move down, the first commit posts once, under the fresh ask whose hash is the drawn card's", async () => {
    const user = userEvent.setup();
    const sent = mountWorld({ start: PICKER, held: ASK_PICKER, fresh: (now) => askFor(now, "ask-0c0c0c0c0c0c0c") });
    await moveDown(user, sent);

    await tap(user, SESSION_ONLY);
    await waitFor(() => expect(sent.answers).toHaveLength(1));
    expect(sent.prepares).toHaveLength(1);
    expect(sent.prepares[0]!.body).toMatchObject({ pane: PANE_ID, text: "", mode: "prepare" });
    expect(sent.answers[0]).toEqual({
      path: "/api/ask/ask-0c0c0c0c0c0c0c",
      body: { pane: PANE_ID, hash: ASK_MOVED.hash, optionId: "2", origin: "person_tap" },
    });
    // The held ask names the row before the move: it is never answered.
    expect(sent.answers.some((a) => a.path.endsWith(ASK_PICKER.id))).toBe(false);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("Sent"));
  });

  it("a card that matches the held ask posts at once, with no extra read", async () => {
    const user = userEvent.setup();
    const sent = mountWorld({ start: PICKER, held: ASK_PICKER, fresh: () => null });

    await tap(user, SESSION_ONLY);
    await waitFor(() => expect(sent.answers).toHaveLength(1));
    expect(sent.answers[0]).toEqual({ path: `/api/ask/${ASK_PICKER.id}`, body: { pane: PANE_ID, hash: ASK_PICKER.hash, optionId: "2", origin: "person_tap" } });
    expect(sent.prepares).toHaveLength(0);
  });

  it("a fresh read that does not show the card's dialog posts nothing and says the dialog changed", async () => {
    const user = userEvent.setup();
    // The bridge's read still finds row 1 highlighted: the card shows row 3, so no commit may go.
    const sent = mountWorld({ start: PICKER, held: ASK_PICKER, fresh: () => askFor(PICKER, "ask-0d0d0d0d0d0d0d") });
    await moveDown(user, sent);

    await tap(user, SESSION_ONLY);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("The dialog changed; the card shows the new one"));
    expect(sent.prepares).toHaveLength(1);
    expect(sent.answers).toEqual([]);
  });

  it("a card older than the held ask posts nothing: the Surface's newer row is not the one on the card", async () => {
    const user = userEvent.setup();
    // The card still shows row 1; the Surface and the screen are on row 3 already.
    const sent = mountWorld({ start: PICKER, held: ASK_MOVED, fresh: () => askFor(MOVED, "ask-0e0e0e0e0e0e0e") });

    await tap(user, SESSION_ONLY);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("The dialog changed; the card shows the new one"));
    expect(sent.prepares).toHaveLength(1);
    expect(sent.answers).toEqual([]);
  });
});
