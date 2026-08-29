import { render } from "@testing-library/react";

import { type AgentStatus, statusLabel } from "@/lib/types";
import { StatusDot, StatusWord, StatusWordSlot } from "./status-badge";

// Exhaustive BY CONSTRUCTION: a `Record<AgentStatus, …>` object literal is complete-checked by tsc,
// so adding a sixth status to lib/types.ts fails the typecheck here rather than quietly leaving one
// state untested. Same trick the component's own DOT/RING/WORD maps use.
const ALL_STATUSES = {
  idle: true,
  working: true,
  blocked: true,
  done: true,
  unknown: true,
} satisfies Record<AgentStatus, true>;
// SAFETY: `ALL_STATUSES` is `satisfies Record<AgentStatus, true>` on the line above, so tsc has
// already proved its keys are exactly the members of AgentStatus — no more (excess property check)
// and no fewer (missing property check). Object.keys types as string[] only because it cannot see
// that proof.
const STATUSES = Object.keys(ALL_STATUSES) as AgentStatus[];

// The two marks the pane header uses to report the agent's state: the dot badged onto the agent's
// own tile, and the word beside the host in the caption. They are deliberately BOTH there — the dot
// is the anchor and welds the state to its subject, the word is the statement for every reader the
// colour fails. These tests pin what each one owes on its own.

describe("StatusDot — the glyph", () => {
  it("names itself when asked, and is hidden from the accessibility tree when not", () => {
    // THE GAP THIS CLOSES. The dot is an empty <span>: it has no text, so before this it named
    // nothing, matched no text query, and reached no screen reader — which was survivable only while
    // a word sat next to it in every call site. The pane header's dot stands alone, so it has to be
    // able to speak.
    //
    // Opt-in rather than on by default, because the OTHER call sites (ui/chip.tsx, pane-strip.tsx,
    // tab-strip.tsx) put the dot in FRONT of the word it belongs to — a name there is the state
    // announced twice. Unnamed it is now explicitly aria-hidden, which is the same answer those call
    // sites already got by accident, stated instead of inferred.
    const named = render(<StatusDot status="blocked" label="needs you" />);
    const dot = named.container.firstElementChild;
    expect(dot?.getAttribute("role")).toBe("img");
    expect(dot?.getAttribute("aria-label")).toBe("needs you");
    expect(dot?.getAttribute("aria-hidden")).toBeNull();

    const bare = render(<StatusDot status="blocked" />);
    const hidden = bare.container.firstElementChild;
    expect(hidden?.getAttribute("aria-hidden")).toBe("true");
    expect(hidden?.getAttribute("role")).toBeNull();
    expect(hidden?.getAttribute("aria-label")).toBeNull();
  });

  it("stops pulsing and dims when the reading is frozen, and does both again in reverse", () => {
    // A "working" dot pulses. While the connection is not live that pulse is a lie twice over: the
    // reading is the LAST snapshot's, and an animation is the one thing on a page that says
    // "this is arriving now". So stale removes the ping AND dims, together — dimming one mark of a
    // pair and animating the other would leave a frozen reading looking half live.
    const live = render(<StatusDot status="working" />);
    expect(live.container.querySelector(".animate-ping")).not.toBeNull();
    expect(live.container.firstElementChild?.className).not.toContain("opacity-40");

    const frozen = render(<StatusDot status="working" stale />);
    expect(frozen.container.querySelector(".animate-ping")).toBeNull();
    expect(frozen.container.firstElementChild?.className).toContain("opacity-40");
  });
});

describe("StatusWord — the caption's plain-language state", () => {
  it("prints a word for every status the app has, and for the shell that has none", () => {
    // Exhaustive over AgentStatus by construction, so a sixth status cannot be added without either
    // teaching this component or failing here. The word is what carries the state for a reader the
    // colour fails: measured on the app's own tokens, a deuteranope reads blocked, working and done
    // as ONE colour in light theme, and idle and unknown are the same dot for everybody.
    for (const status of STATUSES) {
      const { container } = render(<StatusWord status={status} />);
      expect(container.textContent?.trim()).not.toBe("");
      // Coloured by the status token, and by a BARE token — index.css's own note says no token value
      // rescues an alpha modifier, so `/70` on this text would be a contrast failure in both themes.
      expect(container.firstElementChild?.className).toContain(`text-status-${status}`);
      expect(container.firstElementChild?.className).not.toMatch(/text-status-[a-z]+\/\d/);
    }
    // A bare shell has no agent and therefore no agent status; it still owes the caption a word, or
    // a solo install's caption row would be empty.
    const shell = render(<StatusWord status="shell" />);
    expect(shell.container.textContent?.trim()).toBe("shell");
    expect(shell.container.firstElementChild?.className).toContain("text-muted-foreground");
  });

  it("states its own 12px line box as one utility, not as a size plus a separate leading", () => {
    // THE TRAP, pinned. tailwind-merge lists `leading` as conflicting with `font-size`, because a
    // named Tailwind size sets both — so `cn("text-[10px] leading-3", …, "text-[10px]")` deletes the
    // leading and keeps the size, silently. That is not hypothetical: the sibling HostChip caption
    // was written that way first, rendered at a 15px line, and grew the pane header from 60px to
    // 63px on the pane route alone. `text-[10px]/3` is one token and cannot be split, so no later
    // utility in the same cn() can take the line height without also taking the size.
    //
    // The header's whole three-line budget — 12 / 4 / 20 / 4 / 12 = 52px inside a 52px content box —
    // rests on this line being 12.
    const cls = render(<StatusWord status="idle" />).container.firstElementChild?.className ?? "";
    expect(cls).toContain("text-[10px]/3");
    expect(cls).not.toMatch(/(^|\s)leading-/);
    expect(cls).not.toMatch(/(^|\s)text-\[10px\](?=\s|$)/); // never the bare size on its own
  });

  it("dims with the dot when the reading is frozen", () => {
    expect(render(<StatusWord status="working" stale />).container.firstElementChild?.className).toContain(
      "opacity-40",
    );
    expect(
      render(<StatusWord status="working" />).container.firstElementChild?.className,
    ).not.toContain("opacity-40");
  });
});

describe("StatusWordSlot — the word, in a slot every word it can hold fits into", () => {
  const layers = (c: HTMLElement) => [...c.querySelectorAll("[class*='grid-area']")];
  const shown = (c: HTMLElement) => c.querySelector("[data-active]")?.textContent ?? null;

  it("reserves the AGENT set for an agent pane, and shows one of it", () => {
    // The bare word's width is the state's — "needs you" is 54.6px and "done" 27.9px at 390px — so
    // a strip holding the word plus anything else re-lays-out on every status change and the thing
    // beside it slides (DESIGN.md §2). The slot renders all five and shows one, so the box is the
    // widest word IN THE ACTIVE LOCALE and a change of state is paint.
    const { container } = render(<StatusWordSlot status="done" />);
    expect(layers(container).map((l) => l.textContent)).toEqual([
      "needs you",
      "working",
      "done",
      "idle",
      "unknown",
    ]);
    expect(shown(container)).toBe("done");
  });

  it("reserves EVERY agent status — a new state cannot silently un-reserve the slot", () => {
    // THE GUARD. The slot is only as wide as the words it renders, so a status left out of
    // AGENT_WORDS is a word wider than the space reserved for it: the host beside it slides on the
    // day that state first occurs, which is exactly the bug the slot exists to fix, re-armed and
    // invisible until then. `satisfies ReadonlyArray<AgentStatus>` on the array proves its members
    // are statuses; it cannot prove none is MISSING. STATUSES above can — it is the key set of a
    // `Record<AgentStatus, true>`, complete-checked by tsc — so this comparison fails on the day a
    // sixth status joins the union and the reserve does not (an independent oracle, not a restated
    // constant: nothing here reads AGENT_WORDS).
    const { container } = render(<StatusWordSlot status="idle" />);
    const reserved = layers(container).map((l) => l.textContent);
    expect(reserved.toSorted()).toEqual(STATUSES.map((s) => statusLabel(s)).toSorted());
  });

  it("reserves only 'shell' for a shell pane, which can never be anything else", () => {
    // A bare shell has no agent and therefore no agent status. Reserving the agent set here would
    // buy a solo shell ~24px of permanent emptiness for states the pane cannot enter.
    const { container } = render(<StatusWordSlot status="shell" />);
    expect(layers(container)).toHaveLength(1);
    expect(shown(container)).toBe("shell");
  });

  it("shows NO word for a gone pane, and keeps the slot open anyway", () => {
    // A gone pane has nothing left to describe, and the band stands wordless rather than reporting
    // a stale state as current. It keeps its width: a pane dying under you must not slide the
    // machine's name sideways at the moment you are reading it.
    const { container } = render(<StatusWordSlot status={undefined} />);
    expect(layers(container)).toHaveLength(5);
    expect(shown(container)).toBeNull();
  });

  it("gives up no width, and states no pixel number", () => {
    // `shrink-0` is the pair to the host chip's `min-w-0`: the slot is the fixed budget and the
    // machine's name truncates into what is left. The word is the half of the pair a colour-blind
    // reader depends on, so it is never the half that gives up width. And there is no constant to
    // give up — the same slot is "braucht dich" (72.2px) in German and "desconocido" (70.0px) in
    // Spanish, so any hard-coded width clips one locale or wastes another's space.
    const cls = render(<StatusWordSlot status="idle" />).container.firstElementChild?.className ?? "";
    expect(cls).toContain("shrink-0");
    expect(cls).toContain("justify-items-end"); // the visible word hugs the band's right inset
    expect(cls).not.toMatch(/(^|\s)(?:min-)?w-/);
  });

  it("dims the shown word when the reading is frozen, without changing its box", () => {
    const { container } = render(<StatusWordSlot status="working" stale />);
    expect(container.querySelector("[data-active] > span")?.className).toContain("opacity-40");
    // Opacity only — no size, weight or tracking change, which §2 forbids in a state because bold
    // and wider glyphs move everything after them.
    const stale = container.querySelector("[data-active] > span")?.className ?? "";
    const live =
      render(<StatusWordSlot status="working" />).container.querySelector("[data-active] > span")
        ?.className ?? "";
    expect(stale.replace(/\s*opacity-40/, "")).toBe(live);
  });
});
