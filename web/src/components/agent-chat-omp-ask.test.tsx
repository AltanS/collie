import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { en } from "@/lib/i18n/messages/en";
import type { PaneChatResponse } from "@/lib/types";
import { server } from "@/test/setup";
import { fixtureAgents, fixtureOmpAskBatchChat, fixtureOmpAskSingleChat } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// M46 spec 11 turns every send off for a pane the bridge has not answered lately (lib/liveness.ts).
// This suite never polls first, so it pins the pane live; the gating has its own suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

// Captured OMP Ask screens replayed through Chat with a key-driven pane stub. History stays
// read-only; live answers use walk/verify/commit (the dock walks the pointer with arrows, reads the
// pane back to see the pointer landed, then presses Enter). Live proof: the OMP ask notes.
// Moved here from `e2e/omp-ask-chat.spec.ts`: nothing in it needs a browser engine, only the app's
// own fetch layer, which MSW answers.

const PANE_ID = fixtureAgents[0]!.paneId;
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const screenOf = (name: string): string => readFileSync(join(PANES_DIR, `${name}.txt`), "utf8");
const POINTER = "❯ ";
const GAP = "  ";

/** Move only the pointer glyph, preserving columns and SGR runs from the real capture. */
function pointerOn(screenText: string, label: string): string {
  return screenText
    .split("\n")
    .map((line) => {
      const pointed = line.includes(POINTER);
      const target = line.includes(label);
      if (pointed && !target) return line.replace(POINTER, GAP);
      if (!pointed && target) return line.replace(` ${GAP}`, ` ${POINTER}`);
      return line;
    })
    .join("\n");
}

interface SentKeys {
  readonly keys: readonly string[];
  readonly expected_prompt?: string;
}

/** A terminal transition driven by the app's emitted keys. */
interface Step {
  readonly on: string;
  readonly keys: readonly string[];
  readonly to: string;
}

interface World {
  readonly chat: PaneChatResponse;
  readonly screens: Readonly<Record<string, string>>;
  readonly start: string;
  readonly script: readonly Step[];
}

/**
 * Mount Chat on an OMP pane whose screen follows `world`. A static pane would reject a guarded walk:
 * each read must show where its arrows landed, so the keys endpoint advances the screen and the
 * mounted chat is handed the new text, as the route's poll would.
 */
function mountWorld(world: World) {
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "chat", showToolCalls: true }));
  const sent: SentKeys[] = [];
  let showing = world.start;
  let revision = 1;
  let push: (text: string, rev: number) => void = () => {
    throw new Error("chat not mounted");
  };

  server.use(
    http.get(/\/api\/pane\/[^/]+\/chat/, () => HttpResponse.json(world.chat)),
    http.get(/\/api\/pane\/[^/]+$/, () =>
      HttpResponse.json({ paneId: PANE_ID, text: world.screens[showing], truncated: false, revision }),
    ),
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      // SAFETY: the body is the app's own, `sendKeys` in lib/api.ts is the only caller of this
      // endpoint and posts exactly `{ keys, expected_prompt?, expected_styled? }`.
      const body = (await request.json()) as SentKeys;
      sent.push(body);
      const step = world.script.find((s) => s.on === showing && s.keys.join("+") === body.keys.join("+"));
      if (step) {
        showing = step.to;
        revision += 1;
        // The route's next poll, after the write.
        queueMicrotask(() => act(() => push(world.screens[showing]!, revision)));
      }
      return HttpResponse.json({ ok: true });
    }),
  );

  const agent = { ...fixtureAgents[0]!, agent: "omp", hasSession: true };
  function Harness() {
    const [pane, setPane] = useState({ text: world.screens[world.start]!, revision });
    push = (text, rev) => setPane({ text, revision: rev });
    return (
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
    );
  }
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<Harness />) }]);
  render(<RouterProvider router={router} />);
  return sent;
}

/** Playwright waited for the button to be enabled; a tap while the last write settles is a no-op. */
async function tap(user: ReturnType<typeof userEvent.setup>, group: HTMLElement, name: string | RegExp) {
  const button = within(group).getByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

// ── One question ────────────────────────────────────────────────────────────────────────────────

const QUESTION = "Pick a colour";
const ANSWER = "Blue";

function singleWorld(): World {
  const asking = screenOf("omp--v18-10-ask-single");
  return {
    chat: fixtureOmpAskSingleChat,
    screens: { asking, answering: pointerOn(asking, ANSWER), answered: screenOf("omp--v18-10-draft-blank-line") },
    start: "asking",
    script: [
      { on: "asking", keys: ["Down"], to: "answering" },
      { on: "answering", keys: ["Enter"], to: "answered" },
    ],
  };
}

describe("AgentChat: a pending OMP ask", () => {
  it("is drawn in Chat as history, and its options are not buttons", async () => {
    mountWorld(singleWorld());

    expect(await screen.findByText(en["chat.tool.question"], { exact: true })).toBeInTheDocument();
    expect(screen.getAllByText(QUESTION, { exact: true }).length).toBeGreaterThan(0);
    for (const label of ["Red", ANSWER]) {
      const rows = screen.getAllByRole("listitem").filter((li) => li.textContent?.includes(label));
      expect(rows).toHaveLength(1);
      // History must never become a second, stale set of answer buttons.
      expect(within(rows[0]!).queryAllByRole("button")).toHaveLength(0);
    }
  });

  it("is answered from the dock: tapping Blue walks the pointer, verifies, then commits", async () => {
    const user = userEvent.setup();
    const sent = mountWorld(singleWorld());

    const dock = await screen.findByRole("group", { name: QUESTION });
    for (const label of ["Red", ANSWER, "Other (type your own)"]) {
      expect(within(dock).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText(en["chat.question.answerBelow"])).toBeInTheDocument();

    await tap(user, dock, ANSWER);
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map((write) => write.keys)).toEqual([["Down"], ["Enter"]]);
    for (const write of sent) expect(write.expected_prompt).toContain(QUESTION);
    await waitFor(() => expect(screen.queryByRole("group", { name: QUESTION })).toBeNull());
  });
});

// ── Three questions ─────────────────────────────────────────────────────────────────────────────
// Question and review screens are real captures; only the third pointer move is derived.

function batchWorld(): World {
  const q3 = screenOf("omp--v18-10-ask-batch-third");
  return {
    chat: fixtureOmpAskBatchChat,
    screens: {
      q1: screenOf("omp--v18-10-ask-batch"),
      "q1-below": screenOf("omp--v18-10-ask-batch-moved"),
      q2: screenOf("omp--v18-10-ask-batch-second"),
      q3,
      "q3-separate": pointerOn(q3, "Separate"),
      review: screenOf("omp--v18-10-ask-batch-review"),
      answered: screenOf("omp--v18-10-draft-blank-line"),
    },
    start: "q1",
    script: [
      { on: "q1", keys: ["Down"], to: "q1-below" },
      { on: "q1-below", keys: ["Enter"], to: "q2" },
      { on: "q2", keys: ["Enter"], to: "q3" },
      { on: "q3", keys: ["Down", "Down"], to: "q3-separate" },
      { on: "q3-separate", keys: ["Enter"], to: "review" },
      { on: "review", keys: ["Enter"], to: "answered" },
    ],
  };
}

describe("AgentChat: a three-question OMP ask", () => {
  it("is answered in the dock, question by question, through Submit", async () => {
    const user = userEvent.setup();
    const sent = mountWorld(batchWorld());

    for (const header of ["Location", "Alternative", "Confirm"]) {
      expect((await screen.findAllByText(header, { exact: true })).length).toBeGreaterThan(0);
    }

    const first = await screen.findByRole("group", { name: "Where should the note go?" });
    await tap(user, first, /^Below/);

    const second = await screen.findByRole("group", { name: "Which alternative should we keep?" });
    await tap(user, second, /^Above/);

    const third = await screen.findByRole("group", { name: "Confirm this plan?" });
    await tap(user, third, /^Separate/);

    const review = await screen.findByRole("group", { name: /Review answers/ });
    for (const line of ["Location: Below", "Alternative: Above", "Confirm: Separate"]) {
      expect(review).toHaveTextContent(line);
    }
    await tap(user, review, "Submit");

    await waitFor(() => expect(sent).toHaveLength(6));
    expect(sent.map((write) => write.keys)).toEqual([
      ["Down"],
      ["Enter"],
      ["Enter"],
      ["Down", "Down"],
      ["Enter"],
      ["Enter"],
    ]);
    expect(sent[0]!.expected_prompt).toContain("Where should the note go?");
    expect(sent[5]!.expected_prompt).toContain("Review answers");

    await waitFor(() => expect(screen.queryByRole("button", { name: "Submit" })).toBeNull());
  });
});
