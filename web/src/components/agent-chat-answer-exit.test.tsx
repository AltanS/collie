import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { t } from "@/lib/i18n";
import { useStatus } from "@/lib/status";
import { askOfLift, liftDialog, readerBlocks } from "@/lib/surface/lift";
import { holdHash, type HoldNote } from "@/lib/surface/hold";
import type { Ask } from "@/lib/surface/surface";
import type { AgentView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { server } from "@/test/setup";
import { fixtureAgents } from "@/test/handlers";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";
import { HOLD_TAP_GUARD_MS } from "./hook-hold-card";

// M102 spec 10: an answer that cannot go shows the screen and the keys. A tap on a permission card that
// the bridge refuses, cannot plan, or gives no word for opens one exit in place of the card: a line that
// says what happened, the live screen, and the person's Keys pad. A changed dialog keeps today's ending
// (the card re-renders on the new ask), and the exit goes when the dialog does.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

const PANE_ID = fixtureAgents[0]!.paneId;
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
/** A Bash permission dialog on a lab project (`mkfifo fixture-fifo`): no real name, path or token. */
const PERMISSION = readFileSync(join(PANES_DIR, "claude--permission-bash.txt"), "utf8");
/** The same pane with the dialog gone: the transcript only. */
const ROWS = PERMISSION.split("\r\n");
const NO_DIALOG = ROWS.slice(0, ROWS.findIndex((row) => row.includes("Bash command")) - 1).join("\r\n");
/** The same dialog for another command: the next dialog, never the one an exit was raised for. */
const OTHER = PERMISSION.replaceAll("mkfifo fixture-fifo", "touch other-file");

function askFor(text: string, id: string): Ask {
  const dialog = liftDialog(readerBlocks(splitLines(parseAnsi(text)), "claude"));
  if (dialog === null) throw new Error("the fixture lifts no dialog");
  return askOfLift(dialog, id);
}
const ASK = askFor(PERMISSION, "ask-1a1a1a1a1a1a1a");
const ASK_OTHER = askFor(OTHER, "ask-2b2b2b2b2b2b2b");

function StatusLine() {
  const status = useStatus();
  return <div data-testid="status">{status?.text ?? ""}</div>;
}

interface World {
  /** What `POST /api/ask/<id>` answers. */
  readonly reply?: () => Response;
  /** What `POST /api/pane/<id>/keys` answers (the guarded key route). */
  readonly keys?: () => Response;
  /** A crew member's pane: the guarded key route instead of the ask. */
  readonly member?: boolean;
  /** The screen the chat mounts on. Default: the permission dialog. */
  readonly start?: string;
  /** A hook-held request the pane carries (M56 spec 12). */
  readonly hold?: HoldNote;
}

function mount(world: World) {
  const answers: string[] = [];
  const keys: string[][] = [];
  let push: (text: string) => void = () => {
    throw new Error("chat not mounted");
  };
  let showing = world.start ?? PERMISSION;
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: PANE_ID, text: showing, truncated: false, revision: 5 })),
    http.post(/\/api\/pane\/[^/]+\/keys$/, async ({ request }) => {
      // SAFETY: `sendKeys` in lib/api.ts is the only caller and posts `{ keys, expected_prompt? }`.
      const body = (await request.json()) as { keys: string[] };
      keys.push(body.keys);
      return world.keys?.() ?? HttpResponse.json({ ok: true });
    }),
    http.post(/\/api\/ask\/[^/]+$/, ({ request }) => {
      answers.push(new URL(request.url).pathname);
      return world.reply?.() ?? HttpResponse.json({ receipt: { askId: ASK.id, outcome: "sent", keys: ["1"] } });
    }),
  );
  const scope: Scope | undefined = world.member === true ? { host: "member-a" } : undefined;
  const surfaceOf = (text: string) => ({ revision: 0, turn: "idle" as const, modal: text === PERMISSION ? { ask: ASK } : text === OTHER ? { ask: ASK_OTHER } : ("none" as const), composer: "unknown" as const });
  function Harness() {
    const [text, setText] = useState(world.start ?? PERMISSION);
    push = (next) => {
      showing = next;
      setText(next);
    };
    const agent: AgentView = { ...fixtureAgents[0]!, sendProtocol: true, surface: surfaceOf(text) };
    if (scope !== undefined) agent.host = scope.host;
    if (world.hold !== undefined) agent.hold = world.hold;
    return (
      <>
        <StatusLine />
        <AgentChat paneId={PANE_ID} agent={agent} agents={[agent]} shellPanes={[]} tabs={[]} text={text} revision={5} onBack={vi.fn()} onSelect={vi.fn()} scope={scope} />
      </>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: withHeaderHost(<Harness />) }])} />);
  return { answers, keys, push: (text: string) => act(() => push(text)) };
}

const refused = (reason: string) => () => HttpResponse.json({ receipt: { askId: ASK.id, outcome: "refused", reason, keys: [] }, detail: "A sentence from the bridge." });

async function tapYes(user: ReturnType<typeof userEvent.setup>) {
  const yes = await screen.findByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ });
  await waitFor(() => expect(yes).toBeEnabled());
  await user.click(yes);
}

/** The exit with its line, or a failure naming the line it looked for. */
const findExit = (line: string) => screen.findByRole("group", { name: line });

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AgentChat: an answer that cannot go (M102 spec 10)", () => {
  it("a no_plan refusal opens the exit: its line, the live screen, the Keys pad, and no Yes button", async () => {
    const user = userEvent.setup();
    const sent = mount({ reply: refused("no_plan") });
    await tapYes(user);
    const exit = await findExit(t("answerExit.noPlan"));
    expect(sent.answers).toHaveLength(1);
    // The live screen, as the pane shows it: the command the dialog asks about.
    expect(within(exit).getAllByText(/mkfifo fixture-fifo/).length).toBeGreaterThan(0);
    // The person's own Keys pad opens under the card.
    await waitFor(() => expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true"));
    // The card the answer did not go from is put away; the keys are keys, never answers.
    expect(screen.queryByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ })).toBeNull();
    expect(within(exit).queryByRole("button", { name: "Send anyway" })).toBeNull();
  });

  it("a stale_surface refusal opens the exit with the refused line", async () => {
    const user = userEvent.setup();
    mount({ reply: refused("stale_surface") });
    await tapYes(user);
    expect(await findExit(t("answerExit.refused"))).toBeInTheDocument();
  });

  it("an unknown answer opens the exit with the no-proof line", async () => {
    const user = userEvent.setup();
    mount({ reply: () => HttpResponse.json({ receipt: { askId: ASK.id, outcome: "unknown", reason: "no_evidence", keys: ["1"] } }) });
    await tapYes(user);
    expect(await findExit(t("answerExit.unknown"))).toBeInTheDocument();
  });

  it("an answer with no reply opens the exit with the no-reply line", async () => {
    const user = userEvent.setup();
    mount({ reply: () => HttpResponse.json({ error: "the bridge broke" }, { status: 500 }) });
    await tapYes(user);
    expect(await findExit(t("answerExit.error"))).toBeInTheDocument();
  });

  it("a changed dialog keeps today's ending: no exit, and the card stays to answer", async () => {
    const user = userEvent.setup();
    mount({ reply: () => HttpResponse.json({ receipt: { askId: ASK.id, outcome: "refused", reason: "ask_changed", keys: [] }, ask: ASK }) });
    await tapYes(user);
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent(t("chat.status.askChanged")));
    expect(screen.queryByRole("group", { name: t("answerExit.changed") })).toBeNull();
    expect(screen.queryByRole("group", { name: t("answerExit.refused") })).toBeNull();
    expect(screen.getByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ })).toBeInTheDocument();
  });

  it("the cross closes the exit and brings the card back", async () => {
    const user = userEvent.setup();
    mount({ reply: refused("no_plan") });
    await tapYes(user);
    const exit = await findExit(t("answerExit.noPlan"));
    await user.click(within(exit).getByRole("button", { name: t("answerExit.closeAria") }));
    expect(screen.queryByRole("group", { name: t("answerExit.noPlan") })).toBeNull();
    expect(await screen.findByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ })).toBeInTheDocument();
  });

  it("the exit goes when the dialog goes, and does not come back with the next dialog", async () => {
    const user = userEvent.setup();
    const world = mount({ reply: refused("no_plan") });
    await tapYes(user);
    await findExit(t("answerExit.noPlan"));
    world.push(NO_DIALOG);
    await waitFor(() => expect(screen.queryByRole("group", { name: t("answerExit.noPlan") })).toBeNull());
    // Another permission dialog draws its own card, never the old exit.
    world.push(OTHER);
    expect(await screen.findByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: t("answerExit.noPlan") })).toBeNull();
  });

  it("the exit is not drawn over another dialog that took the screen", async () => {
    const user = userEvent.setup();
    const world = mount({ reply: refused("no_plan") });
    await tapYes(user);
    await findExit(t("answerExit.noPlan"));
    world.push(OTHER);
    await waitFor(() => expect(screen.queryByRole("group", { name: t("answerExit.noPlan") })).toBeNull());
    expect(screen.getByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ })).toBeInTheDocument();
  });
});

describe("AgentChat: the guarded key route's real refusal opens the exit (M102 spec 10)", () => {
  it("a bound region the bridge refuses opens the exit with the changed line, after one key post", async () => {
    const user = userEvent.setup();
    const sent = mount({ member: true, keys: () => HttpResponse.json({ ok: false, error: "the prompt moved", code: "prompt_changed" }, { status: 409 }) });
    await tapYes(user);
    const exit = await findExit(t("answerExit.changed"));
    expect(sent.keys).toEqual([["1"]]);
    expect(within(exit).getAllByText(/mkfifo fixture-fifo/).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true"));
  });

  it("a guard that reads another dialog sends nothing, and the new dialog keeps its card once it shows", async () => {
    const user = userEvent.setup();
    const sent = mount({ member: true });
    // The bridge's screen moved to another command before the tap: the guard refuses with no key.
    server.use(http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.json({ paneId: PANE_ID, text: OTHER, truncated: false, revision: 6 })));
    await tapYes(user);
    await findExit(t("answerExit.changed"));
    expect(sent.keys).toEqual([]);
    sent.push(OTHER);
    await waitFor(() => expect(screen.queryByRole("group", { name: t("answerExit.changed") })).toBeNull());
    expect(screen.getByRole("button", { name: /^1\.?\s*Yes$|^Yes$/ })).toBeInTheDocument();
  });
});

describe("AgentChat: the hook hold card's dead end opens the exit (M102 spec 10)", () => {
  const NOTE: HoldNote = {
    askId: "ask-3c3c3c3c3c3c3c",
    state: "held",
    tool: "Bash",
    input: "ls sample-dir",
    agent: true,
    options: ["Yes", "No"],
    hash: holdHash("Bash", "ls sample-dir", ["Yes", "No"]),
    adopted: false,
    since: 1,
  };

  it("a refused hold answer opens the exit over the screen, and the hold card says the answer did not go", async () => {
    const user = userEvent.setup();
    mount({ start: NO_DIALOG, hold: NOTE, reply: () => HttpResponse.json({ receipt: { askId: NOTE.askId, outcome: "refused", reason: "busy", keys: [] } }) });
    const yes = await screen.findByRole("button", { name: /Yes/ });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + HOLD_TAP_GUARD_MS);
    await user.click(yes);
    const exit = await findExit(t("answerExit.refused"));
    expect(within(exit).getAllByText(/hello\.txt/).length).toBeGreaterThan(0);
    expect(await screen.findByText(t("chat.hold.answerFailed"))).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Keys" })).toHaveAttribute("aria-expanded", "true"));
  });
});
