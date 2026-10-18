import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { en } from "@/lib/i18n/messages/en";
import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// ── Issue 347: the two-question wizard renders as cards with buttons ────────────────────────────
//
// One opencode `question` call with two single-select questions lifts into a `wizard` block
// (`opencodeBuildBlocks` → `detectQuestionTabs`), and Chat renders the lifted step as tappable cards.
// The second case pins the overlay half of #347 at the UI layer: a sidebar tail row grafted under
// the free-text row (the same graft `lib/harness/opencode.test.ts` pins) must still lift, because
// the pointer chip sits on a real option and the tail is foreign chrome, never input.
// The pane text comes from the fixture corpus (`src/fixtures/panes/oc--question--two--*.txt`).
//
// ONE TAP, NO CONVERSATION. The first case taps exactly one answer and asserts the single guarded
// keystroke (`keys: ["1"]`) the race guard sends; it never advances the wizard. The live trigger for
// real panes is `e2e/manual/question-wizard-live.sh`.
// Moved here from `e2e/question-wizard-overlay.spec.ts`: nothing in it needs a browser engine.

// M46 spec 11 turns every send off for a pane the bridge has not answered lately (lib/liveness.ts).
// This suite never polls first, so it pins the pane live; the gating has its own suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const PANE_ID = fixtureAgents[0]!.paneId;
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const screenOf = (name: string): string => readFileSync(join(PANES_DIR, name), "utf8");

// `fixtureAgents[0]` is a claude pane, and the claude adapter would not lift an opencode dialog:
// the registry routes by the pane's own agent string, so the override names opencode and nothing
// else changes.
const OPENCODE = { ...fixtureAgents[0]!, agent: "opencode" };

interface SentKeys {
  readonly keys: readonly string[];
}

/** Mount Chat on an opencode pane showing `text`, and record every keys write the app posts. */
function mountScreen(text: string): SentKeys[] {
  localStorage.setItem("collie:dash-prefs:v1", JSON.stringify({ paneView: "terminal" }));
  const sent: SentKeys[] = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: PANE_ID, text, truncated: false, revision: 1 })),
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      // SAFETY: the body is the app's own, `sendKeys` in lib/api.ts is the only caller of this endpoint.
      sent.push((await request.json()) as SentKeys);
      return HttpResponse.json({ ok: true });
    }),
  );
  const router = createMemoryRouter([
    {
      path: "/",
      element: withHeaderHost(
        <AgentChat
          paneId={PANE_ID}
          agent={OPENCODE}
          agents={[OPENCODE]}
          shellPanes={[]}
          tabs={[]}
          text={text}
          revision={1}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />,
      ),
    },
  ]);
  render(<RouterProvider router={router} />);
  return sent;
}

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

describe("AgentChat: an opencode two-question wizard (#347)", () => {
  it("renders as cards with buttons, and tapping an answer sends its digit", async () => {
    const user = userEvent.setup();
    const sent = mountScreen(screenOf("oc--question--two--q1.txt"));

    // The lifted step replaces the dialog region: one group named by the question …
    expect(await screen.findByRole("group", { name: "Which colour?" })).toBeInTheDocument();
    // … with the stepper chips (the two questions plus the fixed Submit stop) …
    const chips = within(screen.getByRole("list", { name: en["dialog.questionsAria"] })).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual(["Colour", "Size", "Submit"]);
    // … and one button per answer, named by its label.
    for (const label of ["Red", "Green", "Blue"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }

    // The single tap: Red is option 1, and a digit on a single-select step selects it.
    const red = screen.getByRole("button", { name: /Red/ });
    await waitFor(() => expect(red).toBeEnabled());
    await user.click(red);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ keys: ["1"] });
  });

  it("a sidebar tail row under the free-text row still lifts the wizard", async () => {
    // Grafted, not captured: the two--q1 dialog with a Models-panel tail row under the free-text
    // row. The chip sits on option 1, so the tail is foreign chrome and the step must lift anyway.
    // Raw lines wrap the label in SGR runs, so only the bare label matches raw text here.
    const raw = screenOf("oc--question--two--q1.txt").split("\n");
    const at = raw.findIndex((line) => line.includes("Type your own answer"));
    expect(at).toBeGreaterThan(0);
    const grafted = [
      ...raw.slice(0, at + 1),
      "  ┃     │ artistry muse-spark-1.3-contributor │",
      ...raw.slice(at + 1),
    ].join("\n");
    mountScreen(grafted);

    // Render-only: this case pins availability (the card exists despite the overlay), not the tap.
    expect(await screen.findByRole("group", { name: "Which colour?" })).toBeInTheDocument();
    for (const label of ["Red", "Green", "Blue"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
  });
});
