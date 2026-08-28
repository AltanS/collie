import { render } from "@testing-library/react";

import type { AgentStatus } from "@/lib/types";
import { StatusDot, StatusWord } from "./status-badge";

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
