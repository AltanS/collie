import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render } from "@testing-library/react";

import { type AgentStatus } from "@/lib/types";
import { StatusBadge, StatusDot, StatusWord } from "./status-badge";

const indexCss = readFileSync(join(import.meta.dirname, "..", "index.css"), "utf8");

// Exhaustive BY CONSTRUCTION: a `Record<AgentStatus, …>` object literal is complete-checked by tsc,
// so adding a sixth status to lib/types.ts fails the typecheck here rather than quietly leaving one
// state untested. Same trick the component's own TONE/WORD maps use.
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

  it("draws a different SHAPE for every status, so the state reads without its colour (issue 420)", () => {
    // The silhouette is the contract: five states, five different drawings. What each drawing is
    // made of is read off the SVG itself, not off a class, because a class is exactly what colour
    // blindness cannot see. Two statuses sharing a signature would be the regression.
    const signature = (status: AgentStatus) => {
      const svg = render(<StatusDot status={status} />).container.querySelector("svg");
      expect(svg).not.toBeNull();
      return [...(svg?.children ?? [])]
        .map((el) => `${el.tagName}[${el.getAttribute("d") ?? ""}|${el.getAttribute("fill")}|${el.getAttribute("stroke-dasharray") ?? ""}]`)
        .join(" ");
    };
    const signatures = STATUSES.map(signature);
    expect(new Set(signatures).size).toBe(STATUSES.length);

    // Needs you is a filled triangle, point up: three corners, apex above the base, its own colour
    // as the fill AND as a round-joined stroke that makes it as heavy as the disc beside it.
    const triangle = render(<StatusDot status="blocked" />).container.querySelector("path");
    expect(triangle?.getAttribute("d")).toBe("M6 1.3 L11 10.5 H1 Z");
    expect(triangle?.getAttribute("fill")).toBe("currentColor");
    expect(triangle?.getAttribute("stroke")).toBe("currentColor");
    expect(triangle?.getAttribute("stroke-width")).toBe("1.8");
    expect(triangle?.getAttribute("stroke-linejoin")).toBe("round");

    // Working has its LEFT half filled, inside a ring. Done is a filled disc. Idle is a hollow ring.
    // Unknown is the same ring DASHED, so the two resting states stay apart.
    const working = render(<StatusDot status="working" />).container.querySelector("svg");
    expect(working?.querySelector("circle")?.getAttribute("fill")).toBe("none");
    expect(working?.querySelector("path")?.getAttribute("d")).toBe("M6 1.5 A4.5 4.5 0 0 0 6 10.5 Z");
    expect(render(<StatusDot status="done" />).container.querySelector("circle")?.getAttribute("fill")).toBe(
      "currentColor",
    );
    const idle = render(<StatusDot status="idle" />).container.querySelector("circle");
    expect(idle?.getAttribute("fill")).toBe("none");
    expect(idle?.getAttribute("stroke-dasharray")).toBeNull();
    const unknown = render(<StatusDot status="unknown" />).container.querySelector("circle");
    expect(unknown?.getAttribute("fill")).toBe("none");
    expect(unknown?.getAttribute("stroke-dasharray")).not.toBeNull();
  });

  it("keeps each status in its own --status-* token, and draws every shape in the same 12px box", () => {
    for (const status of STATUSES) {
      const { container } = render(<StatusDot status={status} />);
      const dot = container.firstElementChild;
      expect(dot?.className).toContain(`text-status-${status}`);
      expect(dot?.className).toContain("size-3");
      expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 12 12");
    }
  });

  it("fills a resting ring with the surface it sits on, and no filled shape needs one", () => {
    for (const status of ["idle", "unknown"] as const) {
      const { container } = render(<StatusDot status={status} surface="bg-card" />);
      expect(container.querySelector(".bg-card")).not.toBeNull();
    }
    for (const status of ["blocked", "working", "done"] as const) {
      const { container } = render(<StatusDot status={status} surface="bg-card" />);
      expect(container.querySelector(".bg-card")).toBeNull();
    }
  });

  // The pane header's badge sits on the agent's tile: unbacked, the tile showed through the working
  // mark's empty half and around the triangle (2026-10-14).
  it("backs every shape with its surface when asked, and only the resting rings when not", () => {
    for (const status of STATUSES) {
      const { container } = render(<StatusDot status={status} surface="bg-card" backed />);
      expect(container.querySelector(".bg-card")).not.toBeNull();
    }
  });

  it("turns the working mark and dims when the reading is frozen, and does both again in reverse", () => {
    // A "working" mark turns (rotation only, `.status-turn`) ONLY when the caller opts in with
    // `live` — the pane chip, the spot where the operator is actually watching one pane. While the connection is not live that turn is a lie twice over:
    // the reading is the LAST snapshot's, and an animation is the one thing on a page that says
    // "this is arriving now". So stale removes the turn AND dims, together — dimming one mark of a
    // pair and animating the other would leave a frozen reading looking half live.
    const live = render(<StatusDot status="working" live />);
    expect(live.container.querySelector("svg.status-turn")).not.toBeNull();
    expect(live.container.firstElementChild?.className).not.toContain("opacity-40");

    const frozen = render(<StatusDot status="working" live stale />);
    expect(frozen.container.querySelector(".status-turn")).toBeNull();
    expect(frozen.container.firstElementChild?.className).toContain("opacity-40");
  });

  it("turns nothing but the working mark, even when `live` is passed to the others", () => {
    for (const status of STATUSES.filter((s) => s !== "working")) {
      expect(render(<StatusDot status={status} live />).container.querySelector(".status-turn")).toBeNull();
    }
  });

  it("stays still everywhere `live` isn't passed, e.g. the tab chip", () => {
    // Most call sites (tab-strip.tsx, space-strip.tsx, ui/chip.tsx, agent-card.tsx,
    // space-overview.tsx, strips-summary.tsx) never pass `live`. A pane mounts several of these at
    // once; if each one turned on its own unsynchronized clock the page would blink. Only the ONE
    // mark the operator is watching a pane through animates.
    const notLive = render(<StatusDot status="working" />);
    expect(notLive.container.querySelector(".status-turn")).toBeNull();
    expect(notLive.container.querySelector(".animate-ping")).toBeNull();
    expect(notLive.container.querySelector(".status-breathe")).toBeNull();
  });

  it("defines the turn as a linear 1.8s rotation and nothing else, and stops it under reduced motion", () => {
    // jsdom does not apply index.css, so the rule is read from the source: one keyframe, rotate only
    // (no opacity, no scale), `linear`, 1.8s a turn, and `animation: none` in the reduced-motion
    // query. The opacity breathe it replaced is gone.
    const rule = /\.status-turn\s*\{\s*animation:\s*status-turn\s+1\.8s\s+linear\s+infinite;\s*\}/.exec(indexCss);
    expect(rule).not.toBeNull();
    const frames = /@keyframes status-turn\s*\{([^@]*?\})\s*\}/.exec(indexCss)?.[1] ?? "";
    expect(frames).toContain("transform: rotate(360deg)");
    expect(frames).not.toMatch(/opacity|scale/);
    expect(indexCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.status-turn\s*\{\s*animation:\s*none;\s*\}\s*\}/,
    );
    expect(indexCss).not.toContain("status-breathe");
  });
});

describe("StatusBadge — the chip's mark", () => {
  it("draws the same shape the dot does, beside the word", () => {
    const { container } = render(<StatusBadge status="blocked" />);
    expect(container.querySelector("path")?.getAttribute("d")).toBe("M6 1.3 L11 10.5 H1 Z");
    expect(container.querySelector(".status-turn")).toBeNull();
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

