import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, useParams } from "react-router";

import { __resetConnectionHealth } from "@/lib/connection-health";

// Mock the race guard at AgentChat's seam so the frozen-revision tests can observe exactly what
// `detectedRevision` the tap handler passes (the guard's own behaviour is covered in
// prompt-select-block.test.tsx). The other tests in this file never reach it.
vi.mock("@/lib/prompt-action", () => ({
  submitPromptOption: vi.fn(),
}));
vi.mock("@/lib/wizard-action", () => ({
  submitWizardKeys: vi.fn(),
}));

import { server } from "@/test/setup";
import { clearStatus } from "@/lib/status";
import { submitPromptOption } from "@/lib/prompt-action";
import { submitWizardKeys } from "@/lib/wizard-action";
import { fixtureAgents, fixtureShellPanes, fixtureTabs } from "@/test/handlers";
import { PackProvider } from "./pack-provider";
import type { AgentStatus, ServerSummary } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { AgentChat } from "./agent-chat";

// The detail view's core job: type a reply and submit it to the bridge. This drives the whole wired
// path (composer → api.sendReply → MSW → optimistic clear / error surfacing) end-to-end, which no
// other test covers. AgentChat uses useRevalidator, so it needs a data router (createMemoryRouter).

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());

function renderChat(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = fixtureAgents[0]!; // a blocked claude agent
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    agent,
    agents: fixtureAgents,
    shellPanes: [],
    tabs: [],
    text: "recent pane output",
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<AgentChat {...props} />) }]);
  const { container } = render(<RouterProvider router={router} />);
  return { props, container };
}

// Find and History are ROWS in the pane's actions sheet now — the header spends ONE ⋮ on the whole
// menu instead of two icons on two actions. Every test that used to click a header icon goes through
// this door, which is also the point: there is exactly one door.
type User = ReturnType<typeof userEvent.setup>;
async function openPaneMenu(user: User) {
  await user.click(screen.getByRole("button", { name: "Pane actions" }));
}
async function openFind(user: User) {
  await openPaneMenu(user);
  await user.click(screen.getByRole("button", { name: "Find in output" }));
}

describe("AgentChat — reply flow", () => {
  it("sends a typed reply and clears the composer on success", async () => {
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "looks good");
    expect(box).toHaveValue("looks good");

    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the draft and surfaces the error when the bridge rejects the send", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, () =>
        HttpResponse.json({ ok: false, error: "agent busy" }),
      ),
    );
    const user = userEvent.setup();
    renderChat();
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.type(box, "retry this");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("agent busy")).toBeInTheDocument();
    expect(box).toHaveValue("retry this"); // not cleared on failure
  });
});

// Echoes the space passed via navigation state, so a test can assert the header lands on the space
// overview ("/") for the right workspace.
function SpaceOverviewSentinel() {
  const { spaceId } = useParams();
  return <div>overview:{spaceId ?? "none"}</div>;
}

describe("AgentChat — header title block", () => {
  it("leads with the space, and drops the redundant agent name and the directory that repeats it", () => {
    renderChat(); // claude @ /home/you/webapp → ~/webapp, under the name "webapp"
    expect(screen.getByText("webapp")).toBeInTheDocument(); // space leads
    // The cwd subline is gated on saying something the name does not: `~/webapp` under `webapp` is
    // the same word twice, so line 3 does not render. See the cwd-gate describe block below.
    expect(screen.queryByText("~/webapp")).toBeNull();
    // The agent is conveyed by its icon (aria-label only), so its name isn't repeated as text.
    // Scoped to the title block itself: the mirror below it may legitimately NAME the agent — the
    // no-session note (#137) does — and that is not the redundancy this asserts against.
    const title = screen.getByRole("button", { name: /open webapp overview/i });
    expect(within(title).queryByText(/claude/i)).toBeNull();
  });

  it("opens the space overview (all tabs + panes) when the title block is tapped", async () => {
    const user = userEvent.setup();
    const agent = fixtureAgents[0]!; // workspaceId w1
    const router = createMemoryRouter(
      [
        { path: "/space/:spaceId", element: <SpaceOverviewSentinel /> },
        {
          path: "/pane/:paneId",
          element: withHeaderHost(
            <AgentChat
              paneId={agent.paneId}
              agent={agent}
              agents={fixtureAgents}
              shellPanes={[]}
              tabs={[]}
              text="out"
              onBack={vi.fn()}
              onSelect={vi.fn()}
            />,
          ),
        },
      ],
      { initialEntries: ["/pane/w1:p1"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: /open webapp overview/i }));
    expect(await screen.findByText("overview:w1")).toBeInTheDocument();
  });
});

// THE PANE HEADER'S IDENTITY BLOCK — TWO lines now: the name at full width, and a cwd line that only
// appears when it has something to add. The caption line above them is gone, and the status word it
// held moved DOWN to the composer's status strip, beside the host. The dot badged onto the agent's
// own tile did NOT move: dot and word carry the state together (status-badge.tsx measures why a dot
// alone cannot), and only one half of the pair changed address.
//
// Every query below is scoped to the render's OWN container by data-slot. `ui/strip-host.tsx` mounts
// two permanent, empty sr-only live regions, so a bare `screen.getByRole("status")` is ambiguous in
// any tree that holds a host, and the failure reads as a missing element rather than a duplicate one.
describe("AgentChat — the pane header's identity block", () => {
  const identity = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="pane-identity"]');
  const slot = (c: HTMLElement, name: string) =>
    c.querySelector<HTMLElement>(`[data-slot="pane-${name}"]`);
  /** The composer's status strip — where the word went. Same render, same container, same rule. */
  const strip = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="composer-status"]');
  /** The word the status slot is SHOWING. The slot renders every word it could ever hold, stacked in
   *  one grid cell so its width is the widest of them and no state can move the host beside it
   *  (ui/one-of.tsx, DESIGN.md §2) — so its `textContent` is all five, and the visible one is the
   *  layer marked `data-active`. */
  const shownWord = (c: HTMLElement | null) =>
    c?.querySelector<HTMLElement>("[data-active]")?.textContent ?? null;
  /** Every named mark inside the identity block — the agent's own logo is one too. */
  const names = (c: HTMLElement) =>
    Array.from(identity(c)?.querySelectorAll('[role="img"]') ?? []).map((e) =>
      e.getAttribute("aria-label"),
    );

  it("says the state in a WORD on the composer strip and in the DOT up here, in every state", () => {
    // THE ONE THIS ROUND EXISTS FOR, restated after the move. Reducing the state to colour alone does
    // not survive a colour-vision simulation on the app's own tokens: for a deuteranope, blocked /
    // working / done collapse to ONE colour in light theme, and "needs you" against "done" — the most
    // consequential opposite pair the app has — collapses in BOTH themes. Idle and unknown are 0.02
    // apart in lightness and are the same dot for everybody. So the word may move, and may not go.
    //
    // THREE claims per status, and each fails on its own: the word is ON the composer's status strip,
    // the word is NOT in the header any more, and the dot is STILL badged onto the agent's tile.
    // Delete the word and the first fails; leave it in the caption and the second fails; drop the
    // badge while "tidying" the header and the third fails.
    //
    // Exhaustive by construction: a `Record<AgentStatus, string>` literal is complete-checked by tsc,
    // so a sixth status cannot be added without either teaching this test or failing the typecheck.
    const words = {
      blocked: "needs you",
      working: "working",
      idle: "idle",
      done: "done",
      unknown: "unknown",
    } satisfies Record<AgentStatus, string>;
    // SAFETY: `words` is `satisfies Record<AgentStatus, string>` just above, so tsc has already
    // proved its keys are exactly the members of AgentStatus — Object.entries widens them to string
    // because it cannot see that proof.
    for (const [status, word] of Object.entries(words) as [AgentStatus, string][]) {
      const agent = { ...fixtureAgents[0]!, status };
      const { container } = renderChat({ agent, agents: [agent] });
      expect(strip(container)?.textContent).toContain(word); // down at the write surface
      // …and NOT in the identity block's own text. (Its aria-label still carries the state — see the
      // accessibility-tree test below — because a label on a button replaces everything inside it.)
      expect(identity(container)?.textContent).not.toContain(word);
      expect(slot(container, "caption")).toBeNull(); // the line itself is gone, not merely emptied
      // …and the dot is still there, badged onto the agent's own tile inside the identity block, and
      // it NAMES itself. The dot is an empty span; unnamed it reaches no screen reader and matches no
      // text query. (The AgentIcon beside it is also a role="img", hence the list rather than a
      // first-match query — the assertion is that the state is among the named marks.)
      expect(names(container)).toContain(word);
      cleanup();
    }
    // A bare shell has no agent status; the strip still carries a word, or a solo install's strip
    // would be empty and the row would be a run of buttons with nothing said above it.
    const shell = renderChat({ agent: fixtureShellPanes[0]!, agents: [fixtureShellPanes[0]!] });
    expect(strip(shell.container)?.textContent).toContain("shell");
    expect(names(shell.container)).toEqual([]); // no agent, no status, so no badge to name
  });

  it("carries neither the host nor the state — both stand on the composer's strip, as one sentence", () => {
    // THE OTHER HALF, now complete. The caption line led with the machine, which spent the identity
    // block's width on an answer to a question nobody has while READING; the machine left first and
    // the word followed it. Both are asserted absent HERE and present THERE, so a run deleted from
    // both files passes neither test.
    //
    // Scoped by data-slot, never by a bare role query: `ui/strip-host.tsx` mounts two permanent
    // sr-only live regions, so `getByRole("status")` is ambiguous in any tree with a host in it and
    // would fail as "missing" rather than "duplicated".
    const { container } = renderPackChat("workshop"); // a REAL pack — HostChip hides on a solo one
    expect(slot(container, "caption")).toBeNull();
    const block = identity(container);
    expect(block?.textContent).not.toMatch(/workshop/i);
    expect(block?.textContent).not.toContain("needs you");
    // …and one strip below carries the pair, in that order: which machine, then what it is doing.
    const line = strip(container);
    // Machine first, then what it is doing. The host is read off its own label rather than the
    // strip's text, because the strip's text now includes the four words it is RESERVING for.
    expect(shownWord(line)).toBe("needs you");
    // This pane's machine is unreachable, so the host run carries the fault with it rather than
    // showing a calm name beside a placeholder that says the write will be refused.
    expect(
      within(line!).getByLabelText(/^sends to host: workshop \(unreachable\)$/i),
    ).toBeInTheDocument();
  });

  it("puts the state into the accessibility tree, which the caption's own text cannot do", () => {
    // An aria-label on a button REPLACES everything inside it, so moving the status word into this
    // block would have taken the pane's status out of the accessibility tree altogether — the badge
    // it replaced sat outside the button and was read. The label carries it instead, via a locale
    // string, because where the punctuation goes is a translator's decision.
    const { container } = renderChat(); // fixtureAgents[0] is blocked → "needs you"
    expect(identity(container)?.getAttribute("aria-label")).toBe(
      "Open webapp overview — needs you",
    );
  });

  it("gives the thing you tap a real 44px hit box, not a 39px drawn one", () => {
    // MEASURED, in the playground, at 390px: this button was 39.00px tall. It is the only way off the
    // pane to the space overview, and it sat under the floor in the very row that states the floor
    // for every other control in it. `min-h-11` is 44px, and it is what catches the COMMON case — the
    // two-line block (caption 12 + gap 4 + name 20) is 36px and would otherwise draw at 36.
    const { container } = renderChat();
    const cls = identity(container)?.className ?? "";
    expect(cls).toMatch(/(^|\s)min-h-11(?=\s|$)/);
    // And no vertical padding on top of it: 52px of lines plus a `py-0.5` is 56px in the row's 52px
    // content box, which grows the row to 64px on the pane route alone — exactly the route-local jump
    // `min-h-15` was stated to prevent.
    expect(cls).not.toMatch(/(^|\s)(?:p|py)-\d/);
  });

  it("is TWO lines now, and the row still stands on its 60px floor rather than shrinking to them", () => {
    // THE COUPLING, and it spans two files. agent-chat.tsx states the line boxes and the gap between
    // them; app-header.tsx states the row's floor and the padding that has to hold them. Each edit
    // looks complete on its own, and the failure is a header that changes height on ONE route — the
    // navigation jump `min-h-15` exists to kill. So the arithmetic is read off the rendered elements
    // rather than trusted.
    //
    // The block lost its caption line, so it is 20 + 4 + 12 = 36px where it was 52px. `min-h-15` is a
    // FLOOR and not a sum: 36px of lines plus 2×4px of padding is 44px, well under 60, so the row
    // measures 60px exactly as it did before and on every other route. That is the assertion —
    // shrinking the header to fit the shorter block would lower a floor shared app-wide, which
    // DESIGN.md §6 forbids. (Verified in the playground at a true 390px content width: the header
    // row is 60.00px before and after, the identity button 52 → 44px, the lines box 52 → 36px.)
    const { container } = renderChat({
      agent: { ...fixtureAgents[0]!, cwd: "/home/you/webapp/worktrees/fix-42" },
    });
    const row = container.querySelector<HTMLElement>("header > div:last-child");
    const spacing = (cls: string, re: RegExp) => {
      const m = re.exec(cls);
      expect(m, `${re} in "${cls}"`).not.toBeNull();
      return Number(m![1]) * 4; // Tailwind's --spacing is 0.25rem, and the app's root is 16px
    };
    const floor = spacing(row?.className ?? "", /(?:^|\s)min-h-(\d+)(?=\s|$)/);
    const pad = spacing(row?.className ?? "", /(?:^|\s)py-(\d+)(?=\s|$)/);
    const gap = spacing(slot(container, "lines")?.className ?? "", /(?:^|\s)gap-(\d+)(?=\s|$)/);
    const name = spacing(slot(container, "name")?.className ?? "", /(?:^|\s)leading-(\d+)(?=\s|$)/);
    const cwd = slot(container, "cwd");
    expect(cwd, "the second line must actually be rendered for this to be a two-line test").not.toBeNull();
    const cwdBox = spacing(cwd?.className ?? "", /(?:^|\s)leading-(\d+)(?=\s|$)/);

    // There is no third line to measure, and that is the first claim: the caption row is REMOVED,
    // not emptied. An empty flex row would still cost its gap and would reappear the moment somebody
    // put something back in it.
    expect(slot(container, "caption")).toBeNull();
    expect(slot(container, "lines")?.children).toHaveLength(2);
    expect([name, cwdBox, gap, pad, floor]).toEqual([20, 12, 4, 4, 60]);
    // The lines no longer fill the content box — the FLOOR is what holds the row up, and it must.
    expect(name + gap + cwdBox + 2 * pad).toBeLessThan(floor);
    // Which is also why the identity button has to state its own 44px box: 36px of lines would draw
    // a 36px tap target in the row that states the floor for everything else.
    expect(name + gap + cwdBox).toBeLessThan(44);
  });

  it("shows the cwd when it adds a segment and hides it when it only repeats the name", () => {
    // The gate is `cwdBeyondName`, against the RENDERED NAME — see lib/pane-name.test.ts for the rule
    // itself. Here: that the header actually mounts it, and mounts it on the right string.
    const base = fixtureAgents[0]!; // workspaceLabel "webapp", cwd /home/you/webapp
    // Nothing to add: `~/webapp` under the name `webapp` is the same word twice.
    expect(slot(renderChat({ agent: base, agents: [base] }).container, "cwd")).toBeNull();
    // A worktree is exactly the case the line exists for.
    const worktree = { ...base, cwd: "/home/you/webapp/worktrees/fix-42" };
    expect(slot(renderChat({ agent: worktree, agents: [worktree] }).container, "cwd")?.textContent)
      .toBe("~/webapp/worktrees/fix-42");
    // And the case the old PROJECT gate got backwards: a hand-set label names no directory at all, so
    // suppressing the path would leave the pane with nothing on screen locating the work.
    const named = { ...base, paneLabel: "logs" };
    expect(slot(renderChat({ agent: named, agents: [named] }).container, "cwd")?.textContent).toBe(
      "~/webapp",
    );
  });
});

describe("AgentChat — read-only device", () => {
  it("disables the composer and shows the banner when the device isn't authorised", () => {
    renderChat({ device: { enforced: true, device: "spare-phone", authorized: false } });

    // The banner names the read-only state (and the device id), and the composer is locked.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByText(/spare-phone/)).toBeInTheDocument();
    const box = screen.getByPlaceholderText(/read-only — not authorised/i);
    expect(box).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    // The terminal mirror still renders — reading is always allowed.
    expect(screen.getByText("recent pane output")).toBeInTheDocument();
  });

  it("keeps the composer live for an authorised device", () => {
    renderChat({ device: { enforced: true, device: "my-phone", authorized: true } });
    expect(screen.queryByText(/read-only/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type a reply/i)).not.toBeDisabled();
  });
});

describe("AgentChat — raw-terminal escape hatch", () => {
  afterEach(() => localStorage.clear());

  it("lifts a tail menu into buttons by default (grammars on)", async () => {
    renderChat({ text: MENU_TEXT });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
    // The raw option row is consumed into the button, not shown as text.
    expect(screen.queryByText(/❯ 1\. Yes/)).not.toBeInTheDocument();
  });

  it("shows the plain mirror (no buttons, menu as raw text) when raw terminal is on", () => {
    localStorage.setItem(
      "collie:display-prefs:v4",
      JSON.stringify({ wrap: true, fontSize: 11, rawTerminal: true }),
    );
    renderChat({ text: MENU_TEXT });
    // No native prompt buttons — the escape hatch bypasses the block grammars entirely…
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    // …and the menu is rendered verbatim in the mirror, drivable by the keys pad.
    expect(screen.getByText(/1\. Yes/)).toBeInTheDocument();
  });

  // "Tap to type" — on, the mirror is one big "start typing" target; off, it is a document. The
  // pref must gate ONLY the focus, never the mirror's own controls: someone who turned it off to
  // stop the keyboard appearing has not asked to lose the prompt buttons.
  it("focuses the composer on a mirror tap by default", async () => {
    renderChat({ text: "just some output\n" });
    const line = screen.getByText(/just some output/);
    fireEvent.click(line);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByPlaceholderText(/Type a reply/i)));
  });

  it("leaves focus alone on a mirror tap when Tap to type is off", async () => {
    localStorage.setItem(
      "collie:display-prefs:v4",
      JSON.stringify({ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: false }),
    );
    renderChat({ text: "just some output\n" });
    const before = document.activeElement;
    fireEvent.click(screen.getByText(/just some output/));
    expect(document.activeElement).toBe(before);
    expect(document.activeElement).not.toBe(screen.getByPlaceholderText(/Type a reply/i));
  });

  it("still lifts a menu into buttons with Tap to type off — it gates focus, not the grammars", async () => {
    localStorage.setItem(
      "collie:display-prefs:v4",
      JSON.stringify({ wrap: true, fontSize: 11, rawTerminal: false, tapToFocus: false }),
    );
    renderChat({ text: MENU_TEXT });
    expect(await screen.findByRole("button", { name: "Yes" })).toBeInTheDocument();
  });

  it("lifts a multi-question wizard into native controls by default (grammars on)", async () => {
    renderChat({ text: WIZARD_TEXT });
    expect(await screen.findByRole("button", { name: /Parser/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next step" })).toBeInTheDocument();
    // The stepper header row is consumed into the wizard block, not mirrored as text.
    expect(screen.queryByText(/☐ Focus area/)).not.toBeInTheDocument();
  });

  it("raw terminal bypasses the wizard too — the dialog shows verbatim, keys-pad drivable", () => {
    localStorage.setItem(
      "collie:display-prefs:v4",
      JSON.stringify({ wrap: true, fontSize: 11, rawTerminal: true }),
    );
    renderChat({ text: WIZARD_TEXT });
    expect(screen.queryByRole("button", { name: /Parser/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next step" })).not.toBeInTheDocument();
    expect(screen.getByText(/1\. Parser/)).toBeInTheDocument();
    expect(screen.getByText(/☐ Focus area/)).toBeInTheDocument();
  });
});

// A minimal permission dialog at the buffer tail — enough for the REAL detector (not a mock) to
// lift it into prompt-select buttons inside AgentChat's mirror.
const MENU_TEXT = [
  "Do you want to create hello.txt?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend",
].join("\n");

// A minimal Claude input-box buffer at the tail: top border, the "❯" prompt, bottom border, then the
// statusline + a hint. For a Claude pane, chrome-stripping peels the box off the mirror and the
// statusline is re-surfaced as the app strip; for a non-Claude pane none of that runs (raw mirror).
const RULE = "─".repeat(60);
const STATUS_TEXT = [
  "Welcome back!",
  "",
  RULE,
  "❯ ",
  RULE,
  "  [Opus 4.8] ~/webapp · main",
  "  ← for agents",
].join("\n");

// A minimal multi-question wizard tail (stepper header + current question) — enough for the REAL
// wizard detector to lift it into the native WizardBlock inside AgentChat's mirror.
const WIZARD_TEXT = [
  "←  ☐ Focus area  ☐ Scope  ✔ Submit  →",
  "",
  "Which focus area should we work on?",
  "",
  "❯ 1. Parser",
  "  2. UI",
  "",
  "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
].join("\n");

describe("AgentChat — prompt-select race guard wiring (frozen {text, revision} pair)", () => {
  const mockSubmit = vi.mocked(submitPromptOption);
  beforeEach(() => {
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
  });

  // Renders AgentChat inside a data router with EXTERNALLY-UPDATABLE pane props, standing in for the
  // route loader delivering fresh polls. Returns a setter that advances {text, revision} in place.
  function renderWithLivePane(initial: { text: string; revision: number }) {
    const agent = fixtureAgents[0]!; // a claude agent — the block grammars are gated on the agent
    let advance: (pane: { text: string; revision: number }) => void = () => {
      throw new Error("harness not mounted");
    };
    function Harness() {
      const [pane, setPane] = useState(initial);
      advance = setPane;
      return (
        <AgentChat
          paneId={agent.paneId}
          agent={agent}
          agents={fixtureAgents}
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
    return (pane: { text: string; revision: number }) => advance(pane);
  }

  it("passes the FROZEN revision when the mirror is frozen and the pane advances underneath", async () => {
    // Regression (found in review): the handler used to pass the LIVE loader revision, which keeps
    // advancing via background polls even while the mirror is frozen — so the guard compared
    // live-vs-live and could never catch drift that happened before the freeze. The menu the user
    // taps is derived from the FROZEN text, so the guard must get the revision frozen WITH it.
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });

    // The real detector lifted the tail menu into buttons.
    await screen.findByRole("button", { name: "Yes" });

    // Freeze the mirror (opening find pins the tail — the same `following=false` state a scroll-up
    // freeze produces). Find is a row in the pane menu now, so this goes through the ⋮.
    await openFind(user);

    // The pane advances while frozen: new output below the menu + a bumped revision.
    act(() => advance({ text: `${MENU_TEXT}\n● proceeding…\n`, revision: 2 }));

    // The frozen mirror still shows the old menu; the tap must hand the guard the FROZEN pair.
    await user.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 1 }));
  });

  it("passes the LIVE revision while following (the frozen pair is the live pair)", async () => {
    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: MENU_TEXT, revision: 1 });
    await screen.findByRole("button", { name: "Yes" });

    // Not frozen: a revision-only poll (same text) is adopted into the shown pair.
    act(() => advance({ text: MENU_TEXT, revision: 2 }));

    await user.click(screen.getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 2 }));
  });

  // Same frozen-pair guarantee for the wizard path (the guard mirrors prompt-select's; this locks the
  // wiring so the live-vs-frozen-revision bug can't regress here either).
  it("wizard: passes the FROZEN revision when the mirror is frozen and the pane advances", async () => {
    const mockWizard = vi.mocked(submitWizardKeys);
    mockWizard.mockReset();
    mockWizard.mockResolvedValue({ status: "sent" });

    const user = userEvent.setup();
    const advance = renderWithLivePane({ text: WIZARD_TEXT, revision: 1 });

    // The real detector lifted the multi-question tail into a wizard with option buttons.
    await screen.findByRole("button", { name: /Parser/ });

    await openFind(user); // freeze the tail
    act(() => advance({ text: `${WIZARD_TEXT}\n● advancing…\n`, revision: 2 }));

    await user.click(screen.getByRole("button", { name: /Parser/ }));

    await waitFor(() => expect(mockWizard).toHaveBeenCalledTimes(1));
    expect(mockWizard).toHaveBeenCalledWith(expect.objectContaining({ detectedRevision: 1 }));
  });
});

// The block grammars are provably scoped to the pane's own adapter (spec T8): an agent with no
// adapter gets the plain raw mirror — no prompt-select buttons, no chrome stripping, no re-surfaced
// status strip — because running Claude-tuned matchers on an unverified TUI could mis-lift or
// mis-strip its output. opencode is such an agent (codex graduated to its own adapter); omp has an
// adapter but lifts no dialog kind at all.
describe("AgentChat — block-grammar scoping (an agent with no adapter)", () => {
  // An opencode agent sharing the Claude fixture's ids, so only the agent kind differs from the default.
  const opencodeAgent = { ...fixtureAgents[0]!, agent: "opencode" };

  it("does NOT lift an adapterless agent's tail menu into buttons — it stays raw mirror text", () => {
    renderChat({ text: MENU_TEXT, agent: opencodeAgent });
    // No native prompt buttons: the Claude prompt-select grammar never runs without an adapter…
    expect(screen.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
    // …and the menu row shows verbatim in the raw mirror instead (drivable by the keys pad).
    expect(screen.getByText(/1\. Yes/)).toBeInTheDocument();
  });

  it("re-surfaces EVERY row of the Claude input-box statusline as an app strip above the composer", () => {
    renderChat({ text: STATUS_TEXT }); // default claude agent
    const strip = screen.getByText("[Opus 4.8] ~/webapp · main");
    expect(strip.closest("pre")).toBeNull(); // the strip is app chrome, not <pre> mirror text
    // Row 2 of the run: it used to be stripped off the mirror and rendered nowhere at all.
    const second = screen.getByText("← for agents");
    expect(second.closest("pre")).toBeNull();
    // Stacked in the one strip. Compared at the ROW level: each row renders one <span> per ANSI
    // segment (colour is carried through now), so the text node's own parent is a span, not the row.
    const row = (el: HTMLElement) => el.closest("div.truncate");
    expect(row(second)).not.toBe(row(strip));
    expect(row(second)?.parentElement).toBe(row(strip)?.parentElement);
    expect(screen.queryByText(/❯/)).toBeNull(); // the input box was stripped off the mirror
  });

  it("docks the pane-switch handle between the statusline and the composer, always", () => {
    // THE OPERATOR'S REPORT, verbatim: "the switch panel up drawer sits above the agent Statusline,
    // it should always be right above the bottom status row."
    //
    // It did. MEASURED in the browser on the pane screen at a true 390px viewport, page-relative
    // tops, with the agent's own statusline present (a 3-row Claude run):
    //
    //   BEFORE   mirror 217.8 → 629.8 · handle 629.8 → 663.8 · statusline 663.8 → 714 · composer 714
    //   AFTER    mirror 217.8 → 629.8 · statusline 629.8 → 680 · handle 680 → 714 · composer 714
    //
    // The handle stood 50px further up on a pane whose agent prints a statusline than on one that
    // does not — and it moved again whenever the agent added or dropped a row, because that strip
    // is 1–3 rows re-derived from the pane tail on every poll. A control the thumb reaches for by
    // muscle memory may not be relocated by something the terminal printed: DESIGN.md §2. "Always"
    // is the whole claim, so BOTH cases are asserted below, and the handle must be the last thing
    // before the composer in each.
    //
    // It also puts the statusline back against the mirror it was cut from — that strip is the
    // mirror's own last row, and a 34px grab handle wedged into the seam read as a boundary
    // between the terminal and a piece of chrome that IS the terminal.
    for (const text of [STATUS_TEXT, MENU_TEXT]) {
      const { container } = renderChat({ text });
      const handle = screen.getByRole("button", { name: "Switch pane" });
      const band = container.querySelector('[data-slot="composer-status"]')!;
      const composer = band.parentElement!;
      // Same parent, and the handle is the sibling immediately before the composer — so nothing,
      // statusline or otherwise, can ever get between the two.
      expect(handle.parentElement).toBe(composer.parentElement);
      expect(handle.nextElementSibling).toBe(composer);
      // …and where a statusline exists it is ABOVE the handle, welded to the mirror's bottom edge.
      const strip = screen.queryByText("[Opus 4.8] ~/webapp · main")?.closest("div.truncate")
        ?.parentElement;
      if (strip) {
        expect(strip.nextElementSibling).toBe(handle);
        expect(handle.previousElementSibling).toBe(strip);
      }
      cleanup();
    }
  });

  it("leaves an adapterless agent's input-box buffer fully raw — no status strip, box kept in the mirror", () => {
    renderChat({ text: STATUS_TEXT, agent: opencodeAgent });
    // The statusline is NOT hoisted into an app strip — it stays inside the raw <pre> mirror…
    const status = screen.getByText(/\[Opus 4\.8\] ~\/webapp · main/);
    expect(status.closest("pre")).not.toBeNull();
    // …and the input box itself is preserved verbatim (no chrome stripping for a non-Claude agent).
    expect(screen.getByText(/❯/)).toBeInTheDocument();
  });

  it("strips Grok's composer box and hoists the bottom-border status into the app strip", () => {
    const grokBox = [
      "Sandbox transcript",
      "",
      `  ╭${"─".repeat(60)}╮`,
      "  │ ❯ testing stuff                                                     │",
      `  ╰${"─".repeat(28)} Local Llama (xhigh) · plan ─╯`,
      "",
      "  Shift+Tab:mode  │  Ctrl+.:shortcuts",
    ].join("\n");
    const grokAgent = { ...opencodeAgent, agent: "grok", paneId: "w9:p5" };
    renderChat({ text: grokBox, agent: grokAgent });
    const strip = screen.getByText("Local Llama (xhigh) · plan");
    expect(strip.closest("pre")).toBeNull();
    expect(strip.textContent).toBe("Local Llama (xhigh) · plan");
    expect(screen.queryByText(/Shift\+Tab:mode/)).toBeNull();
    expect(screen.queryByText("╭")).toBeNull();
  });
});

// Regression (user-reported on mobile): tapping a native prompt/wizard/preview option button popped
// the phone keyboard. Those buttons live INSIDE the terminal-mirror div, whose onClick focuses the
// composer (the "tap the mirror to start typing" affordance) — so an option tap bubbled up and
// focused the input, opening the soft keyboard over the output. focusFromMirror must ignore taps
// that land on an interactive control, while still focusing on a tap of the raw terminal text.
describe("AgentChat — mirror tap must not pop the keyboard on option taps", () => {
  const mockSubmit = vi.mocked(submitPromptOption);
  beforeEach(() => {
    mockSubmit.mockReset();
    mockSubmit.mockResolvedValue({ status: "sent" });
  });

  it("does NOT focus the composer when a native prompt option is tapped", async () => {
    const user = userEvent.setup();
    renderChat({ text: MENU_TEXT });
    const box = screen.getByPlaceholderText(/type a reply/i);
    const yes = await screen.findByRole("button", { name: "Yes" });

    await user.click(yes);
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(box).not.toHaveFocus();
  });

  it("DOES still focus the composer when the raw mirror text is tapped", async () => {
    const user = userEvent.setup();
    renderChat({ text: "recent pane output" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    await user.click(screen.getByText("recent pane output"));
    await waitFor(() => expect(box).toHaveFocus());
  });

  it("focuses during the tap event so mobile browsers can open the software keyboard", () => {
    renderChat({ text: "recent pane output" });
    const box = screen.getByPlaceholderText(/type a reply/i);

    fireEvent.click(screen.getByText("recent pane output"));

    expect(box).toHaveFocus();
  });
});

// Connection copy now lives in the single top ConnectionBanner (mounted in RootLayout), not in the
// header — so the pane header has no pill. What it still owns: the agent StatusBadge, which shows the
// LAST snapshot's status and must stop reading as current during an outage (it dims on any not-live).
describe("AgentChat — shared header: stale-status dimming", () => {
  beforeEach(() => __resetConnectionHealth());

  it("dims the agent StatusBadge while the connection is not live and restores it on recovery", () => {
    // fixtureAgents[0] is a blocked claude agent → StatusBadge reads "needs you".
    let setError: (e: boolean) => void = () => {};
    function Harness() {
      const [error, setErr] = useState(true);
      setError = setErr;
      const agent = fixtureAgents[0]!;
      return (
        <AgentChat
          paneId={agent.paneId}
          agent={agent}
          agents={fixtureAgents}
          shellPanes={[]}
          tabs={[]}
          text="out"
          error={error}
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }
    const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<Harness />) }]);
    render(<RouterProvider router={router} />);

    const badge = screen.getByText("needs you");
    expect(badge).toHaveClass("opacity-40"); // not live → frozen status dimmed
    act(() => setError(false)); // snapshot recovers → live
    expect(badge).not.toHaveClass("opacity-40"); // undimmed instantly
  });
});

// The History affordance opens the agent's own transcript — the only real scrollback a Claude pane
// has, because its terminal runs on the alternate screen and Herdr retains nothing behind the
// viewport. It's gated on the pane actually reporting an agent session, so the button can never
// lead to an empty screen.
describe("AgentChat \u2014 the pane menu in the header", () => {
  /** The header's own row \u2014 the screen below it is full of buttons, so every query here is scoped. */
  const headerRow = (container: HTMLElement) =>
    container.querySelector<HTMLElement>("header > div:last-child")!;

  // THE POINT OF THE CHANGE. Two icons became one control; the row must not carry find or history as
  // controls of its own any more. Asserted over the header row's whole button list, so a stray third
  // control added later fails here rather than on a phone.
  it("no longer renders Find and History as separate header controls", () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    const { container } = renderChat({ agent, agents: [agent] });
    const title = screen.getByRole("button", { name: /open webapp overview/i });
    const after = Array.from(headerRow(container).querySelectorAll("button")).filter(
      (b) => title.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(after.map((b) => b.getAttribute("aria-label"))).toEqual(["Pane actions"]);
  });

  // The glyph is a \u22ee and names nothing on its own, so the accessible name is the whole of what a
  // screen reader gets. It has to say what the control OPENS.
  it("gives the one control an accessible name that says what it opens", () => {
    renderChat();
    const menu = screen.getByRole("button", { name: "Pane actions" });
    expect(menu).toBeInTheDocument();
    // 44px, stated \u2014 the drawn box IS the hit box here (no negative margin pulling it back).
    expect(menu.className).toContain("size-11");
  });

  // \u00a72: no state may move content. Opening the menu must not touch the row that triggered it \u2014
  // the sheet is a fixed overlay mounted OUTSIDE the header, so the row's own box is untouched.
  it("leaves the header row's geometry alone when the menu opens", async () => {
    const user = userEvent.setup();
    const { container } = renderChat();
    const before = headerRow(container).className;
    expect(before).toContain("min-h-15"); // the 60px floor \u2014 app-header.tsx states it once
    await openPaneMenu(user);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const row = headerRow(container);
    expect(row.className).toBe(before);
    // The sheet is not INSIDE the header \u2014 ui/sheet.tsx uses no portal, so a sheet mounted in the
    // sticky header would be positioned and stacked against it instead of the viewport.
    expect(container.querySelector("header")!.contains(screen.getByRole("dialog"))).toBe(false);
  });

  it("offers History behind the menu when the pane reports an agent session id", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    renderChat({ agent, agents: [agent] });
    expect(screen.queryByRole("button", { name: /conversation history/i })).not.toBeInTheDocument();
    await openPaneMenu(user);
    expect(screen.getByRole("button", { name: /conversation history/i })).toBeInTheDocument();
  });

  it("hides the History row when the pane has no agent session (a shell, or a harness without one)", async () => {
    const user = userEvent.setup();
    renderChat(); // fixture agents carry no session
    await openPaneMenu(user);
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // the menu really did open
    expect(screen.queryByRole("button", { name: /conversation history/i })).not.toBeInTheDocument();
  });

  // The row must reach the SAME route the header icon reached \u2014 that is the whole of what moved.
  it("navigates History to the pane's transcript route", async () => {
    const user = userEvent.setup();
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    const props: ComponentProps<typeof AgentChat> = {
      paneId: agent.paneId,
      agent,
      agents: [agent],
      shellPanes: [],
      tabs: [],
      text: "recent pane output",
      onBack: vi.fn(),
      onSelect: vi.fn(),
    };
    const router = createMemoryRouter([
      { path: "/", element: withHeaderHost(<AgentChat {...props} />) },
      { path: "/pane/:paneId/history", element: <div>transcript route</div> },
    ]);
    render(<RouterProvider router={router} />);
    await openPaneMenu(user);
    await user.click(screen.getByRole("button", { name: /conversation history/i }));
    expect(await screen.findByText("transcript route")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/pane/${encodeURIComponent(agent.paneId)}/history`);
  });

  // THE FIND PATH, end to end, because it is the one that spans three components. The row closes the
  // sheet and opens find in ONE React event: the sheet's focus-restore (aimed at the \u22ee, which the
  // takeover has just removed) must lose to the find bar's own mount focus, or a one-handed operator
  // gets a sheet-shaped animation and no keyboard.
  it("opening Find from the menu takes the header row over, with focus in the field", async () => {
    const user = userEvent.setup();
    const { container } = renderChat();
    await openFind(user);
    // The sheet is gone \u2026
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // \u2026 the find bar owns the whole row (the identity block and the \u22ee are both out of it) \u2026
    const field = screen.getByRole("textbox", { name: /find in output/i });
    expect(headerRow(container).contains(field)).toBe(true);
    expect(screen.queryByRole("button", { name: "Pane actions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open webapp overview/i })).not.toBeInTheDocument();
    // \u2026 and it is focused, so the phone keyboard is already up.
    expect(document.activeElement).toBe(field);
  });

  // The takeover happens INSIDE the one hoisted shell (app-header.tsx): the header element itself is
  // mounted above the outlet and is not the route's to replace. Opening and closing find therefore
  // swaps the row's CONTENTS and nothing else — the same <header>, the same prerelease strip, the
  // same 60px floor. A find bar that mounted a header of its own would pass every assertion in the
  // case above and fail this one.
  it("takes the row over inside the one shell, not by mounting a header of its own", async () => {
    const user = userEvent.setup();
    const { container } = renderChat();
    const shell = container.querySelector("header");
    const row = container.querySelector('[data-slot="header-row"]');
    const recipe = row?.className;
    await openFind(user);
    expect(document.querySelectorAll("header")).toHaveLength(1);
    expect(container.querySelector("header")).toBe(shell);
    expect(container.querySelector('[data-slot="header-row"]')).toBe(row);
    expect(row?.className).toBe(recipe); // the row's box is the shell's, not the find bar's
    await user.click(screen.getByRole("button", { name: /close find/i }));
    expect(container.querySelector("header")).toBe(shell);
  });

  // The status word has left this row entirely — it stands on the composer's status strip now. What
  // the header row still owes is its ORDER: the identity leads and the one action follows it. The
  // word's own absence here is asserted rather than assumed, because "the header got quieter" is
  // exactly the kind of change that silently takes a state report with it.
  it("holds the identity ahead of the menu, and holds no status word at all", () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true };
    const { container } = renderChat({ agent, agents: [agent] });
    const menu = screen.getByRole("button", { name: "Pane actions" });
    const title = screen.getByRole("button", { name: /open webapp overview/i });
    expect(title.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(headerRow(container).textContent).not.toContain("needs you");
    // …and it is not simply missing: it is one row down, at the surface being typed into.
    expect(container.querySelector('[data-slot="composer-status"]')?.textContent).toContain(
      "needs you",
    );
  });
});

// The top-of-mirror affordance. This block previously rendered on NO pane at all: it was gated on
// `truncated`, which Herdr never sets true even when a read demonstrably cut scrollback off. The
// working signal is `readableLines` (scrollback depth + viewport), and which button appears is
// decided by what the pane can actually offer — the two are never simultaneously possible.
describe("AgentChat — top-of-mirror history affordance", () => {
  const showHistory = () => screen.queryByRole("button", { name: /show entire history/i });
  const loadOlder = () => screen.queryByRole("button", { name: /load older/i });

  it("an agent pane with a transcript offers the full history, not scrollback paging", () => {
    // A Claude pane: alt-screen, so readableLines is just its viewport — there IS no scrollback.
    const agent = { ...fixtureAgents[0]!, hasSession: true, readableLines: 51 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(showHistory()).toBeInTheDocument();
    expect(loadOlder()).not.toBeInTheDocument();
  });

  it("a pane with real scrollback and no transcript offers Load older", () => {
    // A shell on the primary screen: 6895 lines of ring + 51 viewport, and we've only asked for 600.
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("offers nothing when the pane has neither", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 51 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).not.toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("hides Load older once the window already covers everything Herdr can return", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const, readableLines: 700 };
    renderChat({ agent, agents: [agent], requestedLines: 1000 }); // at the cap, past the content
    expect(loadOlder()).not.toBeInTheDocument();
  });

  it("stays hidden when readableLines is unknown (older bridge) rather than offering a dud tap", () => {
    const agent = { ...fixtureAgents[0]!, kind: "shell" as const }; // no readableLines
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(loadOlder()).not.toBeInTheDocument();
    expect(showHistory()).not.toBeInTheDocument();
  });

  it("a transcript wins even when the pane also reports scrollback", () => {
    const agent = { ...fixtureAgents[0]!, hasSession: true, readableLines: 6946 };
    renderChat({ agent, agents: [agent], requestedLines: 600 });
    expect(showHistory()).toBeInTheDocument();
    expect(loadOlder()).not.toBeInTheDocument();
  });
});

// EXPLAIN, don't hide, one level below the multiplexer note (#137). `hasSession` folds two facts
// into one flag, so its absence is silent about which half failed: an agent that CAN keep a session
// log and reported none is the operator's to fix (the `herdr integration install` hook), while an
// agent with no journal adapter has nothing to say. The line is prose, never a control — there is
// still no transcript to open.
describe("AgentChat — no session reported", () => {
  const noSessionNote = () => screen.queryByText(/has not reported a session to Herdr/i);

  it("explains the silence on an agent that could have a transcript but reported none", () => {
    const agent = { ...fixtureAgents[0]!, agent: "claude" }; // journal adapter, no hasSession
    renderChat({ agent, agents: [agent] });
    const note = noSessionNote();
    expect(note).toBeInTheDocument();
    expect(note).toHaveTextContent(/^claude /);
    // Prose, not an affordance: nothing here is tappable, and the history button stays absent.
    expect(note?.closest("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /show entire history/i })).not.toBeInTheDocument();
  });

  it("says nothing once the pane has reported a session", () => {
    const agent = { ...fixtureAgents[0]!, agent: "claude", hasSession: true };
    renderChat({ agent, agents: [agent] });
    expect(noSessionNote()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show entire history/i })).toBeInTheDocument();
  });

  it("says nothing for an agent with no journal adapter — there is no transcript to promise", () => {
    const agent = { ...fixtureAgents[0]!, agent: "omp" }; // block grammars, no journal
    renderChat({ agent, agents: [agent] });
    expect(noSessionNote()).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TIER 2 — the pane's MACHINE is quiet, the phone's link is fine (M5/03).
//
// Everything here is about one distinction: a peer outage degrades THIS pane and says so, while the
// app-wide connection surfaces (banner, header dog, polling) belong to tier 1 and stay out of it.
// ─────────────────────────────────────────────────────────────────────────────

const packRoster: ServerSummary[] = [
  { id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 5_000 },
  // Reachable-but-long-unseen would be equally stale; unreachable is the case the operator meets.
  { id: "workshop", name: "workshop", isLead: false, reachable: false, protocol: "ok", lastSeenAt: 1_000 },
  {
    id: "attic",
    name: "attic",
    isLead: false,
    reachable: false,
    protocol: "incompatible",
    protocolDetail: "pack protocol 2 (this collie speaks 1)",
    lastSeenAt: 0,
  },
];

/** As above, but inside a pack whose lead assembled the snapshot at `ts` (the lead's own clock). */
function renderPackChat(host: string, overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const agent = { ...fixtureAgents[0]!, host };
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId,
    scope: { host },
    agent,
    agents: [agent],
    shellPanes: [],
    tabs: [],
    text: "output from before it went quiet",
    onBack: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([
    {
      path: "/",
      element: withHeaderHost(
        <PackProvider servers={packRoster} ts={20_000} pollMs={1500}>
          <AgentChat {...props} />
        </PackProvider>,
      ),
    },
  ]);
  const { container } = render(<RouterProvider router={router} />);
  return { props, container };
}

describe("AgentChat — a pane on a host the lead can't reach", () => {
  it("keeps showing the last known mirror, attributed to the machine by name", () => {
    renderPackChat("workshop");
    // Never blank, never a spinner: the content is real, it is just not current.
    expect(screen.getByText(/output from before it went quiet/)).toBeInTheDocument();
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/workshop is unreachable/i);
    expect(notice).toHaveTextContent(/last known/i);
  });

  it("says a write will be refused — before the user taps Send to find out", () => {
    renderPackChat("workshop");
    expect(screen.getByRole("status")).toHaveTextContent(/refused/i);
    // The composer names the machine rather than the generic read-only reason.
    expect(screen.getByPlaceholderText(/workshop is unreachable/i)).toBeDisabled();
    expect(screen.queryByPlaceholderText(/type a reply/i)).not.toBeInTheDocument();
  });

  it("refuses the reply BEFORE any request is made (§10.3 — no queue, no retry)", async () => {
    const calls: string[] = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/(reply|keys)$/, ({ request }) => {
        calls.push(request.url);
        return HttpResponse.json({ ok: true });
      }),
    );
    renderPackChat("workshop");
    const box = screen.getByPlaceholderText(/workshop is unreachable/i);
    // Disabled, so the user can't even get text in — and Send is off with it. The point of asserting
    // the network too is that nothing routes around the disabled state.
    expect(box).toBeDisabled();
    expect(screen.getByLabelText("Send")).toBeDisabled();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });

  it("gives an incompatible member its own reason, verbatim", () => {
    renderPackChat("attic");
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent(/attic is running an incompatible Collie/i);
    expect(notice).toHaveTextContent(/pack protocol 2 \(this collie speaks 1\)/);
    // Never seen at all → there is no last-good screen under the banner, and it says so rather than
    // implying the empty mirror is the machine's real state.
    expect(notice).toHaveTextContent(/nothing cached/i);
  });

  it("a live host in the same pack is completely untouched", () => {
    renderPackChat("bluefin");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type a reply/i)).not.toBeDisabled();
  });
});

// The folder tab opens onto the PAGE, and the mirror draws its own top edge clear of it.
//
// A coupling test in the DESIGN.md §9 sense: the rule spans two files and an edit to either one
// looks complete on its own. `tab-strip.tsx` owns the baseline the active tab hangs off (a
// `border-b` in --rule that the tab's 1px cover strip paints over for its own width); this file
// owns the surface underneath. The terminal ground is byte-identical to `--background` in BOTH
// themes on purpose (index.css:44-48), so with the mirror flush against that baseline the tab had
// no floor and read as bleeding into the terminal — and a rule added flush from below would have
// been a second hairline on the same line, in the one pixel the tab covers.
//
// The three values below are one set. The gap is what makes the mirror's rule a second boundary
// rather than a doubled one; `pt-0` is what pays for it (ChatMessageList's own base is `py-4`, so
// merely dropping the override lets 16px back in, not 0). Verified to fail in both directions:
// remove the margin and the doubling assertion trips; restore the scroller's top padding and the
// last one does.
describe("AgentChat — the mirror's top edge", () => {
  // `div[role="presentation"]`, not `[role="presentation"]`: the Collie mark's SVG carries the same
  // role, and an SVG's `className` is an SVGAnimatedString rather than a string — the assertion then
  // fails on the wrong element with a type error instead of a diff.
  function mirrorAndTabs(container: HTMLElement) {
    const mirror = [...container.querySelectorAll<HTMLElement>('div[role="presentation"]')].find(
      (el) => el.querySelector(".overflow-y-auto"),
    );
    const nav = screen.getByRole("navigation", { name: /tabs/i });
    return { mirror, nav };
  }

  it("draws the mirror's own rule, set clear of the tab strip's baseline", () => {
    const { container } = renderChat({ tabs: fixtureTabs });
    const { mirror, nav } = mirrorAndTabs(container);

    // The tab strip still owns the baseline, from above, and only that.
    expect(nav?.className).toMatch(/\bborder-b\b/);
    expect(nav?.className).not.toMatch(/\bborder-t\b/);

    // The mirror announces itself with the structural line, not the component line.
    expect(mirror?.className).toMatch(/\bborder-t\b/);
    expect(mirror?.className).toMatch(/\bborder-rule\b/);

    // …and it is set down off the baseline, so the two rules are two boundaries and never one.
    expect(mirror?.className).toMatch(/\bmt-\d/);
  });

  it("keeps the scroller's top padding at zero, which is what bought the rule", () => {
    const { container } = renderChat({ tabs: fixtureTabs });
    const { mirror } = mirrorAndTabs(container);
    const scroller = mirror?.querySelector<HTMLElement>(".overflow-y-auto");

    // `pt-0` stated, not merely absent: the base `py-4` is still on the element and Tailwind's own
    // sheet order is what lets the later `pt-0` beat it, so dropping the class restores 16px.
    expect(scroller?.className).toMatch(/\bpt-0\b/);
    expect(scroller?.className).toMatch(/\bpb-3\b/);
  });
});
