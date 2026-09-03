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
import { setZenEnabled, __resetZen } from "@/lib/zen";
import { setStripsCollapsed, __resetStripsCollapsed } from "@/lib/strips-collapsed";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { submitPromptOption } from "@/lib/prompt-action";
import { submitWizardKeys } from "@/lib/wizard-action";
import { fixtureAgents, fixtureShellPanes, fixtureTabs } from "@/test/handlers";
import { PackProvider } from "./pack-provider";
import type { AgentStatus, AgentView, ServerSummary, TabView } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { COLLAPSE_MS } from "./ui/collapse";
import { AgentChat } from "./agent-chat";

// The detail view's core job: type a reply and submit it to the bridge. This drives the whole wired
// path (composer → api.sendReply → MSW → optimistic clear / error surfacing) end-to-end, which no
// other test covers. AgentChat uses useRevalidator, so it needs a data router (createMemoryRouter).

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll calls it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  // Zen's availability is a module-scoped, localStorage-backed store — one case turning it on would
  // otherwise leave every later case rendering a menu row it never asked for.
  __resetZen();
  // Same shape, same reason: a case that folds the strips would otherwise leave every later case
  // rendering a bead bar it never asked for.
  __resetStripsCollapsed();
  // Same shape once more: launchers.toml's rows are cached for the life of the page (one successful
  // /api/config read), so a case that declares launchers would otherwise leak them into every case
  // that comes after it.
  __resetOperatorCommands();
});

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
    const row = container.querySelector<HTMLElement>('header [data-slot="header-row"]');
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

  // LINE 1 NAMES A TAB, THE DOT BESIDE IT REPORTS A PANE — and only on the fallback branch, which is
  // exactly the branch a multi-pane tab lands on. So the header could read "this tab is done" while
  // only the open pane is done. The fix names the PANE and leaves the dot per-pane: the mirror, the
  // composer and the dot on this screen all scope to one pane, and the dot ladder elsewhere
  // (pane strip per pane, tab strip worst-in-tab, space strip worst-in-space) is right as it stands.
  //
  // `base` has no paneLabel and no sessionName, so its name is the `space › tab` fallback.
  const solo = fixtureAgents[0]!; // w1:p1, workspaceLabel "webapp", tab w1:t1
  const sibling: AgentView = { ...solo, paneId: "w1:p7", status: "working" };

  it("appends the pane's own suffix to the fallback name when the tab holds several panes", () => {
    const { container } = renderChat({ agent: solo, agents: [solo, sibling] });
    // The suffix is `lib/pane-tag.ts`'s rule — the trailing segment of the pane id — and it is the
    // same string the pill row below prints, which is the whole reason it discriminates: the reader
    // matches the header to a pill without being told to.
    expect(slot(container, "tag")?.textContent).toBe("p1");
    // And it is its OWN span, not glued onto the name. A joined string tail-truncates at 390px, so
    // the one part that discriminates would be the first part to disappear (lib/pane-name.ts states
    // the same rule one level down). The name gives up width; the suffix is `shrink-0`.
    expect(slot(container, "name")?.textContent).toBe("webapp");
    expect(slot(container, "tag")?.className).toMatch(/(^|\s)shrink-0(?=\s|$)/);
  });

  it("keeps the clean name when the tab holds ONE pane", () => {
    // Nothing to disambiguate: the tab's name effectively names the pane, and PaneStrip renders no
    // pill row below for a suffix to be matched against. Both facts come off the same list, on
    // purpose — a header decorated over an absent pill row is the failure that would look like.
    const { container } = renderChat({ agent: solo, agents: [solo] });
    expect(slot(container, "tag")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Panes" })).toBeNull();
  });

  it("never decorates a name the operator or the agent chose, even in a multi-pane tab", () => {
    // A `pane.rename` label and Claude's own `/rename` session name each name THIS PANE already, so
    // there is no tab/pane mismatch to correct — appending an id would only add noise to a string
    // somebody picked deliberately.
    const labelled = { ...solo, paneLabel: "logs" };
    const { container: byLabel } = renderChat({ agent: labelled, agents: [labelled, sibling] });
    expect(slot(byLabel, "name")?.textContent).toBe("logs");
    expect(slot(byLabel, "tag")).toBeNull();

    const session = { ...solo, sessionName: "refactor the parser" };
    const { container: bySession } = renderChat({ agent: session, agents: [session, sibling] });
    expect(slot(bySession, "name")?.textContent).toBe("refactor the parser");
    expect(slot(bySession, "tag")).toBeNull();
  });

  it("adds the suffix without growing line 1, so the header row does not grow on this route alone", () => {
    // The coupling the two-line test above pins, restated for the one element that can break it: the
    // block is a SUM of line boxes (20 + 4 + 12) and app-header.tsx's row floor is sized against it.
    // A span with no stated line-height inherits the body's 1.45 strut, which takes line 1 past 20px
    // and grows the header on the pane route only — the route-local jump `min-h-15` exists to kill.
    const { container } = renderChat({ agent: solo, agents: [solo, sibling] });
    const box = (name: string, cls: string) => {
      const m = /(?:^|\s)leading-(\d+)(?=\s|$)/.exec(cls);
      expect(m, `leading-* on the ${name} span, in "${cls}"`).not.toBeNull();
      return Number(m![1]) * 4; // Tailwind's --spacing is 0.25rem, and the app's root is 16px
    };
    expect(box("tag", slot(container, "tag")?.className ?? "")).toBe(
      box("name", slot(container, "name")?.className ?? ""),
    );
    // And it rides ON line 1 rather than becoming a line of its own — same parent as the name, so
    // the block stays the run of boxes the floor was sized against. (The cwd line is absent here:
    // `~/webapp` under the name `webapp` is the same word twice, which the gate above covers.)
    expect(slot(container, "tag")?.parentElement).toBe(slot(container, "name")?.parentElement);
  });
});

describe("AgentChat — read-only device", () => {
  it("disables the composer and shows the banner when the device isn't authorised", () => {
    renderChat({ device: { enforced: true, device: "spare-phone", authorized: false } });

    // The strip names the read-only state and the composer is locked. It no longer spells the
    // device id: a strip never wraps, so it carries the short copy (read-only-banner.tsx says why,
    // and its own test pins the trade). The fact is still stated at the point of refusal below —
    // the placeholder — which is the stronger of the two places.
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.queryByText(/spare-phone/)).toBeNull();
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
      // ROW IDENTITY, NOT ELEMENT IDENTITY. The handle now stands inside a `Collapse` — it stands
      // down while the soft keyboard is up — so its element is two wrappers deep. `Collapse` is a
      // presence animation and nothing else (it "styles NOTHING", per its header), so the ROW in
      // this column is the wrapper, and that is what the adjacency claim is about. Asserted through
      // it rather than around it: the wrapper must be found, so a handle that quietly escaped its
      // Collapse fails here too.
      const handleRow = handle.closest('[data-slot="collapse"]')!;
      expect(handleRow).not.toBeNull();
      // Same parent, and the handle's row is the sibling immediately before the composer — so
      // nothing, statusline or otherwise, can ever get between the two.
      expect(handleRow.parentElement).toBe(composer.parentElement);
      expect(handleRow.nextElementSibling).toBe(composer);
      // THAT SHARED PARENT IS THE CHROME BLOCK, and it is what answers the operator's later report
      // that the drawer was "really hard to distinguish" in dark. The handle used to stand on the
      // mirror's own black — `--background` IS the mirror's fill in dark (mirror-space.ts) — so a
      // 6px grip was the only thing on screen saying a control was there. The block gives the handle
      // and the composer ONE ground and closes it against the terminal with ONE rule, above
      // everything the thumb operates. Its fill and rule are unconditional; the handle inside it is
      // not, so the seam is one hairline whether or not there is a pane to switch to (DESIGN.md §4).
      const block = handleRow.parentElement!;
      expect(block.getAttribute("data-slot")).toBe("chrome-block");
      // --chrome, and NOT --muted: DESIGN.md §4 forbids --muted behind chrome, and the value it
      // carried in dark (rgb 38, under a rgb 10 terminal) was read as a bright slab. --chrome is the
      // raised surface the sheets already stand on.
      expect(block.className).toMatch(/(?:^|\s)bg-chrome(?=\s|$)/);
      expect(block.className).not.toMatch(/(?:^|\s)bg-muted(?=\s|$)/);
      expect(block.className).toMatch(/(?:^|\s)border-t border-rule(?=\s|$)/);
      // …and the composer's own dock draws neither, so the two never double the line.
      expect(composer.className).not.toMatch(/(?:^|\s)border/);
      // …and where a statusline exists it is ABOVE the block, welded to the mirror's bottom edge.
      // The handle is the FIRST thing inside the block, so it is still the first chrome the thumb
      // meets coming up from the terminal.
      const strip = screen.queryByText("[Opus 4.8] ~/webapp · main")?.closest("div.truncate")
        ?.parentElement;
      if (strip) {
        // Same reading as above: the statusline stands down with the keyboard too, so its row in
        // this column is its own Collapse wrapper.
        expect(strip.closest('[data-slot="collapse"]')!.nextElementSibling).toBe(block);
        expect(block.firstElementChild).toBe(handleRow);
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
    container.querySelector<HTMLElement>('header [data-slot="header-row"]')!;

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

// Closing the in-pane TabStrip's CURRENT tab used to read as "leave the pane view" (onBack ->
// dashboard). It must instead read as closing a browser tab: land on another tab of the same space,
// via closeCurrentTab's goToTab-style resolution, and only fall back to onBack() when the space has
// nothing left to land on. Each test drives the real two-tap close UI (long-press -> "Close tab" ->
// confirm) so the wiring from TabStrip's onClosed through to onSelect/onBack is exercised end to end,
// not just the helper in isolation.
describe("AgentChat — closing the current tab", () => {
  // A folder tab's accessible name is its (optional) status word immediately followed by its label
  // — e.g. "workingcode" for a tab named "code" with a working agent inside (tab-strip.tsx renders
  // an sr-only status word ahead of the label with no separating whitespace). Match on the label
  // trailing the name rather than the name in full, so a test doesn't have to track each fixture's
  // triage status.
  async function closeTab(user: User, label: string, confirmName: RegExp | string) {
    fireEvent.contextMenu(screen.getByRole("button", { name: new RegExp(`${label}$`) }));
    await user.click(screen.getByRole("button", { name: "Close tab" }));
    await user.click(screen.getByRole("button", { name: confirmName }));
  }

  it("moves to the neighbouring tab in the strip's own order, not the dashboard", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onSelect = vi.fn();
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
    );
    // w2 has two tabs (fixtureTabs): "code" (w2:t1, the current pane's tab) and "shell" (w2:t2,
    // fixtureShellPanes' pane). Closing "code" — the current tab, and the FIRST of the two — must
    // land on its one neighbour, "shell", not eject to Home.
    renderChat({
      agent: fixtureAgents[1], // w2:p1, tabId w2:t1 ("code")
      agents: fixtureAgents,
      shellPanes: fixtureShellPanes, // w2:p2, tabId w2:t2 ("shell")
      tabs: fixtureTabs,
      onBack,
      onSelect,
    });

    await closeTab(user, "code", "Tap again to close 1 pane");

    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("w2:p2"));
    expect(onBack).not.toHaveBeenCalled();
    // …AND IT SAYS SO. Closing the tab you are IN navigates, so the ✓ on the tapped control is
    // drawn inside a strip that is unmounting, on a screen the operator is leaving — an
    // acknowledgement nobody can be looking at. `createTab` takes a status for exactly this reason
    // (lib/ack-manifest.ts) and this path is the same shape. Every status publish also turns the
    // mark's orbit one round, which is the half the operator noticed was missing.
    expect(await screen.findByText("Tab closed")).toBeInTheDocument();
  });

  it("closing the LAST tab in the strip falls back to the previous one", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onSelect = vi.fn();
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
    );
    const agentIn = (paneId: string, tabId: string): AgentView => ({
      paneId,
      workspaceId: "w2",
      workspaceLabel: "collie",
      workspaceNumber: 2,
      tabId,
      agent: "claude",
      status: "idle",
      cwd: "/home/you/collie",
      focused: false,
    });
    const threeTabs: TabView[] = [
      { tabId: "w2:t1", workspaceId: "w2", number: 1, label: "a", focused: false, paneCount: 1 },
      { tabId: "w2:t2", workspaceId: "w2", number: 2, label: "b", focused: false, paneCount: 1 },
      { tabId: "w2:t3", workspaceId: "w2", number: 3, label: "c", focused: true, paneCount: 1 },
    ];
    const current = agentIn("w2:p3", "w2:t3");
    renderChat({
      agent: current,
      agents: [agentIn("w2:p1", "w2:t1"), agentIn("w2:p2", "w2:t2"), current],
      shellPanes: [],
      tabs: threeTabs,
      onBack,
      onSelect,
    });

    // "c" (w2:t3) is last in the strip's own order, so there is no next tab — the previous one, "b"
    // (w2:t2), is what a browser tab bar would land on.
    await closeTab(user, "c", "Tap again to close 1 pane");

    await waitFor(() => expect(onSelect).toHaveBeenCalledExactlyOnceWith("w2:p2"));
    expect(onBack).not.toHaveBeenCalled();
  });

  it("falls back to onBack() when the space has no other tab to go to", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const onSelect = vi.fn();
    server.use(
      http.post(/\/api\/tab\/[^/]+\/close$/, () => HttpResponse.json({ ok: true })),
    );
    // w1 (fixtureAgents[0], tabId w1:t1) has exactly one tab — fixtureTabs' w1 entry.
    renderChat({
      agent: fixtureAgents[0],
      tabs: [fixtureTabs[0]!],
      onBack,
      onSelect,
    });

    await closeTab(user, "1", "Tap again to close 1 pane");

    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(onSelect).not.toHaveBeenCalled();
    // Both exits from `closeCurrentTab` say it, because it is the same fact either way: the tab you
    // were in is gone and you are somewhere else now. A status on only one branch would be silent on
    // the more disorienting of the two.
    expect(await screen.findByText("Tab closed")).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BOTTOM FITS THE SCREEN IT IS ON — and the screen is measured, never assumed.
//
// The operator's report: "here for example the bottom is cut off, and when the keyboard is open…".
// It is arithmetic, not a padding bug. The route column is `h-[100dvh]` (routes/root.tsx). Inside
// it the mirror carries `min-h-0 flex-1`, so the mirror is the row that gives — and it gives all
// the way to zero. Everything below it is content-sized, so once the mirror is at zero the surplus
// paints past the bottom edge of the viewport, under the soft keyboard, and the send button becomes
// unreachable. With the keyboard up a phone has ~440px of page and the un-shrinkable rows wanted
// ~454px.
//
// The repair is NOT to let the bottom shrink — nothing inside it scrolls, so it would clip the
// composer instead of overflowing it, which is the same loss with a tidier edge. The repair is to
// BOUND the two parts of it that grow, and to bound them as a fraction of the viewport rather than
// at a constant. `dvh` already tracks the soft keyboard, because the viewport meta is
// `interactive-widget=resizes-content` (hooks/use-keyboard.ts says so from the other side), so one
// unit does the job on every device instead of encoding one phone's pixels.
//
// These three assertions are the whole argument, and each one fails on the edit that would undo it.
// ─────────────────────────────────────────────────────────────────────────────
describe("the pane fits its viewport", () => {
  it("holds the bottom region's size and bounds what grows inside it — never the reverse", () => {
    const { container } = renderChat({ text: STATUS_TEXT });
    const block = container.querySelector('[data-slot="chrome-block"]')!;
    const bottom = block.parentElement!;
    // ROW IDENTITY, NOT ELEMENT IDENTITY — the same reading the docking test above states. The whole
    // bottom region now stands inside a `Collapse`: it leaves as one row when zen hides the chrome.
    // `Collapse` is a presence animation and styles NOTHING, so the ROW in this flex column is that
    // wrapper, and the adjacency claim is about the row. Asserted through it rather than around it:
    // the wrapper must be found, so a bottom region that quietly escaped its Collapse fails here too.
    const bottomRow = bottom.closest('[data-slot="collapse"]')!;
    expect(bottomRow).not.toBeNull();
    // The mirror is the bottom row's own previous sibling — taken that way rather than by a
    // selector, so this asserts the ADJACENCY the argument rests on instead of merely finding two
    // elements that happen to match.
    const mirror = bottomRow.previousElementSibling!;

    // The two are flex siblings in the same column: one gives, one does not.
    expect(mirror.getAttribute("role")).toBe("presentation");
    expect(mirror.parentElement).toBe(bottomRow.parentElement);
    expect(mirror.className).toMatch(/(?:^|\s)min-h-0(?=\s|$)/);
    expect(mirror.className).toMatch(/(?:^|\s)flex-1(?=\s|$)/);

    // STATED, not inherited. `shrink-0` is what makes the bound below the whole story.
    expect(bottom.className).toMatch(/(?:^|\s)shrink-0(?=\s|$)/);
    // And explicitly NOT the tempting repair: `min-h-0` here clips the composer from the bottom.
    expect(bottom.className).not.toMatch(/(?:^|\s)min-h-0(?=\s|$)/);
  });

  it("caps the agent statusline against the viewport, and scrolls rather than eating a row", () => {
    // `MAX_STATUS_LINES` (8) is a ROW COUNT, and a row count is not a height: eight rows of
    // `CTX:44% CACHE:100% LIMITS…` is a quarter of a keyboard-open phone, held against a mirror
    // already showing zero rows of what the agent actually SAID.
    const { container } = renderChat({ text: STATUS_TEXT });
    // Through the Collapse wrapper the strip now stands in — see the docking test above.
    const strip = container
      .querySelector('[data-slot="chrome-block"]')!
      .previousElementSibling!.querySelector("div.font-mono")!;
    // The cap is relative — a `dvh` fraction, so it follows the device and the keyboard.
    expect(strip.className).toMatch(/max-h-\[\d+dvh\]/);
    // …and scrolled, not clipped: this strip carries the permission mode, and silently eating that
    // row is worse than any height.
    expect(strip.className).toMatch(/(?:^|\s)overflow-y-auto(?=\s|$)/);
  });

  // jsdom has no `visualViewport`, so `useKeyboardOpen` returns early and every other test in this
  // file renders the RESTING geometry — which is what makes this stub necessary and also what makes
  // it safe: it is installed and removed inside the one test that wants it.
  function withSoftKeyboard() {
    const listeners = new Set<() => void>();
    const vv = {
      width: 390,
      height: 844,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    };
    const had = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return {
      open: (height: number) => {
        vv.height = height;
        act(() => listeners.forEach((fn) => fn()));
      },
      restore: () => {
        if (had) Object.defineProperty(window, "visualViewport", had);
        else Reflect.deleteProperty(window, "visualViewport");
      },
    };
  }

  it("stands the switcher and the statusline down while the keyboard is up — and NOT the status band", async () => {
    // THE OPERATOR'S OWN SUGGESTION, verbatim: "when the keyboard is open I have a feeling that we
    // could hide the scroll up row and status row could be hidden?" — taken, and half of it
    // declined, which is why this test names both halves.
    //
    // TAKEN: the 34px grab handle and the 21–112px agent statusline. Both are read BEFORE typing,
    // not during it. Nobody switches panes mid-sentence, and CTX/CACHE/LIMITS is reference data.
    //
    // DECLINED: the status band. It is 14px — the cheapest row on the screen — and it is the only
    // place the pane's state is spelled as a WORD rather than a coloured dot, which is the whole
    // reason it exists (WCAG 1.4.1; status-badge.tsx holds the measurement). It is also read at
    // exactly this moment: it answers "is this agent even waiting for me?" with the thumb over
    // Send. Hiding it would save 14px and remove the one line telling the operator whether the
    // message they are typing is wanted yet. The other two are 4–8x the pixels at none of the cost.
    const kb = withSoftKeyboard();
    try {
      const { container } = renderChat({ text: STATUS_TEXT });
      expect(screen.queryByRole("button", { name: "Switch pane" })).not.toBeNull();

      kb.open(460); // a soft keyboard: -384px, well past the open threshold

      // `Collapse` unmounts at the END of its exit, so both leave the tree — and leaving the tree is
      // the a11y half of the claim: a control that is not on screen must not still be focusable.
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Switch pane" })).toBeNull(),
      );
      expect(screen.queryByText("[Opus 4.8] ~/webapp · main")).toBeNull();

      // THE NAVIGATION ROWS ARE ON A DIFFERENT LIST NOW, and the distinction is the point. They
      // were once declined here outright — "the tab row is how you know where you are, and losing
      // it the moment you start typing costs more than the pixels are worth" — and that reasoning
      // still holds against DELETING them. It does not hold against FOLDING them: they collapse to
      // the 32px bead bar, which keeps "where am I" and "is anything shouting" on screen and puts
      // the rows back in one tap. Pinned in its own describe below, not here; this test is about
      // the two rows that genuinely leave.

      // …and the band is untouched, keyboard or no keyboard.
      expect(container.querySelector('[data-slot="composer-status"]')).not.toBeNull();
      // The dock also stops paying the home-indicator inset twice: the keyboard covers the
      // indicator, so reserving for it as well is ~24px spent on the one screen that has none.
      const dock = container.querySelector('[data-slot="composer-status"]')!.parentElement!;
      expect(dock.className).toMatch(/(?:^|\s)pb-2(?=\s|$)/);
      expect(dock.className).not.toMatch(/safe-area-inset-bottom/);
    } finally {
      kb.restore();
    }
  });

  it("keeps a floor under the folder tab — the gap above the mirror may shrink, never close", () => {
    // THE OPERATOR ASKED FOR A DENSER TAB ROW and chose this gap over shrinking the tab itself,
    // which was the right call: the tab is `h-11` and that 44px IS the tap target, so every pixel
    // off the tab is a pixel off the thumb. This gap costs no target at all.
    //
    // It may not go to zero, and the reason is measured (agent-chat.tsx states it in full): the
    // active tab's fill and the terminal's ground are byte-identical under BOTH themes, on purpose
    // — `--background` IS MIRROR_SPACE's fill in dark and exactly what that fill inverts to in
    // light. With no page between them the open tab has no floor and bleeds into the mirror, and
    // the baseline rule lands flush against the mirror's top rule as one doubled 2px hairline,
    // which DESIGN.md §4 forbids by name. Both halves are pinned here, positively.
    //
    // WHERE THE GAP LIVES MOVED, AND THAT IS WHY THIS TEST NOW LOOKS IN TWO PLACES. It is the page an
    // OPEN FOLDER TAB sits on, so it belongs to the tab row and not to the mirror: parked on the
    // mirror it was unconditional, and folded — no tab, nothing sitting on it — it was 4px of
    // nothing under a 24px bar. It is the strips' own `pb-1` now, inside their Collapse, and the
    // mirror keeps a copy only for the states where those strips are not there to provide one.
    // Either way the claim is the same and the floor is never zero under a folder tab.
    const { container } = renderChat({ text: STATUS_TEXT });
    // Through the bottom region's own `Collapse` row — see the region test above for why that
    // wrapper, not the region's element, is the row this column is made of.
    const mirror = container
      .querySelector('[data-slot="chrome-block"]')!
      .closest('[data-slot="collapse"]')!.previousElementSibling!;
    expect(mirror.className).toMatch(/(?:^|\s)border-t border-rule(?=\s|$)/);
    // No strips on this render (`tabs` is empty), so the mirror is carrying the gap itself — a real
    // one, not `mt-0` and not absent.
    expect(mirror.className).toMatch(/(?:^|\s)mt-[1-9](?:\.5)?(?=\s|$)/);

    // …and with the strips there, the same 4px is theirs: the wrapper the two rows stand in, inside
    // the band, so it arrives and leaves with them instead of popping on a boolean.
    cleanup();
    const withTabs = renderChat({ text: STATUS_TEXT, tabs: fixtureTabs }).container;
    const band = withTabs.querySelector('[data-slot="collapse-swap"]')!;
    expect(band.querySelector("div.pb-1")).not.toBeNull();
    const secondMirror = withTabs
      .querySelector('[data-slot="chrome-block"]')!
      .closest('[data-slot="collapse"]')!.previousElementSibling!;
    expect(secondMirror.className).toMatch(/(?:^|\s)mt-0(?=\s|$)/);
  });

  it("caps the draft field as a fraction of the viewport, not at a constant", () => {
    // `max-h-40` was 160px, chosen against a full-height screen — a THIRD of everything visible
    // with the keyboard up, and the growth that pushed the send button off the bottom. `10rem` IS
    // that 160px, so at rest on any ordinary screen this field is byte-identical to before; only
    // the case that was broken changes.
    renderChat({ text: STATUS_TEXT });
    const field = screen.getByRole("textbox");
    expect(field.className).toMatch(/max-h-\[min\(10rem,\d+dvh\)\]/);
    expect(field.className).not.toMatch(/(?:^|\s)max-h-40(?=\s|$)/);
  });
});

// ZEN MODE — the whole point is that the chrome LEAVES, so these assert the absence of surfaces
// every other test in this file leans on, and that the one floating way out brings them all back.
//
// "The chrome" is read as its ROWS, not as its elements: the shared `<header>` element stays mounted
// (it keeps the safe-area inset and its reserved rule) and its ROW collapses away inside it, and the
// bottom region leaves as one row through its own `Collapse`. Both leave the tree at the end of the
// exit rather than at the start, which is why the disappearance is awaited — a control that is off
// the screen must not still be focusable, and that is the half worth pinning.
describe("AgentChat — zen mode", () => {
  const headerRowOf = (container: HTMLElement) =>
    container.querySelector('header [data-slot="header-row"]');

  async function enterZen(user: User) {
    await openPaneMenu(user);
    await user.click(screen.getByRole("button", { name: "Zen mode" }));
  }

  it("offers no way in while the setting is off, which is the default", async () => {
    // Zen takes away every way back except one floating button, so it may never arrive uninvited.
    const user = userEvent.setup();
    renderChat();

    await openPaneMenu(user);
    expect(screen.queryByRole("button", { name: "Zen mode" })).not.toBeInTheDocument();
    // …and the rows it stands beside are untouched, so this is a hidden row and not a broken sheet.
    expect(screen.getByRole("button", { name: "Find in output" })).toBeInTheDocument();
  });

  it("offers nothing on a pane with no output either — the same gate Find takes", async () => {
    setZenEnabled(true);
    const user = userEvent.setup();
    renderChat({ text: "" });

    await openPaneMenu(user);
    expect(screen.queryByRole("button", { name: "Zen mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Find in output" })).not.toBeInTheDocument();
  });

  it("takes every Collie surface off the screen and leaves the pane's own output", async () => {
    setZenEnabled(true);
    const user = userEvent.setup();
    const { container } = renderChat({ tabs: fixtureTabs, text: STATUS_TEXT });

    await enterZen(user);

    // The header ROW, the tab strip and the whole bottom region (statusline, handle, composer).
    await waitFor(() => expect(headerRowOf(container)).toBeNull());
    expect(screen.queryByRole("navigation", { name: /tabs/i })).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="chrome-block"]')).toBeNull();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch pane" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pane actions" })).not.toBeInTheDocument();

    // The header ELEMENT stays: it carries the safe-area inset that the notch needs whether or not
    // there is a row inside it, and a route taking that inset over would pay for it twice.
    expect(container.querySelector("header")).not.toBeNull();

    // Content stays. Zen hides Collie's chrome, never the pane's output — the mirror keeps polling
    // and keeps rendering exactly as it did.
    expect(screen.getByText("Welcome back!")).toBeInTheDocument();
  });

  it("brings all of it back from the one floating way out", async () => {
    setZenEnabled(true);
    const user = userEvent.setup();
    const { container } = renderChat({ tabs: fixtureTabs });

    await enterZen(user);
    await waitFor(() => expect(headerRowOf(container)).toBeNull());

    await user.click(screen.getByRole("button", { name: "Exit zen mode" }));

    await waitFor(() => expect(headerRowOf(container)).not.toBeNull());
    expect(screen.getByRole("navigation", { name: /tabs/i })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="chrome-block"]')).not.toBeNull();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    // …and the way out goes with it, so nothing floats over a screen that already has its chrome.
    expect(screen.queryByRole("button", { name: "Exit zen mode" })).not.toBeInTheDocument();
  });

  it("gives the one way out a REAL 44px box, not a bled hit area", async () => {
    // DESIGN.md §6. This is the last control in the app that should be under-sized: it is the only
    // thing on the screen that is not terminal output.
    setZenEnabled(true);
    const user = userEvent.setup();
    renderChat();

    await enterZen(user);

    const pill = screen.getByRole("button", { name: "Exit zen mode" });
    expect(pill.className).toMatch(/(?:^|\s)size-11(?=\s|$)/);
    // A ground of its own, and not the page colour: in dark `--background` IS the mirror's fill
    // (mirror-space.ts), so a pill painted in it would be a control standing on nothing.
    expect(pill.className).toMatch(/(?:^|\s)bg-chrome(?=\s|$)/);
  });

  it("hides the chrome THROUGH Collapse, never by tearing it out of the flow", async () => {
    // DESIGN.md §1: an in-flow surface appears and disappears through `ui/collapse.tsx` and through
    // nothing else, which is also §2's answer to 60px of header vanishing between two frames. The
    // coupling is asserted rather than commented: read the surface, walk up to its row, require the
    // row to be a Collapse that is CLOSED. A bare conditional passes every other test in this file.
    setZenEnabled(true);
    const user = userEvent.setup();
    const { container } = renderChat({ tabs: fixtureTabs });

    const headerRow = headerRowOf(container)!;
    const bottom = container.querySelector('[data-slot="chrome-block"]')!.parentElement!;
    const rowOf = (el: Element) => el.closest('[data-slot="collapse"]')!;
    expect(rowOf(headerRow)).not.toBeNull();
    expect(rowOf(bottom)).not.toBeNull();

    await enterZen(user);

    // Read while the exit is still running — `Collapse` holds its child for the full slide, so this
    // is the frame that proves the surface is animating out rather than simply gone.
    expect(rowOf(headerRow).getAttribute("data-state")).toBe("closed");
    expect(rowOf(bottom).getAttribute("data-state")).toBe("closed");
  });

  it("leaves on Escape, the way every other full-screen surface here does", async () => {
    setZenEnabled(true);
    const user = userEvent.setup();
    const { container } = renderChat();

    await enterZen(user);
    await waitFor(() => expect(headerRowOf(container)).toBeNull());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(headerRowOf(container)).not.toBeNull());
  });

  it("drops focus before the composer leaves, so iOS dismisses the keyboard with it", async () => {
    // On iOS the soft keyboard belongs to whatever holds focus, so unmounting a focused <textarea>
    // can leave the keyboard standing over a screen that no longer has an input.
    setZenEnabled(true);
    const user = userEvent.setup();
    renderChat();

    const box = screen.getByPlaceholderText(/type a reply/i);
    await user.click(box);
    expect(box).toHaveFocus();

    await enterZen(user);

    expect(box).not.toHaveFocus();
  });

  it("keeps the entry out of the Display dock — that dock is prefs, this is an act", async () => {
    setZenEnabled(true);
    const user = userEvent.setup();
    renderChat();

    await openPaneMenu(user);
    // Exactly ONE way in, and it is this row — a second entry point creeping back in fails here.
    expect(screen.getAllByRole("button", { name: "Zen mode" })).toHaveLength(1);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Display settings" }));
    expect(screen.getByRole("switch", { name: "Wrap lines" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zen mode" })).not.toBeInTheDocument();
  });

  // "Transient by design" is what justifies never persisting zen, and the mechanism lives entirely
  // in DetailRoute's key={paneId} — nothing inside AgentChat implements it. Pinned here, or removing
  // that key would silently leak a chrome-free view into the next pane with the suite still green.
  it("resets on a pane switch, because the pane view is keyed by paneId", async () => {
    setZenEnabled(true);
    const user = userEvent.setup();
    const first = fixtureAgents[0]!;
    const second = fixtureAgents[1]!;
    let advance: (paneId: string) => void = () => {};

    function Harness() {
      const [paneId, setPaneId] = useState(first.paneId);
      advance = setPaneId;
      const agent = paneId === first.paneId ? first : second;
      // The key is what DetailRoute does; without it this state would survive the switch.
      return (
        <AgentChat
          key={paneId}
          paneId={paneId}
          agent={agent}
          agents={fixtureAgents}
          shellPanes={[]}
          tabs={[]}
          text="recent pane output"
          onBack={vi.fn()}
          onSelect={vi.fn()}
        />
      );
    }
    const router = createMemoryRouter([{ path: "/", element: withHeaderHost(<Harness />) }]);
    const { container } = render(<RouterProvider router={router} />);

    await enterZen(user);
    await waitFor(() => expect(headerRowOf(container)).toBeNull());

    act(() => advance(second.paneId));

    expect(headerRowOf(container)).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Exit zen mode" })).not.toBeInTheDocument();
  });
});

// ── THE FOLDED STRIPS ─────────────────────────────────────────────────────────
// The pane screen is the one screen that stacks two strips, and they are chrome ABOUT the pane
// rather than the pane's own output. Zen already answers "take it all away" and takes the header and
// the composer with it; this is the smaller ask — fold the two rows into a 32px bar of beads that
// still says how many there are, where you are in them, and whether anything is shouting.
//
// Four claims, and each one fails on the edit that would undo it: the rows are shown until asked
// otherwise, the fold is remembered, the bar puts them back, and the soft keyboard overrides the
// preference WITHOUT rewriting it.
describe("AgentChat — folding the tab and pane rows", () => {
  // A second pane in the open pane's own tab, so the pane row renders too (it draws nothing below
  // two) and the bar has both bead groups to show.
  const sibling: AgentView = {
    ...fixtureAgents[0]!,
    paneId: "w1:p9",
    status: "working",
  };
  function renderStrips(overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
    return renderChat({ tabs: fixtureTabs, agents: [...fixtureAgents, sibling], ...overrides });
  }

  it("draws both rows and no bar until the operator folds them", () => {
    // Default OFF, and it is the loud direction: the rows are the pane's only visible way to reach
    // a sibling tab or pane, so a first run that folded them would hide the navigation with them.
    renderStrips();
    expect(screen.queryByRole("navigation", { name: "Tabs" })).not.toBeNull();
    expect(screen.queryByRole("navigation", { name: "Panes" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /^Show tabs/ })).toBeNull();
  });

  it("folds both rows together, and remembers it on this device", async () => {
    const user = userEvent.setup();
    renderStrips();
    // ONE toggle for both rows, pinned to the tab row's trailing end where it costs no height —
    // that row is already 44px. Its name says which rows it is about, because the glyph says none.
    await user.click(screen.getByRole("button", { name: "Hide tabs and panes" }));

    // `Collapse` unmounts at the END of its exit, so both rows leave the tree — which is the a11y
    // half of the claim: a pill that is not on screen must not still be focusable.
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull());
    expect(screen.queryByRole("navigation", { name: "Panes" })).toBeNull();

    // The bar's beads are decorative — colour is their only channel — so the counts are carried in
    // words, and the words are the button's whole accessible name.
    expect(
      screen.queryByRole("button", { name: "Show tabs and panes. 1 tab, 2 panes hidden." }),
    ).not.toBeNull();
    // Device-level and persisted: the same bit lib/strips-collapsed.ts pins from the other side.
    expect(localStorage.getItem("collie:strips-collapsed:v1")).toBe("1");
  });

  it("draws ONE seam between the folded chrome and the mirror, and draws it from below", async () => {
    // THE OPERATOR'S SECOND READING, verbatim: "taking up a bit too much space still and the double
    // border is ugly". The bar carried a `border-b` copied from the tab row, and the mirror's own
    // unconditional `border-t border-rule` sits 4px under it — two hairlines 4px apart, which is the
    // doubled line DESIGN.md §4 forbids, just spaced far enough to look deliberate.
    //
    // The tab row's baseline is not a decoration this bar inherits: it exists because a FOLDER TAB
    // has to own the line it breaks, and folded there is no folder tab. So the bar draws nothing and
    // the mirror keeps the one seam — which is also the half that may not move, being unconditional
    // by design (one geometry, no state in which the seam is drawn differently).
    const user = userEvent.setup();
    const { container } = renderStrips();
    await user.click(screen.getByRole("button", { name: "Hide tabs and panes" }));
    const bar = await screen.findByRole("button", { name: /^Show tabs and panes/ });

    expect(bar.className).not.toMatch(/border-b/);
    expect(bar.className).not.toMatch(/border-rule/);
    // …and the seam it used to double is still there, drawn once, by the mirror.
    const mirror = container
      .querySelector('[data-slot="chrome-block"]')!
      .closest('[data-slot="collapse"]')!.previousElementSibling!;
    expect(mirror.className).toMatch(/(?:^|\s)border-t border-rule(?=\s|$)/);
  });

  it("leaves nothing under the bar when folded — the page goes with the tabs", async () => {
    // THE OPERATOR'S THIRD READING: "some pixels are wasted towards the bottom still". They were.
    // The 4px above the mirror's rule is the page an OPEN FOLDER TAB sits on, and it was parked on
    // the mirror unconditionally — so folded, with no tab and nothing sitting on anything, it was
    // 4px of nothing under a 24px bar and the beads read 4px/8px instead of centred.
    //
    // It belongs to the tab row, so it travels with it: `pb-1` inside the band's own Collapse, which
    // also means it animates with the fold instead of popping on a boolean. Folded, the band is
    // exactly the bar between the header's rule and the mirror's.
    const user = userEvent.setup();
    const { container } = renderStrips();
    await user.click(screen.getByRole("button", { name: "Hide tabs and panes" }));
    await screen.findByRole("button", { name: /^Show tabs and panes/ });

    const mirror = container
      .querySelector('[data-slot="chrome-block"]')!
      .closest('[data-slot="collapse"]')!.previousElementSibling!;
    // Stated, not merely absent: `mt-0` is the claim that the gap was moved, and it is the assertion
    // that fails if someone puts an unconditional margin back on the mirror.
    expect(mirror.className).toMatch(/(?:^|\s)mt-0(?=\s|$)/);
    // …and the page it replaced left with the rows it belonged to.
    await waitFor(() =>
      expect(container.querySelector('[data-slot="collapse-swap"] div.pb-1')).toBeNull(),
    );
  });

  it("spends 24px of drawn height and still answers a 44px thumb", async () => {
    // The bar REPLACES two 47px strips, so every drawn pixel is a pixel the fold did not save — 32px
    // was still heavy. 24px is the floor its contents set: the beads are 16px boxes, so 24 leaves
    // 4px of air and the next step down leaves 2px, which reads as a row jammed under the header.
    //
    // The floor is bought as HIT area, not drawn height (DESIGN.md §6). Both halves are asserted
    // because they are ONE number: 24 + 10 + 10 = 44, so shrinking the bar without re-cutting the
    // inset silently drops the target.
    const user = userEvent.setup();
    renderStrips();
    await user.click(screen.getByRole("button", { name: "Hide tabs and panes" }));
    const bar = await screen.findByRole("button", { name: /^Show tabs and panes/ });
    expect(bar.className).toMatch(/(?:^|\s)h-6(?=\s|$)/);
    expect(bar.className).toMatch(/(?:^|\s)before:-inset-y-2\.5(?=\s|$)/);
  });

  it("puts the rows back on a tap anywhere on the bar", async () => {
    const user = userEvent.setup();
    setStripsCollapsed(true);
    renderStrips();
    // The whole bar is the target, not a chevron you have to find — the fold costs the tabs' NAMES,
    // so getting them back may not also cost aim.
    await user.click(screen.getByRole("button", { name: /^Show tabs and panes/ }));
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Tabs" })).not.toBeNull());
    expect(localStorage.getItem("collie:strips-collapsed:v1")).toBe("0");
  });

  it("names only the rows that are actually there", async () => {
    // A tab holding one pane draws no pane row, so the bar must not offer a pane bead group and the
    // chevron must not promise to hide one. Naming both unconditionally is the easy bug here.
    const user = userEvent.setup();
    renderChat({ tabs: fixtureTabs });
    await user.click(screen.getByRole("button", { name: "Hide tabs" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Show tabs. 1 tab hidden." })).not.toBeNull(),
    );
  });

  // jsdom has no `visualViewport`, so `useKeyboardOpen` returns early and every other case here
  // renders the RESTING geometry — which is what makes this stub necessary and also what makes it
  // safe: it is installed and removed inside the one test that wants it.
  function withSoftKeyboard() {
    const listeners = new Set<() => void>();
    const vv = {
      width: 390,
      height: 844,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    };
    const had = Object.getOwnPropertyDescriptor(window, "visualViewport");
    Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
    return {
      resize: (height: number) => {
        vv.height = height;
        act(() => listeners.forEach((fn) => fn()));
      },
      restore: () => {
        if (had) Object.defineProperty(window, "visualViewport", had);
        else Reflect.deleteProperty(window, "visualViewport");
      },
    };
  }

  /** Put the caret in the message composer's own field, the way tapping it on a phone would. */
  function focusComposer() {
    const field = document.querySelector<HTMLTextAreaElement>('[data-slot="chat-input"]')!;
    act(() => field.focus());
  }

  it("the keyboard folds the rows whatever the preference says, and an expand under it is not written down", async () => {
    // The keyboard takes roughly 45% of the phone, and these rows are read BEFORE typing, never
    // during it — the same test the pane switcher and the statusline are already judged by.
    const kb = withSoftKeyboard();
    try {
      const user = userEvent.setup();
      renderStrips();
      expect(screen.queryByRole("navigation", { name: "Tabs" })).not.toBeNull();

      // The COMPOSER's keyboard, which is the only one that buys this fold — see the case below for
      // the one that must not.
      focusComposer();
      kb.resize(460); // a soft keyboard: -384px, well past the open threshold
      await waitFor(() => expect(screen.queryByRole("navigation", { name: "Tabs" })).toBeNull());
      // The PREFERENCE is untouched — the keyboard is spending the pixels, not choosing for the
      // operator, so nothing is written.
      expect(localStorage.getItem("collie:strips-collapsed:v1")).toBeNull();

      // "I need to see the tabs right now" is not "show me the tabs from now on". The expand holds
      // for this keyboard session and writes nothing.
      await user.click(screen.getByRole("button", { name: /^Show tabs and panes/ }));
      await waitFor(() =>
        expect(screen.queryByRole("navigation", { name: "Tabs" })).not.toBeNull(),
      );
      expect(localStorage.getItem("collie:strips-collapsed:v1")).toBeNull();

      // …and it dies with the keyboard: the persisted preference (shown) rules again, so the rows
      // are back on their own terms rather than on the override's.
      kb.resize(844);
      await waitFor(() =>
        expect(screen.queryByRole("navigation", { name: "Tabs" })).not.toBeNull(),
      );
      expect(localStorage.getItem("collie:strips-collapsed:v1")).toBeNull();
    } finally {
      kb.restore();
    }
  });

  it("does not fold on a keyboard the composer did not ask for — the rename sheet survives its own keyboard", async () => {
    // THE BUG, from the phone: tap a tab → the actions sheet opens → tap Rename → "things flash" and
    // the sheet is gone, with nothing renameable on the device at all.
    //
    // The sheet is TabStrip's, so it renders INSIDE the band that folds. Its rename field
    // autofocuses, the field's own keyboard opens, and a fold gated on "is a keyboard up" fires on
    // it — 240ms later `Collapse` unmounts the strip, the sheet and the half-typed name together.
    // The keyboard may spend the band's pixels only when it is the COMPOSER's keyboard.
    const kb = withSoftKeyboard();
    try {
      const user = userEvent.setup();
      renderStrips();

      // Tapping the tab you are already in opens the actions sheet rather than re-selecting.
      const tabs = screen.getByRole("navigation", { name: "Tabs" });
      await user.click(within(tabs).getByRole("button", { current: true }));
      await user.click(screen.getByRole("button", { name: "Rename" }));
      const field = screen.getByLabelText<HTMLInputElement>("Label");
      expect(field).toBe(document.activeElement); // the sheet autofocuses it

      kb.resize(460); // the RENAME field's keyboard, not the composer's

      // Past the full exit — `Collapse` unmounts at the end of it, so if the band ever started
      // closing the strip, the sheet and this field would be gone by now.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, COLLAPSE_MS + 60));
      });

      expect(screen.queryByRole("navigation", { name: "Tabs" })).not.toBeNull();
      expect(screen.queryByLabelText("Label")).not.toBeNull();
      // And still editable, which is the operator's actual complaint.
      await user.type(field, "x");
      expect(field.value).toContain("x");
    } finally {
      kb.restore();
    }
  });
});

// The pane header's rocket is gone; the switcher sheet is one of its two remaining homes (the other
// is the dashboard's own LaunchStrip, covered by launch-strip.test.tsx). Same launchers.toml rows,
// declared here through GET /api/launchers — a session-scoped route (server.ts), never a field on
// /api/config, so rows come from the host that runs them (PACK_PROTOCOL.md §5).
/** What `api.launch`'s POST body carries — mirrors lib/api.ts's `LaunchRequestBody`. */
interface LaunchPostedBody {
  command?: string;
  paneId?: string;
}

describe("AgentChat: Launch section in the switcher", () => {
  function declareLaunchers() {
    server.use(
      http.get("/api/launchers", () =>
        HttpResponse.json({
          launchers: [{ command: "rumen-peek", label: "Runs & quota", cwd: "/home" }],
          home: "/home",
        }),
      ),
      http.post("/api/launch", () =>
        HttpResponse.json({
          ok: true,
          pane: {
            paneId: "w9:p1",
            workspaceId: "w9",
            workspaceLabel: "Runs & quota",
            tabId: "w9:t1",
            cwd: "/home",
          },
        }),
      ),
    );
  }

  it("shows the Launch section in the switcher when launchers are declared", async () => {
    declareLaunchers();
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    expect(await screen.findByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("Runs & quota")).toBeInTheDocument();
    expect(screen.getByText("rumen-peek")).toBeInTheDocument();
  });

  it("closes the sheet and launches when a row is tapped", async () => {
    declareLaunchers();
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    await screen.findByText("rumen-peek");

    await user.click(screen.getByText("Runs & quota"));
    // Closing is the launch's own signal that it landed: the sheet is gone and the switch handle is
    // reachable again, on a route that is about to change under it.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("launches BESIDE this pane — the request carries this pane's own id", async () => {
    let posted: LaunchPostedBody | undefined;
    const agent = fixtureAgents[0]!;
    server.use(
      http.get("/api/launchers", () =>
        HttpResponse.json({
          launchers: [{ command: "rumen-peek", label: "Runs & quota", cwd: "/home" }],
          home: "/home",
        }),
      ),
      http.post("/api/launch", async ({ request }) => {
        // SAFETY: this test's own client call (`api.launch`) is the only thing that can hit this
        // handler, and it always sends exactly these two fields (lib/api.ts's `LaunchRequestBody`).
        posted = (await request.json()) as LaunchPostedBody;
        return HttpResponse.json({
          ok: true,
          pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "Runs & quota", tabId: "w9:t1", cwd: "/home" },
        });
      }),
    );
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    await user.click(await screen.findByText("Runs & quota"));
    await waitFor(() => expect(posted).toEqual({ command: "rumen-peek", paneId: agent.paneId }));
  });

  it("is not offered on a read-only device", async () => {
    declareLaunchers();
    const user = userEvent.setup();
    renderChat({ device: { enforced: true, device: "spare-phone", authorized: false } });
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    // The sheet itself still opens (it's switch-only otherwise), but nothing in it offers a write
    // this device isn't authorised to make.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Launch")).toBeNull();
    expect(screen.queryByText("rumen-peek")).toBeNull();
  });

  it("does not show the switch handle's launcher affordance when nothing is declared", async () => {
    const user = userEvent.setup();
    renderChat();
    await user.click(screen.getByRole("button", { name: "Switch pane" }));
    expect(screen.queryByText("Launch")).toBeNull();
  });
});
